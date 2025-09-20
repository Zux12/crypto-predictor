// routes/go.js
import { Router } from "express";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const r = Router();

// helpers
const COINS = ["bitcoin", "ethereum"];
const MODEL = "v4-ai-logreg-xau";
const BUCKET_LO = 0.70;
const BUCKET_HI = 0.75;      // exclusive
const ENTRY_SEC = 60 * 60;   // 1h
const EXIT_SEC  = 24 * 60 * 60; // 24h
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const MIN_N = 50;

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function secsLeft(sinceTs, horizonSec){
  const now = Date.now();
  const dt = Math.floor((horizonSec*1000 - (now - sinceTs)));
  return dt > 0 ? Math.floor(dt/1000) : 0;
}

// 7d bucket stats for p_up in [0.70,0.75)
async function bucketStats(coin){
  const since = new Date(Date.now() - LOOKBACK_MS);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: {
        from: "predictions",
        localField: "pred_id",
        foreignField: "_id",
        as: "pred"
    }},
    { $unwind: "$pred" },
    { $match: {
        "pred.model_ver": MODEL,
        "pred.coin": coin,
        "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI }
    }},
    { $group: {
        _id: null,
        n: { $sum: 1 },
        avgRet: { $avg: "$realized_ret" }
    }}
  ]);
  const d = rows[0] || { n: 0, avgRet: null };
  return { n: d.n, avgRet: d.avgRet };
}

// last labeled outcome for a GO-like signal (what-if I didn’t act)
async function lastLabeledGoResult(coin){
  const rows = await Label.aggregate([
    { $sort: { pred_ts: -1 } },
    { $lookup: {
        from: "predictions",
        localField: "pred_id",
        foreignField: "_id",
        as: "pred"
    }},
    { $unwind: "$pred" },
    { $match: {
        "pred.model_ver": MODEL,
        "pred.coin": coin,
        "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI }
    }},
    { $limit: 1 },
    { $project: { _id:0, realized_ret:1, pred_ts:1 } }
  ]);
  return rows[0] || null;
}

async function latestPred(coin){
  return await Prediction.findOne({ coin, model_ver: MODEL })
    .sort({ ts: -1 })
    .lean();
}

r.get("/", async (req, res) => {
  try {
    const out = {};
    for (const coin of COINS){
      const [pred, bucket, lastMissed] = await Promise.all([
        latestPred(coin),
        bucketStats(coin),
        lastLabeledGoResult(coin)
      ]);

      if (!pred) {
        out[coin] = { status: "NO_GO", reason: "no prediction", entryCountdownSec:0, exitCountdownSec:0 };
        continue;
      }

      const p = Number(pred.p_up ?? pred.prob_up ?? 0);
      const inBucket = p >= BUCKET_LO && p < BUCKET_HI;
      const bucketOk = (bucket.n >= MIN_N) && (Number(bucket.avgRet) >= 0);

      const status = (inBucket && bucketOk) ? "GO" : "NO_GO";
      const ts = new Date(pred.ts).getTime();

      const entryCountdownSec = secsLeft(ts, ENTRY_SEC);
      const exitCountdownSec  = secsLeft(ts, EXIT_SEC);

      const reasonParts = [];
      reasonParts.push(`p_up=${(p*100).toFixed(1)}%`);
      if (bucket.avgRet != null) reasonParts.push(`7d(70–74%) avg=${(bucket.avgRet*100).toFixed(2)}%`);
      reasonParts.push(`n=${bucket.n}`);
      if (!inBucket) reasonParts.push("outside 70–74%");
      if (bucket.n < MIN_N) reasonParts.push("n<threshold");
      if (bucket.avgRet != null && bucket.avgRet < 0) reasonParts.push("bucket<0");

      out[coin] = {
        status,
        reason: reasonParts.join(" • "),
        model: MODEL,
        pred_ts: pred.ts,
        entryCountdownSec,
        exitCountdownSec,
        lastMissed: lastMissed ? {
          realized_ret: lastMissed.realized_ret,
          pred_ts: lastMissed.pred_ts
        } : null
      };
    }
    res.json({ ok:true, asof: new Date().toISOString(), coins: out,
      params: { bucket:[BUCKET_LO, BUCKET_HI], minN: MIN_N, lookbackDays: 7, entrySec: ENTRY_SEC, exitSec: EXIT_SEC }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});

export default r;
