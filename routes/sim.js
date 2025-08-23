// routes/sim.js
import express from "express";
import Prediction from "../models/Prediction.js";

const router = express.Router();

function mean(a){ return a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0; }

router.get("/pnl", async (req, res) => {
  try {
    // Params (with sane defaults)
    const models = String(req.query.models || "v3-macd-bb,v4-ai-logreg")
      .split(",").map(s=>s.trim()).filter(Boolean);
    const coins  = String(req.query.coins || "bitcoin,ethereum")
      .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const days   = Math.min(Math.max(parseInt(req.query.days || "60",10), 1), 365);
    const feeBps = Math.min(Math.max(parseInt(req.query.fee_bps || "10",10), 0), 200);
    const lo     = Math.max(0, Number(req.query.lo ?? 0.50));
    const hi     = Math.min(1, Number(req.query.hi ?? 0.70));
    const step   = Math.min(Math.max(Number(req.query.step ?? 0.01), 0.001), 0.1);

    const since = new Date(Date.now() - days*24*60*60*1000);
    const fee   = feeBps / 10000;

    // Build sweep grid
    const taus = [];
    for (let t=lo; t<=hi+1e-12; t+=step) taus.push(Number(t.toFixed(4)));

    const out = { ok:true, days, fee_bps: feeBps, coins, models, lo, hi, step, results: [] };

    for (const coin of coins) {
      for (const model of models) {
        // Join predictions -> labels (labeled only)
        const rows = await Prediction.aggregate([
          { $match: { coin, horizon:"24h", model_ver:model, ts: { $gte: since } } },
          { $sort: { ts: 1 } },
          { $lookup: { from: "labels", localField: "_id", foreignField: "pred_id", as: "lab" } },
          { $unwind: "$lab" },
          { $project: { _id:0, ts:1, p_up:1, realized_ret:"$lab.realized_ret" } }
        ]);

        const grid = [];
        let best = { tau: null, n:0, hit:0, avg:0, sum:0 };

        for (const tau of taus) {
          const picks = rows.filter(r => r.p_up >= tau);
          const n = picks.length;
          const rets = picks.map(r => (r.realized_ret || 0) - fee);
          const sum = rets.reduce((s,v)=>s+v,0);
          const avg = mean(rets);
          const hit = n ? picks.filter(r => (r.realized_ret||0) > 0).length / n : 0;

          grid.push({ tau, n, hit, avg, sum });

          // choose best by avg, require minimum support n≥30
          if (n >= 30 && avg > (best.avg ?? -1e9)) {
            best = { tau, n, hit, avg, sum };
          }
        }

        out.results.push({
          coin, model, labeled: rows.length,
          best, // best per-coin/model
          // keep grid small to return; if it’s large, return only a thin sample
          grid: grid.length > 60 ? grid.filter((_,i)=> i%Math.ceil(grid.length/60)===0) : grid
        });
      }
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

export default router;
