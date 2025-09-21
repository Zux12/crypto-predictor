// /routes/combined.js  (ESM)
import express from "express";
import Price from "../models/Price.js";
import Inference from "../models/Inference.js";

const router = express.Router();

function toMs(d){ return +new Date(d); }
function idxAtOrBefore(tsArr, t){ let lo=0,hi=tsArr.length-1,ans=-1; while(lo<=hi){const m=(lo+hi)>>1; if(tsArr[m]<=t){ans=m;lo=m+1}else hi=m-1;} return ans; }
function idxAtOrAfter(tsArr, t){ let lo=0,hi=tsArr.length-1,ans=-1; while(lo<=hi){const m=(lo+hi)>>1; if(tsArr[m]>=t){ans=m;hi=m-1}else lo=m+1;} return ans; }

// RSI(14) Wilder + Bollinger(20,2)—lightweight, no deps
function computeIndicators(prices){
  const n = prices.length, rsi = new Array(n).fill(NaN), bbLo = new Array(n).fill(NaN);
  if(!n) return { rsi, bbLo };
  const delta = prices.map((v,i)=> i? v-prices[i-1] : 0);
  let ru=0, rd=0, a=1/14;
  for(let i=0;i<n;i++){
    const up=Math.max(delta[i],0), dn=Math.max(-delta[i],0);
    ru = i? (a*up + (1-a)*ru) : up; rd = i? (a*dn + (1-a)*rd) : dn;
    const rs = rd===0 ? 100 : ru/rd;
    rsi[i] = 100 - (100/(1+rs));
  }
  const w=20,k=2; let sum=0,sumsq=0;
  for(let i=0;i<n;i++){
    sum+=prices[i]; sumsq+=prices[i]*prices[i];
    if(i>=w){ sum-=prices[i-w]; sumsq-=prices[i-w]*prices[i-w]; }
    if(i>=w-1){ const m=sum/w; const sd=Math.sqrt(Math.max(0,(sumsq/w)-m*m)); bbLo[i]=m-k*sd; }
  }
  return { rsi, bbLo };
}

router.get("/summary", async (req, res) => {
  try {
    const days = Number(req.query.days ?? 7);
    const horizons = (req.query.h ?? "1,4,24").split(",").map(Number).filter(Boolean);
    const thP = Number(req.query.p ?? 0.60);
    const thN = Number(req.query.n ?? 50);
    const thB = Number(req.query.b ?? 0);
    const coins = (req.query.coins ?? "bitcoin,ethereum").split(",").map(s=>s.trim());

    const since = new Date(Date.now() - days*86400_000);
    const infs = await Inference.find({ ts: { $gte: since }, coin: { $in: coins } })
      .sort({ ts: 1 }).lean();
    if (!infs.length) return res.json({ horizons, totals:{N:0}, buckets:[] });

    const minT = new Date(Math.min(...infs.map(d=>toMs(d.pred_ts ?? d.ts))));
    const maxT = new Date(Math.max(...infs.map(d=>toMs(d.pred_ts ?? d.ts))));
    const pxSince = new Date(minT.getTime() - 12*3600_000);
    const pxUntil = new Date(maxT.getTime() + 36*3600_000);

    const raw = await Price.find({
      coin: { $in: coins }, ts: { $gte: pxSince, $lte: pxUntil }
    }).sort({ coin:1, ts:1 }).lean();

    // group prices & compute indicators
    const M = {};
    for (const r of raw) {
      const key = r.coin;
      (M[key] ||= { ts:[], price:[] }).ts.push(toMs(r.ts));
      M[key].price.push(Number(r.price));
    }
    const IND = {};
    for (const [coin, d] of Object.entries(M)) IND[coin] = { ...d, ...computeIndicators(d.price) };

    const rows=[];
    for (const d of infs) {
      const coin = d.coin;
      const ind = IND[coin]; if(!ind) continue;
      const t0 = toMs(d.pred_ts ?? d.ts);
      const i0 = idxAtOrBefore(ind.ts, t0); if(i0<0) continue;
      const p0 = ind.price[i0];
      const dip = (ind.rsi[i0] < 30) && (p0 <= ind.bbLo[i0]);
      const v4  = (Number(d.p_up) >= thP) && (Number(d.n) >= thN) && (Number(d.bucket7d) >= thB);

      const rets = {};
      for (const h of horizons) {
        const i1 = idxAtOrAfter(ind.ts, t0 + h*3600_000);
        rets[h] = i1<0 ? null : (ind.price[i1]/p0 - 1);
      }
      rows.push({ coin, dip, v4, rets });
    }

    function bucket(fn, name){
      const ss = rows.filter(fn);
      const out={ bucket:name, N:ss.length };
      for (const h of horizons){
        const v = ss.map(r=>r.rets[h]).filter(x=>x!=null);
        out[`N_${h}h`]  = v.length;
        out[`WR_${h}h`] = v.length? v.filter(x=>x>=0).length/v.length : null;
        out[`EV_${h}h`] = v.length? v.reduce((a,b)=>a+b,0)/v.length : null;
      }
      return out;
    }

    res.json({
      horizons,
      totals:{ N: rows.length },
      buckets:[
        bucket(r=>r.dip, "Dip only"),
        bucket(r=>r.v4,  "v4-xau only"),
        bucket(r=>r.dip && r.v4, "Combined")
      ]
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
