// routes/trades.js
import express from "express";
import PaperTrade from "../models/PaperTrade.js";

const router = express.Router();

/**
 * GET /api/trades/recent?limit=20
 * Returns the most recent paper trades (BUY/SELL), newest first.
 */
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const rows = await PaperTrade.find({})
      .sort({ ts: -1 })
      .limit(limit)
      .lean();

    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
