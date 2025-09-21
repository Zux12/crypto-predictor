// /jobs/notify_micro.js  (ESM)
import "dotenv/config";
import mongoose from "mongoose";
import Inference from "../models/Inference.js";
import Price from "../models/Price.js";
import MicroState from "../models/MicroState.js";

// ---------- ENV / PRESET ----------
const MONGO_URI = process.env.MONGO_URI;
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Coins to monitor
const COINS = (process.env.MICRO_COINS ?? "bitcoin,ethereum").split(",").map(s=>s.trim());

// Micro preset (the one that cleared ≥70% for you)
const P   = Number(process.env.MICRO_P   ?? 0.55);     // p_up ≥
const NB  = Number(process.env.MICRO_N   ?? 50);       // n ≥
const BKT = Number(process.env.MICRO_B   ?? -0.001);   // bucket ≥ (allow slight negative)
const WMIN= Number(process.env.MICRO_W   ?? 30);       // ± minutes window around pred_ts
const RSI0= Number(process.env.MICRO_RSI ?? 35);       // RSI threshold for dip
const BBK = Number(process.env.MICRO_BBK ?? 1.5);      // Bollinger sigma
const TP  = Number(process.env.MICRO_TP  ?? 0.003);    // +0.30%
const SL  = Number(process.env.MICRO_SL  ?? 0.002);    // -0.20%
const HOLDH=Number(process.env.MICRO_HOLD?? 2);        // max 2h

// Standby tuning (v4 must be ON + >=2 cues)
const ST_RSI_MARGIN = Number(process.env.ST_RSI_MARGIN ?? 4);    // RSI ≤ RSI0+4
const ST_RSI_SLOPE  = Number(process.env.ST_RSI_SLOPE  ?? 0.8);  // ΔRSI over ~3 bars
const ST_BAND_EPS   = Number(process.env.ST_BAND_EPS   ?? 0.15); // within 0.15σ of lower band
const ST_LOOKBACK_M = Number(process.env.ST_LOOKBACK_M ?? 10);   // recent mins for cues
const ST_PUSH       = String(process.env.ST_PUSH ?? "off").toLowerCase()==="on"; // default OFF
const ST_COOLDOWN_M = Number(process.env.ST_COOLDOWN_M ?? 20);   // minimum minutes between Standby pushes

// Heartbeat (low frequency)
const HB_ON   = String(process.env.MICRO_HEARTBEATS ?? "hourly").toLowerCase(); // "off" | "hourly"
const HOUR = 3600_000, MIN = 60_000;

// ---------- Utils ----------
function myt(d){ const z = new Date(d.getTime()+8*HOUR); return z.toISOString().slice(0,16).replace("T"," "); }

async function tgSend(text){
  const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetchFn(url, {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview:true })
  });
  const js = await res.json().catch(()=>({}));
  if (!js.ok) throw new Error(js.description || `TG ${res.status}`);
}

// RSI(14) Wilder + Bollinger(20, BBK)
function indicators(series){
  const n=series.length, rsi=new Array(n).fill(NaN), bbLo=new Array(n).fill(NaN);
  if (!n) return { rsi, bbLo };
  // RSI
  const delta=series.map((v,i)=> i? v-series[i-1] : 0);
  let ru=0, rd=0, a=1/14;
  for (let i=0;i<n;i++){
    const up=Math.max(delta[i],0), dn=Math.max(-delta[i],0);
    ru = i? (a*up + (1-a)*ru) : up;
    rd = i? (a*dn + (1-a)*rd) : dn;
    const rs = rd===0 ? 100 : ru/rd;
    rsi[i] = 100 - (100/(1+rs));
  }
  // Bollinger
  const w=20; let sum=0,sumsq=0;
  for (let i=0;i<n;i++){
    sum+=series[i]; sumsq+=series[i]*series[i];
    if (i>=w){ sum-=series[i-w]; sumsq-=series[i-w]*series[i-w]; }
    if (i>=w-1){
      const m=sum/w, sd=Math.sqrt(Math.max(0,(sumsq/w)-m*m));
      bbLo[i]=m - BBK*sd;
    }
  }
  return { rsi, bbLo };
}

function idxAtOrBefore(ts,t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]<=t){a=m;lo=m+1}else hi=m-1} return a; }

