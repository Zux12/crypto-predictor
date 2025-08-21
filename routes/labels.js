// routes/labels.js
import express from "express";
import Prediction from "../models/Prediction.js";

const router = express.Router();

/**
 * GET /api/labels/latest?limit=50
 * Returns most recent labeled predictions (any coin/model), newest first.
 */
router.get("/latest", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await Prediction.find({ labeled_at: { $ne: null } })
      .sort({ labeled_at: -1 })
      .limit(limit)
      .select({
        _id: 0,
        coin: 1,
        model_ver: 1,
        ts: 1,
        labeled_at: 1,
        p_up: 1,
        brier: 1,
        correct: 1,
        price_t0: 1,
        price_t1: 1,
      })
      .lean();

    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
