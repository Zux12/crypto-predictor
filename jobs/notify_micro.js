// jobs/notify_micro.js — Micro (0.5–2h) notifier with optional 5-minute double pass
import "dotenv/config";
import mongoose from "mongoose";

// ===== Crash guards =====
process.on("unhandledRejection", e => { console.error("[UNHANDLED]", e); process.exit(1); });
process.on("uncaughtException",  e => { console.error("[UNCAUGHT]",  e); process.exit(1); });

// ===== Models used =====
import Inference from "../models/Inference.js";
import Price from "../models/Price.js";

// Inline MicroState (no separate file required)
const MicroState = mongoose.models.MicroState || mongoose.model("MicroState", new mongoose.Schema({
  coin: { type: String, unique: true },
  state: { type: String, enum: ["none","watch","standby","buy"], default: "none" },
  state_since: { type: Date, default: Date.now },
  last_buy_at: { type: Date },
  last_standby_at: { type: Date },
  last_heartbeat_at: { type: Date },
  last_reason: { type: String }
}, { collection: "micro_states", timestamps: true }));

// ===== ENV / PRESET =====
const MONGO_URI = process.env.MONGO_URI;
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// Coins & cadence
const COINS = (process.env.MICRO_COINS ?? "bitcoin,ethereum").split(",").map(s=>s.trim());
const DOUBLE_PASS = String(process.env.MICRO_DOUBLE_PASS ?? "on").toLowerCase() === "on"; // run twice in 10m job

// Micro thresholds (your v1 preset)
const P    = Number(process.env.MICRO_P    ?? 0.55);   // p_up ≥
const NB   = Number(process.env.MICRO_N    ?? 50);     // n ≥
const BKT  = Number(process.env.MICRO_B    ?? -0.001); // bucket ≥ (allow slight negative)
const WMIN = Number(process.env.MICRO_W    ?? 30);     // ± minutes around pred_ts
const RSI0 = Number(process.env.MICRO_RSI  ?? 35);     // RSI threshold for dip
const BBK  = Number(process.env.MICRO_BBK  ?? 1.5);    // Bollinger sigma
const TP   = Number(process.env.MICRO_TP   ?? 0.003);  // +0.30%
const SL   = Number(process.env.MICRO_SL   ?? 0.002);  // -0.20%
const HOLDH= Number(process.env.MICRO_HOLD ?? 2);      // max hold (hours)

// Standby tuning (v4 must be ON + >=2 cues)
const ST_PUSH       = String(process.env.ST_PUSH ?? "on").toLowerCase()==="on"; // send 🟡 by default ON
const ST_RSI_MARGIN = Number(process.env.ST_RSI_MARGIN ?? 4);   // RSI ≤ RSI0+4
const ST_RSI_SLOPE  = Number(process.env.ST_RSI_SLOPE  ?? 0.8); // ΔRSI (bar-to-bar)
const ST_BAND_EPS   = Number(process.env.ST_BAND_EPS   ?? 0.15);// ~0.15% to band
const ST_LOOKBACK_M = Number(process.env.ST_LOOKBACK_M ?? 10);  // minutes
const ST_COOLDOWN_M = Number(process.env.ST_COOLDOWN_M ?? 20);  // cooldown minutes

// Hourly Micro heartbeat
const MICRO_HB = String(process.env.MICRO_HEARTBEATS ?? "hourly").toLowerCase(); // "off"|"hourly"

// ===== TG helper =====
async function tgSend(text) {
  const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;

  // Multi-recipient support (comma-separated IDs)
  const ids =
    (process.env.TELEGRAM_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

  if (ids.length === 0) {
    console.error("[TG ERROR] No TELEGRAM_CHAT_IDS / TELEGRAM_CHAT_ID configured");
    return;
  }

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const bodyBase = { text, disable_web_page_preview: true };

  for (const chatId of ids) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, ...bodyBase })
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) {
        console.error("[TG ERROR]", chatId, res.status, JSON.stringify(json));
      } else {
        console.log("[TG OK]", chatId, "message_id", json.result?.message_id);
      }
    } catch (e) {
      console.error("[TG SEND] failed for", chatId, e?.message || e);
    }
  }
}


// ===== Indicator math =====
const HOUR = 3600_000, MIN = 60_000;

