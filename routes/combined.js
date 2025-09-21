// /routes/combined.js  — summary for Dip (RSI+BB), v4-gate, and Combined
import express from "express";
import Price from "../models/Price.js";
import Inference from "../models/Inference.js";

const router = express.Router();

const toMs = (d) => +new Date(d);
const HOUR = 3600_000, MIN = 60_000;

function idxAtOrBefore(ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]<=t){a=m; lo=m+1;} else hi=m-1;} return a; }
function idxAtOrAfter (ts, t){ let lo=0,hi=ts.length-1,a=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ts[m]>=t){a=m; hi=m-1;} else lo=m+1;} return a; }

// ...same imports...

function computeIndicators(prices, k){  // k = Bollinger sigma
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

router.get("/summary", async (req, res) => {
  try {
    const days     = Number(req.query.days ?? 7);
    const horizons = (req.query.h ?? "0.5,1,2").split(",").map(Number).filter(Boolean);
    const coins    = (req.query.coins ?? "bitcoin,ethereum").split(",").map(s=>s.trim());

    // v4 gate
    const thP = Number(req.query.p ?? 0.60);
    const thN = Number(req.query.n ?? 50);
    const thB = Number(req.query.b ?? 0);

    // dip params
    const rsiTh  = Number(req.query.rsi ?? 30);
    const wMin   = Number(req.query.w   ?? 15);
    const tolMin = Number(req.query.tol ?? 10);
    const dmode  = String(req.query.mode ?? "and").toLowerCase(); // "and" | "or" | "flip"
    const bbk    = Number(req.query.bbk ?? 2.0); // <—— NEW: Bollinger sigma

    const since = new Date(Date.now() - days*24*3600_000);
    const infs = await Inference.find({ ts: { $gte: since }, coin: { $in: coins } })
      .sort({ ts: 1 }).lean();
    if (!infs.length) return res.json({ horizons, totals:{N:0}, buckets:[] });

    const minT = new Date(Math.min(...infs.map(d=> +new Date(d.pred_ts ?? d.ts))));
    const maxT = new Date(Math.max(...infs.map(d=> +new Date(d.pred_ts ?? d.ts))));
    const raw = await Price.find({
      coin: { $in: coins },
      ts: { $gte: new Date(minT.getTime()-12*3600_000), $lte: new Date(maxT.getTime()+36*3600_000) }
    }).sort({ coin:1, ts:1 }).lean();

    // group & indicators
    const G = {};
    for (const r of raw) { (G[r.coin] ||= { ts:[], price:[] }).ts.push(+new Date(r.ts)), G[r.coin].price.push(Number(r.price)); }
    const IND = {};
    for (const [c, d] of Object.entries(G)) IND[c] = { ...d, ...computeIndicators(d.price, bbk) };

    function nearestInWindow(ts, target, tolMs){
      let lo = target - tolMs, hi = target + tolMs;
      let i = ts.findIndex(t=> t>=lo); if (i<0) return -1;
      let best=-1, bestAbs=Infinity;
      for (; i<ts.length && ts[i]<=hi; i++){ const a=Math.abs(ts[i]-target); if (a<bestAbs){best=i; bestAbs=a;} }
      return best;
    }

    const rows = [];
    for (const d of infs){
      const coin = d.coin, ind = IND[coin]; if (!ind) continue;
      const t0 = +new Date(d.pred_ts ?? d.ts);
      let i0 = (()=>{ // idxAtOrBefore
        let lo=0,hi=ind.ts.length-1,ans=-1; while(lo<=hi){const m=(lo+hi)>>1; if(ind.ts[m]<=t0){ans=m;lo=m+1}else hi=m-1;} return ans;
      })();
      if (i0<0) continue;

      // ——— DIP logic with window & mode ———
      const center = ind.ts[i0], W = wMin*60_000;
      let sawRSI=false, sawBand=false, sawFlip=false;
      // scan around
      for (let j=i0; j>=0 && Math.abs(ind.ts[j]-center)<=W; j--){
        const rsiJ = ind.rsi[j], pJ = ind.price[j], loJ = ind.bbLo[j];
        const rsiPrev = (j>0? ind.rsi[j-1] : rsiJ);
        sawRSI  ||= (rsiJ < rsiTh);
        sawBand ||= (pJ <= loJ);
        sawFlip ||= (rsiJ > rsiPrev) && ( (rsiPrev < rsiTh) || (pJ <= loJ) );
      }
      for (let j=i0+1; j<ind.ts.length && Math.abs(ind.ts[j]-center)<=W; j++){
        const rsiJ = ind.rsi[j], pJ = ind.price[j], loJ = ind.bbLo[j];
        const rsiPrev = ind.rsi[j-1] ?? rsiJ;
        sawRSI  ||= (rsiJ < rsiTh);
        sawBand ||= (pJ <= loJ);
        sawFlip ||= (rsiJ > rsiPrev) && ( (rsiPrev < rsiTh) || (pJ <= loJ) );
      }
      const dip =
        dmode === "flip" ? sawFlip :
        dmode === "or"   ? (sawRSI || sawBand) :
                           (sawRSI && sawBand);

      // v4 gate (null-safe bucket)
      const pOK  = Number(d.p_up) >= thP;
      const nOK  = Number(d.n)    >= thN;
      const bVal = Number(d.bucket7d);
      const bOK  = Number.isFinite(bVal) ? (bVal >= thB) : (thB <= 0);
      const v4   = pOK && nOK && bOK;

      // returns with tolerance
      const p0 = ind.price[i0], rets = {};
      for (const h of horizons){
        const k = nearestInWindow(ind.ts, t0 + h*3600_000, tolMin*60_000);
        rets[h] = (k === -1) ? null : (ind.price[k]/p0 - 1);
      }
      rows.push({ coin, dip, v4, rets });
    }

    function bucket(pred, name){
      const ss = rows.filter(pred);
      const o = { bucket:name, N:ss.length };
      for (const h of horizons){
        const v = ss.map(r=>r.rets[h]).filter(x=>x!=null);
        o[`N_${h}h`]  = v.length;
        o[`WR_${h}h`] = v.length ? v.filter(x=>x>=0).length/v.length : null;
        o[`EV_${h}h`] = v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
      }
      return o;
    }

    res.json({
      horizons,
      totals: { N: rows.length },
      buckets: [
        bucket(r=> r.dip, "Dip only"),
        bucket(r=> r.v4 , "v4-xau only"),
        bucket(r=> r.dip && r.v4, "Combined")
      ]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


// nearest index to target within ±tolMs
function nearestInWindow(ts, target, tolMs){
  let i = idxAtOrAfter(ts, target - tolMs);
  if (i < 0) i = 0;
  let best=-1, bestAbs=Infinity;
  for (; i<ts.length && ts[i] <= target + tolMs; i++){
    const a = Math.abs(ts[i] - target);
    if (a < bestAbs) { best = i; bestAbs = a; }
  }
  return best;
}

router.get("/summary", async (req, res) => {
  try {
    // ----- Tunables via query -----
    const days     = Number(req.query.days ?? 7);
    const horizons = (req.query.h ?? "0.5,1,2").split(",").map(Number).filter(Boolean);
    const coins    = (req.query.coins ?? "bitcoin,ethereum").split(",").map(s=>s.trim());

    // v4 gate
    const thP = Number(req.query.p ?? 0.60);    // p_up threshold
    const thN = Number(req.query.n ?? 50);      // min n
    const thB = Number(req.query.b ?? 0);       // min bucket7d

    // dip logic
    const rsiTh  = Number(req.query.rsi ?? 30); // RSI<rsiTh
    const wMin   = Number(req.query.w   ?? 15); // ±window minutes around inference for dip check
    // return sampling tolerance (if no exact bar, pick nearest within ±tolMin)
    const tolMin = Number(req.query.tol ?? 10);

    // ----- Fetch data -----
    const since = new Date(Date.now() - days*24*HOUR);
    const infs = await Inference.find({ ts: { $gte: since }, coin: { $in: coins } })
      .sort({ ts: 1 }).lean();

    if (!infs.length) return res.json({ horizons, totals:{N:0}, buckets:[] });

    const minT = new Date(Math.min(...infs.map(d=> toMs(d.pred_ts ?? d.ts))));
    const maxT = new Date(Math.max(...infs.map(d=> toMs(d.pred_ts ?? d.ts))));
    const px = await Price.find({
      coin: { $in: coins },
      ts: { $gte: new Date(minT.getTime()-12*HOUR), $lte: new Date(maxT.getTime()+36*HOUR) }
    }).sort({ coin:1, ts:1 }).lean();

    // group prices per coin + indicators
    const G = {};
    for (const r of px){
      const c = r.coin;
      (G[c] ||= { ts:[], price:[] }).ts.push(toMs(r.ts));
      G[c].price.push(Number(r.price));
    }
    const IND = {};
    for (const [c, d] of Object.entries(G)) IND[c] = { ...d, ...computeIndicators(d.price) };

    // ----- Evaluate rows -----
    const rows = [];
    for (const d of infs){
      const coin = d.coin;
      const ind = IND[coin]; if (!ind) continue;
      const t0 = toMs(d.pred_ts ?? d.ts);
      const i0 = idxAtOrBefore(ind.ts, t0); if (i0 < 0) continue;

      // Dip within ±wMin
      const center = ind.ts[i0], W = wMin*MIN;
      let dip=false;
      for (let j=i0; j>=0 && Math.abs(ind.ts[j]-center)<=W; j--){
        if (ind.rsi[j] < rsiTh && ind.price[j] <= ind.bbLo[j]) { dip=true; break; }
      }
      for (let j=i0+1; !dip && j<ind.ts.length && Math.abs(ind.ts[j]-center)<=W; j++){
        if (ind.rsi[j] < rsiTh && ind.price[j] <= ind.bbLo[j]) { dip=true; break; }
      }

      // v4 gate
// BEFORE (too strict when bucket7d is null/undefined):
// const v4  = (Number(d.p_up) >= thP) && (Number(d.n) >= thN) && (Number(d.bucket7d) >= thB);
// AFTER (null-safe; missing bucket passes if threshold ≤ 0):
const pOK  = Number(d.p_up) >= thP;
const nOK  = Number(d.n)    >= thN;
const bVal = Number(d.bucket7d);
const bOK  = Number.isFinite(bVal) ? (bVal >= thB) : (thB <= 0);
const v4   = pOK && nOK && bOK;



      // returns with tolerance
      const p0 = ind.price[i0];
      const rets = {};
      for (const h of horizons){
        const target = t0 + h*HOUR;
        const k = nearestInWindow(ind.ts, target, tolMin*MIN);
        rets[h] = (k === -1) ? null : (ind.price[k]/p0 - 1);
      }

      rows.push({ coin, dip, v4, rets });
    }

    // ----- Aggregate -----
    function bucket(pred, name){
      const ss = rows.filter(pred);
      const out = { bucket:name, N:ss.length };
      for (const h of horizons){
        const v = ss.map(r=>r.rets[h]).filter(x=>x!=null);
        out[`N_${h}h`]  = v.length;
        out[`WR_${h}h`] = v.length ? v.filter(x=>x>=0).length / v.length : null;
        out[`EV_${h}h`] = v.length ? v.reduce((a,b)=>a+b,0)/v.length : null;
      }
      return out;
    }

    res.json({
      horizons,
      totals: { N: rows.length },
      buckets: [
        bucket(r=> r.dip, "Dip only"),
        bucket(r=> r.v4 , "v4-xau only"),
        bucket(r=> r.dip && r.v4, "Combined")
      ]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
