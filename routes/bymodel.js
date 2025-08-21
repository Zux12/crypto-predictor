// routes/bymodel.js
import express from "express";
import Prediction from "../models/Prediction.js";

const router = express.Router();

/**
 * GET /api/scores/by_model?days=30   <-- matches your frontend
 * (Alias) /api/scores/by-model       <-- optional hyphen alias
 *
 * Returns: { ok, rows: [{ model_ver, n, accuracy, brier }] }
 */
async function handler(req, res) {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const rows = await Prediction.aggregate([
      { $match: { labeled_at: { $gte: since } } },
      {
        $group: {
          _id: "$model_ver",
          n: { $sum: 1 },
          accuracy: { $avg: { $cond: [{ $eq: ["$correct", true] }, 1, 0] } },
          brier: { $avg: "$brier" },
        }
      },
      { $project: { _id: 0, model_ver: "$_id", n: 1, accuracy: 1, brier: 1 } },
      { $sort: { n: -1 } }
    ]);

    res.json({ ok: true, rows, days });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

router.get("/scores/by_model", handler); // underscore (your UI)
router.get("/scores/by-model", handler); // alias (optional)

export default router;
