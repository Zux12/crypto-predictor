 // ESM
import express from "express";
import Inference from "../models/Inference.js";
import Price from "../models/Price.js";

const router = express.Router();

const HOUR = 3600_000, MIN = 60_000;
const toMs = d => +new Date(d);

// tiny helpers
function idxAtOrBefore(ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]<=t){a=m; lo=m+1}else hi=m-1} return a; }
function idxAtOrAfter (ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]>=t){a=m; hi=m-1}else lo=m+1} return a; }
function myt(dt){ const z = new Date(dt.getTime() + 8*HOUR); return z.toISOString().slice(0,16).replace("T"," "); }

// RSI14 (Wilder) + Bollinger(mid 20, sigma k)
function computeIndicators(prices, k=2.0){
  const n = prices.length, rsi = new Array(n).fill(NaN), bbLo = new Array(n).fill(NaN);
  if (!n) return { rsi, bbLo };
  const delta = prices.map((v,i)=> i? v-prices[i-1] : 0);
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
    // Combined v1 defaults (the preset that cleared 70% in your tests)
    const coins = (req.query.coins ?? "bitcoin,ethereum").split(",").map(s=>s.trim());
    const thP   = Number(req.query.p   ?? 0.55);     // v4 p_up
    const thN   = Number(req.query.n   ?? 50);       // v4 n
    const thB   = Number(req.query.b   ?? 0);        // v4 bucket7d
    const wMin  = Number(req.query.w   ?? 30);       // dip window ±minutes
    const rsiTh = Number(req.query.rsi ?? 35);
    const mode  = String(req.query.mode ?? "flip").toLowerCase(); // flip|and|or
    const bbk   = Number(req.query.bbk ?? 1.5);      // Bollinger sigma
    const tp    = Number(req.query.tp  ?? 0.003);    // +0.30%
    const sl    = Number(req.query.sl  ?? 0.002);    // -0.20%
    const holdH = Number(req.query.hold ?? 2);       // max 2h

    // latest inferences per coin
    const infs = await Inference.aggregate([
      { $match: { coin: { $in: coins } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$coin", doc: { $first: "$$ROOT" } } }
    ]);

    // grab price window around the latest pred_ts
    const tMin = Math.min(...infs.map(x => toMs(x.doc.pred_ts ?? x.doc.ts)));
    const tMax = Math.max(...infs.map(x => toMs(x.doc.pred_ts ?? x.doc.ts)));
    const px = await Price.find({
      coin: { $in: coins },
      ts: { $gte: new Date(tMin - 12*HOUR), $lte: new Date(tMax + 12*HOUR) }
    }).sort({ coin:1, ts:1 }).lean();

    // group + indicators
    const G = {};
    for (const r of px) { (G[r.coin] ||= { ts:[], price:[] }).ts.push(toMs(r.ts)); G[r.coin].price.push(Number(r.price)); }
    const IND = {};
    for (const [c, d] of Object.entries(G)) IND[c] = { ...d, ...computeIndicators(d.price, bbk) };

    const out = [];
    for (const {_id: coin, doc:d} of infs){
      const ind = IND[coin]; if (!ind) { out.push({ coin, available:false }); continue; }
      const t0 = toMs(d.pred_ts ?? d.ts);
      const i0 = idxAtOrBefore(ind.ts, t0); if (i0<0){ out.push({ coin, available:false }); continue; }

      // dip detection in window
      const center = ind.ts[i0], W = wMin * MIN;
      let sawRSI=false, sawBand=false, sawFlip=false;
      for (let j=i0; j>=0 && Math.abs(ind.ts[j]-center)<=W; j--){
        const rsiJ=ind.rsi[j], pJ=ind.price[j], loJ=ind.bbLo[j], rsiPrev = (j>0? ind.rsi[j-1] : rsiJ);
        sawRSI  ||= (rsiJ < rsiTh);
        sawBand ||= (pJ <= loJ);
        sawFlip ||= (rsiJ > rsiPrev) && ( (rsiPrev < rsiTh) || (pJ <= loJ) );
      }
      for (let j=i0+1; j<ind.ts.length && Math.abs(ind.ts[j]-center)<=W; j++){
        const rsiJ=ind.rsi[j], pJ=ind.price[j], loJ=ind.bbLo[j], rsiPrev = ind.rsi[j-1] ?? rsiJ;
        sawRSI  ||= (rsiJ < rsiTh);
        sawBand ||= (pJ <= loJ);
        sawFlip ||= (rsiJ > rsiPrev) && ( (rsiPrev < rsiTh) || (pJ <= loJ) );
      }
      const dip = mode==="flip" ? sawFlip : (mode==="or" ? (sawRSI || sawBand) : (sawRSI && sawBand));

      // v4 gate (null-safe bucket)
      const pOK  = Number(d.p_up)    >= thP;
      const nOK  = Number(d.n)       >= thN;
      const bVal = Number(d.bucket7d);
      const bOK  = Number.isFinite(bVal) ? (bVal >= thB) : (thB <= 0);
      const v4   = pOK && nOK && bOK;

      const combined = dip && v4;

      const entryUntil = myt(new Date((d.pred_ts ?? d.ts).getTime() + wMin*MIN));
      const exitBy     = myt(new Date((d.pred_ts ?? d.ts).getTime() + holdH*HOUR));

      out.push({
        coin, available:true,
        pred_ts: d.pred_ts ?? d.ts,
        p_up: d.p_up, n: d.n, bucket7d: d.bucket7d,
        dip, v4, combined,
        entry_until_myt: entryUntil,
        exit_by_myt: exitBy,
        tp, sl, max_hold_h: holdH
      });
    }

    res.json({ params:{ coins, thP, thN, thB, wMin, rsiTh, mode, bbk, tp, sl, holdH }, signals: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
