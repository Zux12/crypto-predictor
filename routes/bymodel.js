// routes/bymodel.js
import express from "express";
import Prediction from "../models/Prediction.js";

const router = express.Router();

/**
 * GET /api/scores/by-model?days=30
 * Summary accuracy/Brier by model (and per-coin breakdown) over last N days.
 */
router.get("/scores/by-model", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    // overall by model
    const overall = await Prediction.aggregate([
      { $match: { labeled_at: { $gte: since } } },
      { $group: {
        _id: "$model_ver",
        n: { $sum: 1 },
        acc: { $avg: { $cond: [{ $eq: ["$correct", true] }, 1, 0] } },
        brier: { $avg: "$brier" }
      }},
      { $sort: { _id: 1 } }
    ]);

    // per-coin by model
    const perCoin = await Prediction.aggregate([
      { $match: { labeled_at: { $gte: since } } },
      { $group: {
        _id: { model: "$model_ver", coin: "$coin" },
        n: { $sum: 1 },
        acc: { $avg: { $cond: [{ $eq: ["$correct", true] }, 1, 0] } },
        brier: { $avg: "$brier" }
      }},
      { $sort: { "_id.model": 1, "_id.coin": 1 } }
    ]);

    // shape
    const models = {};
    for (const r of overall) {
      models[r._id] = { n: r.n, acc: r.acc, brier: r.brier, coins: {} };
    }
    for (const r of perCoin) {
      const m = r._id.model;
      const c = r._id.coin;
      if (!models[m]) models[m] = { n: 0, acc: 0, brier: null, coins: {} };
      models[m].coins[c] = { n: r.n, acc: r.acc, brier: r.brier };
    }

    res.json({ ok: true, days, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
