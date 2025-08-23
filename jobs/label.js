// jobs/label.js
import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// Tunables (with sane defaults)
const HORIZON_MS   = 24 * 60 * 60 * 1000;                    // 24h
const GRACE_MS     = 2  * 60 * 1000;                         // 2 min grace after horizon
const LOOKBACK_MS  = Number(process.env.LOOKBACK_MIN || 90) * 60 * 1000; // ±90 min window (env: LOOKBACK_MIN)
const BATCH_LIMIT  = Number(process.env.BATCH_LIMIT || 200);  // max preds per run
const ONLY_MODEL   = process.env.LABEL_ONLY_MODEL || "";      // optional: e.g. "v4-ai-logreg"

// Find the price near 'tsRef'.
// If baseDir === "at_or_before": prefer earlier price (descending).
// If baseDir === "at_or_after":  prefer later   price (ascending).
// Fallback to the closest within ±LOOKBACK_MS.
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

  // fallback: absolute nearest within window
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
  const d = y - (Number(p_up) || 0);
  return d * d;
}

(async () => {
  let labeledCount = 0;
  const startedAt = new Date();

  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

    const now = new Date();
    const cutoff = new Date(now.getTime() - HORIZON_MS - GRACE_MS);

    // Build matured query (model‑agnostic by default; can target a single model via env)
    const match = {
      ts: { $lte: cutoff },
      $or: [ { labeled_at: { $exists: false } }, { labeled_at: null } ],
      horizon: "24h",
    };
    if (ONLY_MODEL) match.model_ver = ONLY_MODEL;

    const matured = await Prediction.find(match)
      .sort({ ts: 1 })
      .limit(BATCH_LIMIT)
      .lean();

    if (!matured.length) {
      console.log(`[${now.toISOString()}] Labeler: no matured predictions to label (ONLY_MODEL=${ONLY_MODEL || "ALL"})`);
      return;
    }

    const resultsPreview = [];

    for (const pred of matured) {
      const t0 = new Date(pred.ts);
      const t1 = new Date(t0.getTime() + HORIZON_MS);

      // Lookup prices near entry/exit times
      const row0 = await getPriceNear(pred.coin, t0, "at_or_before");
      const row1 = await getPriceNear(pred.coin, t1, "at_or_after");

      if (!row0 || !row1) {
        console.warn(`Labeler: missing prices for ${pred.coin} pred@${t0.toISOString()} (t0:${!!row0} t1:${!!row1})`);
        // Skip for now; will be retried in a later run
        continue;
      }

      const price0 = Number(row0.price);
      const price1 = Number(row1.price);
      if (!Number.isFinite(price0) || !Number.isFinite(price1) || price0 <= 0) {
        console.warn(`Labeler: invalid price(s) for ${pred.coin} pred@${t0.toISOString()} (p0=${price0}, p1=${price1})`);
        continue;
      }

      const realized_ret = (price1 - price0) / price0;
      const label_up     = realized_ret > 0;
      const brier        = brierScore(pred.p_up, label_up);
      const correct      = ((Number(pred.p_up) || 0) >= 0.5) === label_up;

      // Audit row in Label collection
      await Label.create({
        pred_id:    pred._id,
        coin:       pred.coin,
        horizon:    pred.horizon || "24h",
        model_ver:  pred.model_ver || null, // keep the true model
        pred_ts:    t0,
        eval_ts:    t1,
        p_up:       pred.p_up,
        price_t0:   price0,
        price_t1:   price1,
        realized_ret,
        label_up,
        brier,
        correct,
        labeled_at: new Date()
      });

      // Update the Prediction with outcomes
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

      labeledCount++;
      if (resultsPreview.length < 5) {
        resultsPreview.push({
          coin: pred.coin,
          ts: pred.ts,
          p_up: Number(pred.p_up),
          label_up,
          brier: +brier.toFixed(6),
          correct
        });
      }
    }

    console.log(
      `Labeler: labeled ${labeledCount} predictions (ONLY_MODEL=${ONLY_MODEL || "ALL"})`,
      resultsPreview
    );
  } catch (e) {
    console.error("Labeler error:", e?.stack || e?.message || String(e));
    process.exitCode = 1;
  } finally {
    try { await mongoose.disconnect(); } catch {}
    const sec = ((new Date()) - startedAt) / 1000;
    console.log(`Labeler finished in ${sec.toFixed(1)}s`);
    process.exit();
  }
})();
