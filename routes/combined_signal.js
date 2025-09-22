// routes/combined_signal.js — per-coin Micro signal (v4 gate + dip "flip") with standby and fallback
import express from "express";
import mongoose from "mongoose";
import Price from "../models/Price.js";
import Inference from "../models/Inference.js";

const router = express.Router();

const HOUR = 3600_000, MIN = 60_000;
const toMs = (d) => +new Date(d);

function idxAtOrBefore(ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]<=t){a=m;lo=m+1}else hi=m-1} return a; }
function idxAtOrAfter (ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]>=t){a=m;hi=m-1}else lo=m+1} return a; }
function nearestInWindow(ts, target, tolMs){
  let lo = target - tolMs, hi = target + tolMs;
  let i = ts.findIndex(t=> t>=lo); if (i<0) return -1;
  let best=-1, bestAbs=Infinity;
  for (; i<ts.length && ts[i]<=hi; i++){ const a=Math.abs(ts[i]-target); if (a<bestAbs){best=i;bestAbs=a;} }
  return best;
}

// RSI(14) Wilder + Bollinger(20, kσ)
function computeIndicators(prices, k){
  const n=prices.length, rsi=new Array(n).fill(NaN), bbLo=new Array(n).fill(NaN);
  if (!n) return { rsi, bbLo };
  const delta=prices.map((v,i)=> i? v-prices[i-1] : 0);
  let ru=0, rd=0, a=1/14;
  for (let i=0;i<n;i++){
    const up=Math.max(delta[i],0), dn=Math.max(-delta[i],0);
    ru = i? (a*up + (1-a)*ru) : up;
    rd = i? (a*dn + (1-a)*rd) : dn;
    const rs = rd===0 ? 100 : ru/rd;
    rsi[i] = 100 - (100/(1+rs));
  }
  const w=20; let sum=0,sumsq=0;
  for (let i=0;i<n;i++){
    sum+=prices[i]; sumsq+=prices[i]*prices[i];
    if (i>=w){ sum-=prices[i-w]; sumsq-=prices[i-w]*prices[i-w]; }
    if (i>=w-1){
      const m=sum/w, sd=Math.sqrt(Math.max(0,(sumsq/w)-m*m));
      bbLo[i]=m - k*sd;
    }
  }
  return { rsi, bbLo };
}

