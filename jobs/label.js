import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

const HORIZON_MS = 24 * 60 * 60 * 1000;   // 24 hours
const GRACE_MS   = 2 * 60 * 1000;         // 2 minutes grace
const LOOKBACK_MS = 45 * 60 * 1000;       // ±45 min search window for price
const BATCH_LIMIT = 200;                  // label up to 200 matured preds per run

// Find the price near 'tsRef'. If baseDir === "at_or_before" prefer earlier price,
// else if baseDir === "at_or_after" prefer later price. Fallback to closest within ±LOOKBACK_MS.
async function getPriceNear(coin, tsRef, baseDir) {
  const tsMin = new Date(tsRef.getTime() - LOOKBACK_MS);
  const tsMax = new Date(tsRef.getTime() + LOOKBACK_MS);

  if (baseDir === "at_or_before") {
    const row = await Price.findOne({ coin, ts: { $lte: tsRef, $gte: tsMin } })
      .sort({ ts: -1 }).lean();
    if (row) return row;
  } else {
    const row = await Price.findOne({ coin, ts: { $gte: tsRef, $lte: tsMax } })
      .sort({ ts: 1 }).lean();
    if (row) return row;
  }

  // fallback: closest within window
  const nearest = await Price.aggregate([
    { $match: { coin, ts: { $gte: tsMin, $lte: tsMax } } },
    { $addFields: { diff: { $abs: { $subtract: ["$ts", tsRef] } } } },
    { $sort: { diff: 1 } },
    { $limit: 1 }
  ]);
  return nearest?.[0] || null;
}

function brierScore(p_up, label_up) {
  const y = label_up ? 1 : 0;
  const diff = y - p_up;
  return diff * diff;
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });

    const now = new Date();
    const cutoff = new Date(now.getTime() - HORIZON_MS - GRACE_MS);

    // Find predictions that are 24h old and not yet labeled
    const matured = await Prediction.find({
      ts: { $lte: cutoff },
      $or: [
        { labeled_at: { $exists: false } },
        { labeled_at: null }
      ]
    })
    .sort({ ts: 1 })
    .limit(BATCH_LIMIT)
    .lean();

    if (!matured.length) {
      console.log(`[${now.toISOString()}] Labeler: no matured predictions to label`);
      await mongoose.disconnect();
      process.exit(0);
    }

    const results = [];

    for (const pred of matured) {
      const evalTs = new Date(pred.ts.getTime() + HORIZON_MS);

      const p0 = await getPriceNear(pred.coin, new Date(pred.ts), "at_or_before");
      const p1 = await getPriceNear(pred.coin, evalTs, "at_or_after");

      if (!p0 || !p1) {
        console.warn(`Labeler: missing prices for ${pred.coin} pred@${pred.ts.toISOString()} (p0=${!!p0}, p1=${!!p1})`);
        // Skip for now; retry next run (maybe data not in yet)
        continue;
      }

      const price0 = Number(p0.price);
      const price1 = Number(p1.price);
      if (!Number.isFinite(price0) || !Number.isFinite(price1) || price0 <= 0) continue;

      const realized_ret = (price1 - price0) / price0;
      const label_up     = realized_ret > 0;
      const brier        = brierScore(pred.p_up, label_up);
      const correct      = (pred.p_up >= 0.5) === label_up;

      // Write a Label row (audit)
      const labelDoc = await Label.create({
        pred_id: pred._id,
        coin: pred.coin,
        horizon: pred.horizon || "24h",
        model_ver: pred.model_ver || "v1-momentum",
        pred_ts: pred.ts,
        eval_ts: evalTs,
        p_up: pred.p_up,
        price_t0: price0,
        price_t1: price1,
        realized_ret,
        label_up,
        brier,
        correct
      });

      // Update the Prediction with outcome fields
      await Prediction.updateOne(
        { _id: pred._id },
        {
          $set: {
            labeled_at: new Date(),
            label_up,
            realized_ret,
            price_t0: price0,
            price_t1: price1,
            brier,
            correct
          }
        }
      );

      results.push({
        coin: pred.coin,
        ts: pred.ts,
        p_up: pred.p_up,
        label_up,
        brier: +brier.toFixed(6),
        correct
      });
    }

    console.log(`Labeler: labeled ${results.length} predictions`, results.slice(0, 5));
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Labeler error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