// Evaluate dip (flip) and standby
function evalDipAndStandby(ts, prices, rsi, bbLo, t0ms){
  const i0 = idxAtOrBefore(ts, t0ms); if (i0<0) return { dip:false, standby:false, score:0, notes:[] };
  const center = ts[i0];
  const W = WMIN*MIN;
  let dip=false, notes=[], score=0;

  // scan window ±W
  let sawRSI=false, sawBand=false, sawFlip=false;
  // helpers for standby
  let nearBand=false, rsiRise=false, reject=false;

  // consider last ~10m for proximity cues
  const recentStart = center - ST_LOOKBACK_M*MIN;

  for (let j=i0; j>=0 && Math.abs(ts[j]-center)<=W; j--){
    const r = rsi[j], p=prices[j], lo=bbLo[j], rPrev=rsi[j-1] ?? r;
    sawRSI  ||= r < RSI0;
    sawBand ||= p <= lo;
    sawFlip ||= (r > rPrev) && (rPrev < RSI0 || p <= lo);

    if (ts[j] >= recentStart){
      // cue1: RSI near threshold & rising
      if (r <= RSI0 + ST_RSI_MARGIN && (r - rPrev) >= ST_RSI_SLOPE) rsiRise = true;
      // cue2: close to lower band
      const w = (p - lo);
      // approximate sigma distance: if lo is NaN, skip; else compare to 0.15σ by normalizing with (mid-lo)
      // Since we don't compute mid, we approximate near-band via absolute diff smallness relative to price
      if (Number.isFinite(lo) && (p <= lo || (w/Math.max(p,1)) <= (ST_BAND_EPS/100))) nearBand = true;
      // cue3: small rejection (close above open by >=0.15%) — we don't have OHLC; simulate via momentum: r rising and p > lo
      if ((r - rPrev) >= ST_RSI_SLOPE/2 && p > lo) reject = true;
    }
  }
  for (let j=i0+1; j<ts.length && Math.abs(ts[j]-center)<=W; j++){
    const r = rsi[j], p=prices[j], lo=bbLo[j], rPrev=rsi[j-1] ?? r;
    sawRSI  ||= r < RSI0;
    sawBand ||= p <= lo;
    sawFlip ||= (r > rPrev) && (rPrev < RSI0 || p <= lo);

    if (ts[j] >= recentStart){
      if (r <= RSI0 + ST_RSI_MARGIN && (r - rPrev) >= ST_RSI_SLOPE) rsiRise = true;
      if (Number.isFinite(lo) && (p <= lo || ((p-lo)/Math.max(p,1)) <= (ST_BAND_EPS/100))) nearBand = true;
      if ((r - rPrev) >= ST_RSI_SLOPE/2 && p > lo) reject = true;
    }
  }

  dip = sawFlip; // flip-dip definition
  if (rsiRise)  { score++; notes.push("RSI rising"); }
  if (nearBand) { score++; notes.push("near band"); }
  if (reject)   { score++; notes.push("rejection"); }

  const standby = (score >= 2);
  return { dip, standby, score, notes };
}

function fmtBuy(coin, entryEnd, exitBy, p_up, n, bucket){
  const pu = (p_up*100).toFixed(1);
  const b  = Number.isFinite(bucket) ? `${bucket>=0?"+":""}${(bucket*100).toFixed(2)}%` : "—";
  return `⚡ BUY (Micro) — ${coin.toUpperCase()}\nTP +${(TP*100).toFixed(2)}% • SL −${(SL*100).toFixed(2)}% • max ${HOLDH}h\nEntry until ${entryEnd} MYT • Exit by ${exitBy} MYT\nv4 p_up ${pu}% • n=${n} • 7d ${b}`;
}

function fmtCancel(coin){ return `⛔ Cancel (Micro) — ${coin.toUpperCase()}\nWindow expired or v4/dip off`; }

function fmtHeartbeatLine(coin, v4, standby, dip, winLeftMin, p_up, n, bucket){
  const pu = (p_up*100).toFixed(1);
  const b  = Number.isFinite(bucket) ? `${bucket>=0?"+":""}${(bucket*100).toFixed(2)}%` : "—";
  let micro = "—";
  if (v4 && !dip && !standby) micro = "👀 Watch (v4 OK)";
  if (standby && !dip) micro = `🟡 Standby (near flip) — ~${Math.max(0, winLeftMin)}m left`;
  if (dip && v4) micro = "⚡ BUY active";
  return `${coin.toUpperCase()} • v4: p_up ${pu}% • n=${n} • 7d ${b}\n• Micro: ${micro}`;
}

