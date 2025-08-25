// routes/metrics_compare.js
import { Router } from "express";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const r = Router();

function parseParams(q){
  const hrs = Math.max(1, Math.min(72, Number(q.hrs || 24)));
  const ths = String(q.th || "0.6,0.7")
    .split(",").map(s=>Number(s.trim())).filter(x=>x>=0.5 && x<=0.99);
  return { hrs, ths };
}

async function bucketFor(model, hrs, th){
  const since = new Date(Date.now() - hrs*60*60*1000);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: {
        from: "predictions",
        localField: "pred_id",
        foreignField: "_id",
        as: "pred"
    }},
    { $unwind: "$pred" },
    { $match: { "pred.model_ver": model, "pred.p_up": { $gte: th } } },
    { $project: {
        realized_ret: 1
    }},
    { $group: {
        _id: null,
        n: { $sum: 1 },
        wins: { $sum: { $cond: [ { $gte: ["$realized_ret", 0.008] }, 1, 0 ] } },
        losses:{ $sum: { $cond: [ { $lte: ["$realized_ret", -0.005] }, 1, 0 ] } },
        flats: { $sum: { $cond: [
          { $and: [ { $lt: ["$realized_ret", 0.008] }, { $gt: ["$realized_ret", -0.005] } ] }, 1, 0
        ] } },
        avgRet: { $avg: "$realized_ret" }
    }}
  ]);
  const d = rows[0] || { n:0,wins:0,losses:0,flats:0,avgRet:null };
  return { model, th, ...d };
}

r.get("/v4-vs-xau", async (req, res) => {
  try {
    const { hrs, ths } = parseParams(req.query);
    const models = ["v4-ai-logreg", "v4-ai-logreg-xau"];
    const out = [];
    for (const m of models) {
      for (const th of ths) {
        out.push(await bucketFor(m, hrs, th));
      }
    }
    res.json({ ok:true, hrs, thresholds: ths, rows: out });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

export default r;