router.get("/signal", async (req, res) => {
  try {
    // Query params (with defaults aligned to your preset)
    const coins = (req.query.coins ?? "bitcoin,ethereum").split(",").map(s=>s.trim());
    const thP   = Number(req.query.p   ?? 0.55);
    const thN   = Number(req.query.n   ?? 50);
    const thB   = Number(req.query.b   ?? -0.001);
    const wMin  = Number(req.query.w   ?? 30);
    const rsiTh = Number(req.query.rsi ?? 35);
    const mode  = String(req.query.mode ?? "flip").toLowerCase(); // flip|and|or (we use flip below)
    const bbk   = Number(req.query.bbk ?? 1.5);
    const tp    = Number(req.query.tp  ?? 0.003);
    const sl    = Number(req.query.sl  ?? 0.002);
    const holdH = Number(req.query.hold ?? 2);

    // Latest inference per coin
    let infs = await Inference.aggregate([
      { $match: { coin: { $in: coins } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$coin", doc: { $first: "$$ROOT" } } }
    ]);

    // Fallback to Prediction if missing/stale (>90m)
    const STALE_MS = 90 * 60 * 1000;
    const nowMs = Date.now();
    const map = new Map((infs || []).map(x => [x._id, x]));

    for (const coin of coins) {
      const had = map.get(coin);
      const isStale = !had || (nowMs - +new Date(had.doc?.pred_ts ?? had.doc?.ts ?? 0)) > STALE_MS;

      if (!had || isStale) {
        const pred = await mongoose.connection.collection("predictions")
          .find({ coin, model_ver: req.query.model || "v4-ai-logreg-xau" })
          .sort({ ts: -1 }).limit(1).toArray();
        if (pred[0]) {
          map.set(coin, {
            _id: coin,
            doc: {
              coin,
              pred_ts: pred[0].ts,
              p_up: Number(pred[0].p_up ?? pred[0].prob_up ?? 0),
              n: Number(pred[0].n ?? 0),
              bucket7d: null,
              reason: null
            }
          });
        }
      }
    }
    const infRows = Array.from(map.values());
    if (!infRows.length) return res.json({ params:{coins,thP,thN,thB,wMin,rsiTh,mode,bbk,tp,sl,holdH}, signals: [] });

    // Price window covering all coins’ pred_ts
    const minT = new Date(Math.min(...infRows.map(x => +new Date(x.doc.pred_ts ?? x.doc.ts))));
    const maxT = new Date(Math.max(...infRows.map(x => +new Date(x.doc.pred_ts ?? x.doc.ts))));
    const raw = await Price.find({
      coin: { $in: coins },
      ts: { $gte: new Date(minT.getTime() - 12*HOUR), $lte: new Date(maxT.getTime() + 36*HOUR) }
    }).sort({ coin:1, ts:1 }).lean();

    // Group prices & indicators
    const G = {};
    for (const r of raw) { (G[r.coin] ||= { ts:[], price:[] }).ts.push(+new Date(r.ts)); G[r.coin].price.push(Number(r.price)); }
    const IND = {};
    for (const [c, d] of Object.entries(G)) IND[c] = { ...d, ...computeIndicators(d.price, bbk) };

    // Evaluate per coin
    const out = [];
    for (const { _id: coin, doc:d } of infRows) {
      const ind = IND[coin];
      if (!ind) { out.push({ coin, available:false }); continue; }

      const t0 = +new Date(d.pred_ts ?? d.ts);
      const i0 = idxAtOrBefore(ind.ts, t0);
      if (i0 < 0) { out.push({ coin, available:false }); continue; }

      // DIP: flip (RSI rising from oversold or at/below band) within window ±wMin
      const center = ind.ts[i0], W = wMin*MIN;
      let sawFlip=false;
      const scan = (j) => {
        const r=ind.rsi[j], p=ind.price[j], lo=ind.bbLo[j], rPrev = ind.rsi[j-1] ?? r;
        if ((r > rPrev) && (rPrev < rsiTh || (Number.isFinite(lo) && p <= lo))) sawFlip = true;
      };
      for (let j=i0; j>=0 && Math.abs(ind.ts[j]-center)<=W; j--) scan(j);
      for (let j=i0+1; j<ind.ts.length && Math.abs(ind.ts[j]-center)<=W; j++) scan(j);
      const dip = sawFlip;

      // v4 gate (null-safe bucket)
      const pOK  = Number(d.p_up) >= thP;
      const nOK  = Number(d.n)    >= thN;
      const bVal = Number(d.bucket7d);
      const bOK  = Number.isFinite(bVal) ? (bVal >= thB) : (thB <= 0);
      const v4   = pOK && nOK && bOK;

      const combined = v4 && dip;

      // Standby (v4 must be true; need 2/3 proximity cues)
      const rsi0    = ind.rsi[i0];
      const rsiPrev = ind.rsi[i0 - 1] ?? rsi0;
      const price0  = ind.price[i0];
      const lo0     = ind.bbLo[i0];

      const nearRSI    = Number.isFinite(rsi0) && (rsi0 <= (rsiTh + 4)) && ((rsi0 - rsiPrev) >= 0.8);
      const nearBand   = Number.isFinite(lo0) && (price0 <= lo0 || ((price0 - lo0) / Math.max(price0,1)) <= 0.0015);
      const softBounce = ((rsi0 - rsiPrev) >= 0.4) && Number.isFinite(lo0) && (price0 > lo0);
      const standby    = v4 && ((nearRSI?1:0) + (nearBand?1:0) + (softBounce?1:0) >= 2);

      // Entry/exit hints in MYT
      const entryUntil = new Date((d.pred_ts ?? d.ts)).getTime() + wMin*MIN;
      const exitBy     = new Date((d.pred_ts ?? d.ts)).getTime() + holdH*HOUR;
      const toMYT = (ms) => { const z = new Date(ms + 8*HOUR); return z.toISOString().slice(0,16).replace("T"," "); };

      out.push({
        coin, available:true,
        pred_ts: d.pred_ts ?? d.ts,
        p_up: d.p_up, n: d.n, bucket7d: d.bucket7d,
        dip, v4, combined, standby,
        entry_until_myt: toMYT(entryUntil),
        exit_by_myt: toMYT(exitBy),
        tp, sl, max_hold_h: holdH
      });
    }

    res.json({ params:{ coins, thP, thN, thB, wMin, rsiTh, mode, bbk, tp, sl, holdH }, signals: out });
  } catch (e) {
    console.error("[combined_signal]", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
