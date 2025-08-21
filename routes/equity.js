// routes/equity.js
import express from "express";
import Equity from "../models/Equity.js";

const router = express.Router();

/**
 * GET /api/equity/summary
 * Returns the most recent equity snapshot for the paper account.
 */
router.get("/summary", async (req, res) => {
  try {
    const last = await Equity.findOne().sort({ ts: -1 }).lean();
    if (!last) return res.json({ ok: true, cash_usd: 0, equity_usd: 0, last_ts: null });
    res.json({
      ok: true,
      cash_usd: last.cash_usd ?? 0,
      equity_usd: last.equity_usd ?? 0,
      last_ts: last.ts || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * GET /api/equity/series?days=7
 * Returns a time series for the equity chart (default 7d, capped at 90d).
 */
router.get("/series", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await Equity.find({ ts: { $gte: since } })
      .sort({ ts: 1 })
      .select({ _id: 0, ts: 1, equity_usd: 1 })
      .lean();

    res.json({ ok: true, days, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
