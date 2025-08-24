// routes/gold.js
import { Router } from 'express';
import Price from '../models/Price.js';

const r = Router();

// GET /api/gold/latest -> { price, ts }
r.get('/latest', async (req, res) => {
  try {
    const row = await Price.findOne({ coin: 'gold' }).sort({ ts: -1 }).lean();
    if (!row) return res.status(404).json({ error: 'no gold price yet' });
    res.json({ price: row.price, ts: row.ts });
  } catch (e) {
    console.error('gold latest error', e);
    res.status(500).json({ error: 'server error' });
  }
});

export default r;
