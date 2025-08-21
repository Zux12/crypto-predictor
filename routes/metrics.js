// routes/metrics.js
import express from "express";
import Prediction from "../models/Prediction.js";

const router = express.Router();

/**
 * GET /api/calibration/last30d
 * Reliability: bin predictions by p_up into 10 buckets (0.0–0.1 … 0.9–1.0)
 * and report average realized correctness per bucket.
 */
router.get("/calibration/last30d", async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await Prediction.aggregate([
      { $match: { labeled_at: { $gte: since } } },
      {
        $project: {
          bucket: { $floor: { $multiply: ["$p_up", 10] } }, // 0..9
          correct: { $cond: [{ $eq: ["$correct", true] }, 1, 0] },
        }
      },
      {
        $group: {
          _id: "$bucket",
          n: { $sum: 1 },
          avgCorrect: { $avg: "$correct" },
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // shape: index by bucket with midpoints for easy UI rendering
    const buckets = rows.map(r => ({
      bucket: r._id,                        // 0..9
      p_mid: (r._id + 0.5) / 10,            // 0.05..0.95
      n: r.n,
      realized: r.avgCorrect                // 0..1
    }));

    res.json({ ok: true, buckets });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});


/**
 * GET /api/accuracy/trend?days=30
 * Daily accuracy & Brier by model over the last N days (default 30).
 */
router.get("/accuracy/trend", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const rows = await Prediction.aggregate([
      { $match: { labeled_at: { $gte: since } } },
      {
        $project: {
          d: { $dateToString: { date: "$labeled_at", format: "%Y-%m-%d" } },
          model: "$model_ver",
          correct: { $cond: [{ $eq: ["$correct", true] }, 1, 0] },
          brier: "$brier"
        }
      },
      {
        $group: {
          _id: { d: "$d", model: "$model" },
          n: { $sum: 1 },
          acc: { $avg: "$correct" },
          brier: { $avg: "$brier" }
        }
      },
      { $sort: { "_id.d": 1, "_id.model": 1 } }
    ]);

    res.json({ ok: true, days, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