function myt(d){ const z = new Date(d.getTime()+8*HOUR); return z.toISOString().slice(0,16).replace("T"," "); }

function indicators(series){
  const n=series.length, rsi=new Array(n).fill(NaN), bbLo=new Array(n).fill(NaN);
  if (!n) return { rsi, bbLo };
  // RSI(14) Wilder
  const delta = series.map((v,i)=> i? v-series[i-1] : 0);
  let ru=0, rd=0, a=1/14;
  for (let i=0;i<n;i++){
    const up=Math.max(delta[i],0), dn=Math.max(-delta[i],0);
    ru = i? (a*up + (1-a)*ru) : up;
    rd = i? (a*dn + (1-a)*rd) : dn;
    const rs = rd===0 ? 100 : ru/rd;
    rsi[i] = 100 - (100/(1+rs));
  }
  // Bollinger(20, BBK)
  const w=20; let sum=0,sumsq=0;
  for (let i=0;i<n;i++){
    sum+=series[i]; sumsq+=series[i]*series[i];
    if (i>=w){ sum-=series[i-w]; sumsq-=series[i-w]*series[i-w]; }
    if (i>=w-1){
      const m=sum/w, sd=Math.sqrt(Math.max(0,(sumsq/w)-m*m));
      bbLo[i] = m - BBK*sd;
    }
  }
  return { rsi, bbLo };
}

function idxAtOrBefore(ts,t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){ const m=(lo+hi)>>1; if(ts[m]<=t){a=m;lo=m+1}else hi=m-1 } return a; }

function evalDipAndStandby(ts, prices, rsi, bbLo, t0ms){
  const i0 = idxAtOrBefore(ts, t0ms);
  if (i0<0) return { dip:false, standby:false, notes:[] };

  const center = ts[i0], W = WMIN*MIN, recentStart = center - ST_LOOKBACK_M*MIN;
  let sawFlip=false, nearRSI=false, nearBand=false, softBounce=false;

  const scan = (j) => {
    const r=rsi[j], p=prices[j], lo=bbLo[j];
    const rPrev = rsi[j-1] ?? r;
    // dip: flip (RSI rising from oversold or at/below band)
    if ((r > rPrev) && (rPrev < RSI0 || (Number.isFinite(lo) && p <= lo))) sawFlip = true;
    // cues for standby
    if (ts[j] >= recentStart){
      if (Number.isFinite(r) && (r <= RSI0 + ST_RSI_MARGIN) && (r - rPrev >= ST_RSI_SLOPE)) nearRSI = true;
      if (Number.isFinite(lo) && (p <= lo || ((p - lo) / Math.max(p,1) <= ST_BAND_EPS/100))) nearBand = true;
      if ((r - rPrev) >= (ST_RSI_SLOPE/2) && Number.isFinite(lo) && p > lo) softBounce = true;
    }
  };

  for (let j=i0; j>=0 && Math.abs(ts[j]-center)<=W; j--) scan(j);
  for (let j=i0+1; j<ts.length && Math.abs(ts[j]-center)<=W; j++) scan(j);

  const standby = (nearRSI?1:0) + (nearBand?1:0) + (softBounce?1:0) >= 2;
  return { dip: sawFlip, standby, notes: [
    nearRSI?"RSI↑":"", nearBand?"near band":"", softBounce?"rejection":""
  ].filter(Boolean) };
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
  if (standby && !dip)        micro = `🟡 Standby (near flip) — ~${Math.max(0, winLeftMin)}m left`;
  if (dip && v4)              micro = "⚡ BUY active";
  return `${coin.toUpperCase()} • v4: p_up ${pu}% • n=${n} • 7d ${b}\n• Micro: ${micro}`;
}