(async () => {
  if (!MONGO_URI || !TOKEN || !CHAT_ID) {
    console.error("[BOOT] Missing env MONGO_URI / TELEGRAM_*"); process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const now = new Date();

  for (const coin of COINS){
    // latest inference (same signal as UI/Telegram snapshots)
    const inf = await Inference.findOne({ coin }).sort({ ts: -1 }).lean();
    if (!inf) continue;
    const v4 = (Number(inf.p_up) >= P) && (Number(inf.n) >= NB)
             && (Number.isFinite(Number(inf.bucket7d)) ? (Number(inf.bucket7d) >= BKT) : (BKT <= 0));

    // fetch recent prices around pred_ts for indicators
    const t0 = new Date(inf.pred_ts ?? inf.ts);
    const px = await Price.find({
      coin, ts: { $gte: new Date(t0.getTime()-90*MIN), $lte: new Date(t0.getTime()+90*MIN) }
    }).sort({ ts: 1 }).lean();

    const ts = px.map(r=> +new Date(r.ts)), prices = px.map(r=> Number(r.price));
    const { rsi, bbLo } = indicators(prices);
    const { dip, standby, score } = evalDipAndStandby(ts, prices, rsi, bbLo, +t0);

    // entry/exit windows (MYT display only)
    const entryUntil = myt(new Date(t0.getTime() + WMIN*MIN));
    const exitBy     = myt(new Date(t0.getTime() + HOLDH*HOUR));
    const minLeft    = Math.round((t0.getTime()+WMIN*MIN - now.getTime())/MIN);

    // decide state
    const newState = (v4 && dip) ? "buy" : (v4 && standby) ? "standby" : (v4 ? "watch" : "none");
    const stDoc = await MicroState.findOne({ coin });
    const prev  = stDoc?.state ?? "none";

    // transitions
    if (prev !== "buy" && newState === "buy"){
      await tgSend(fmtBuy(coin, entryUntil, exitBy, inf.p_up, inf.n, inf.bucket7d));
      await MicroState.updateOne(
        { coin },
        { $set: { state:"buy", state_since: now, last_buy_at: now, last_reason: `v4:${v4} dip:${dip} standby:${standby} score:${score}` } },
        { upsert: true }
      );
    } else if (prev === "buy" && newState !== "buy"){
      await tgSend(fmtCancel(coin));
      await MicroState.updateOne(
        { coin },
        { $set: { state:newState, state_since: now, last_reason: `v4:${v4} dip:${dip} standby:${standby} score:${score}` } }
      );
    } else {
      // update state (no alert)
      await MicroState.updateOne(
        { coin },
        { $set: { state:newState, last_reason: `v4:${v4} dip:${dip} standby:${standby} score:${score}` } },
        { upsert: true }
      );

      // optional Standby push (default OFF) with cooldown + debounce
      if (ST_PUSH && newState==="standby"){
        const coolOk = !stDoc?.last_standby_at || (now.getTime()-stDoc.last_standby_at.getTime() >= ST_COOLDOWN_M*MIN);
        const wasStandby = stDoc?.state === "standby";
        if (coolOk && !wasStandby){
          const txt = `🟡 Standby (Micro) — ${coin.toUpperCase()}\n` +
                      `v4 OK; near flip — window ~${Math.max(0,minLeft)}m left`;
          await tgSend(txt);
          await MicroState.updateOne({ coin }, { $set: { last_standby_at: now } });
        }
      }
    }

    // heartbeat (hourly at :00 MYT)
    if (HB_ON === "hourly"){
      const mytNow = new Date(now.getTime()+8*HOUR);
      const hbDue = mytNow.getMinutes()===0 && mytNow.getSeconds()<30;
      const lastHB = stDoc?.last_heartbeat_at ? new Date(stDoc.last_heartbeat_at) : null;
      const lastHbHour = lastHB ? new Date(lastHB.getTime()+8*HOUR).getHours() : -1;
      if (hbDue && mytNow.getHours() !== lastHbHour){
        const line = fmtHeartbeatLine(coin, v4, (newState==="standby"), (v4&&dip), minLeft, inf.p_up, inf.n, inf.bucket7d);
        await tgSend(`⏱️ Heartbeat ${myt(now)} MYT\n\n${line}`);
        await MicroState.updateOne({ coin }, { $set: { last_heartbeat_at: now } }, { upsert: true });
      }
    }
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async e => {
  console.error("[FATAL]", e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