// ===== Core pass (one evaluation cycle) =====
async function runOnce() {
  const now = new Date();

  for (const coin of COINS){
    const inf = await Inference.findOne({ coin }).sort({ ts: -1 }).lean();
    if (!inf) continue;

    // v4 gate
    const v4 = (Number(inf.p_up) >= P) && (Number(inf.n) >= NB) &&
               (Number.isFinite(Number(inf.bucket7d)) ? (Number(inf.bucket7d) >= BKT) : (BKT <= 0));

    // indicators context around pred_ts
    const t0 = new Date(inf.pred_ts ?? inf.ts);
    const px = await Price.find({
      coin, ts: { $gte: new Date(t0.getTime()-90*MIN), $lte: new Date(t0.getTime()+90*MIN) }
    }).sort({ ts: 1 }).lean();

    const ts = px.map(r=> +new Date(r.ts)), prices = px.map(r=> Number(r.price));
    const { rsi, bbLo } = indicators(prices);
    const { dip, standby } = evalDipAndStandby(ts, prices, rsi, bbLo, +t0);

    const entryUntil = myt(new Date(t0.getTime() + WMIN*MIN));
    const exitBy     = myt(new Date(t0.getTime() + HOLDH*HOUR));
    const minLeft    = Math.round((t0.getTime()+WMIN*MIN - now.getTime())/MIN);

    const combined = v4 && dip;
    const newState = combined ? "buy" : (v4 && standby) ? "standby" : (v4 ? "watch" : "none");
    const stDoc = await MicroState.findOne({ coin });
    const prev  = stDoc?.state ?? "none";

    // Transitions
    if (prev !== "buy" && newState === "buy"){
      await tgSend(fmtBuy(coin, entryUntil, exitBy, inf.p_up, inf.n, inf.bucket7d));
      await MicroState.updateOne(
        { coin }, { $set: { state:"buy", state_since: now, last_buy_at: now, last_reason: `v4:${v4} dip:${dip} standby:${standby}` } }, { upsert:true }
      );
    } else if (prev === "buy" && newState !== "buy"){
      await tgSend(fmtCancel(coin));
      await MicroState.updateOne(
        { coin }, { $set: { state:newState, state_since: now, last_reason: `v4:${v4} dip:${dip} standby:${standby}` } }
      );
    } else {
      await MicroState.updateOne(
        { coin }, { $set: { state:newState, last_reason: `v4:${v4} dip:${dip} standby:${standby}` } }, { upsert:true }
      );

      // Optional Standby push (ON by default), with cooldown & debounce
      if (ST_PUSH && newState==="standby"){
        const coolOk = !stDoc?.last_standby_at || (now.getTime()-stDoc.last_standby_at.getTime() >= ST_COOLDOWN_M*MIN);
        const wasStandby = stDoc?.state === "standby";
        if (coolOk && !wasStandby){
          await tgSend(`🟡 Standby (Micro) — ${coin.toUpperCase()}\nv4 OK; near flip — ~${Math.max(0,minLeft)}m left`);
          await MicroState.updateOne({ coin }, { $set: { last_standby_at: now } });
        }
      }
    }

    // Hourly Micro heartbeat
    if (MICRO_HB === "hourly"){
      const mytNow = new Date(now.getTime()+8*HOUR);
      const hbDue = mytNow.getMinutes()===0 && mytNow.getSeconds()<30;
      const lastHB = stDoc?.last_heartbeat_at ? new Date(stDoc.last_heartbeat_at) : null;
      const lastHbHour = lastHB ? new Date(lastHB.getTime()+8*HOUR).getHours() : -1;
      if (hbDue && mytNow.getHours() !== lastHbHour){
        const line = fmtHeartbeatLine(coin, v4, (newState==="standby"), combined, minLeft, inf.p_up, inf.n, inf.bucket7d);
        await tgSend(`⏱️ Heartbeat ${myt(now)} MYT\n\n${line}`);
        await MicroState.updateOne({ coin }, { $set: { last_heartbeat_at: now } }, { upsert: true });
      }
    }
  }
}

// ===== Main runner =====
(async () => {
  if (!MONGO_URI || !TOKEN || !CHAT_ID) {
    console.error("[BOOT] Missing env MONGO_URI / TELEGRAM_*"); process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("[MONGO] connected (micro)");

  // First pass
  await runOnce();

  // Optional 5-minute second pass (for Heroku Scheduler 10-min cadence)
  if (DOUBLE_PASS) {
    console.log("[MICRO] sleeping 5 minutes for double pass …");
    await new Promise(r => setTimeout(r, 5*MIN));
    await runOnce();
  }

  await mongoose.disconnect();
  console.log("[MICRO DONE]");
  process.exit(0);
})().catch(async e => {
  console.error("[MICRO FATAL]", e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
