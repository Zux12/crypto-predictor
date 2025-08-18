import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// Keep the list focused on a few liquid coins
const COINS = ["bitcoin","ethereum"]; // add "solana", ... later when ready

// ---------- math helpers ----------
function ema(values, period) {
  if (!values?.length || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(close, period = 14) {
  if (!close?.length || close.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = close[i] - close[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  gains /= period; losses /= period;

  for (let i = period + 1; i < close.length; i++) {
    const diff = close[i] - close[i-1];
    const up = diff > 0 ? diff : 0;
    const down = diff < 0 ? -diff : 0;
    gains = (gains * (period - 1) + up) / period;
    losses = (losses * (period - 1) + down) / period;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function stdev(vals) {
  if (!vals?.length || vals.length < 2) return null;
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  const v = vals.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(vals.length-1);
  return Math.sqrt(v);
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ---------- feature & scoring ----------
async function loadCloses(coin, n = 200) {
  // fetch the last N closes (10-min bars in your pipeline cadence)
  const rows = await Price.find({ coin }).sort({ ts: -1 }).limit(n).lean();
  rows.reverse(); // chronological
  return rows.map(r => Number(r.price)).filter(Number.isFinite);
}

function buildFeatures(closes) {
  if (closes.length < 25) return null; // need enough history

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const r1 = (last - prev) / prev;                  // 1-step return (≈10m)

  const ema5  = ema(closes.slice(-25), 5);          // ~50 min EMA
  const ema20 = ema(closes.slice(-100), 20);        // ~200 min EMA
  const ema_cross = (ema5 && ema20) ? (ema5 - ema20) / ema20 : null;

  const rsi14 = rsi(closes.slice(-60), 14);         // RSI over ~2.5–3h window

  // short-horizon volatility of returns (last 12 steps ≈ 2 hours)
  const rets = [];
  for (let i = closes.length - 12; i < closes.length; i++) {
    if (i <= 0) continue;
    rets.push((closes[i] - closes[i-1]) / closes[i-1]);
  }
  const vol2h = stdev(rets);

  return { r1, ema5, ema20, ema_cross, rsi14, vol2h, last };
}

function scoreToProb(f) {
  // Heuristic v2: combine signals
  // - r1 scaled
  // - EMA cross
  // - RSI centered at 50 (overbought/oversold)
  // - Volatility penalty (very high vol → reduce confidence)
  const r1_scaled  = (f.r1 ?? 0) * 150;
  const ema_sig    = (f.ema_cross ?? 0) * 6;
  const rsi_sig    = (typeof f.rsi14 === "number" ? (f.rsi14 - 50) / 10 : 0); // ~[-5,+5] → [-0.5,+0.5]
  const vol_pen    = (f.vol2h && isFinite(f.vol2h)) ? Math.min(f.vol2h / 0.01, 1.5) : 0; // >1% 10m vol gets penalized

  const raw = r1_scaled + ema_sig + rsi_sig - vol_pen; // subtract penalty
  const p = +sigmoid(raw).toFixed(4);
  return { p_up: p, raw_score: raw };
}

async function makePredictionForCoin(coin) {
  const closes = await loadCloses(coin, 240); // ~40 hours at 10-min cadence
  if (!closes || closes.length < 25) return null;

  const f = buildFeatures(closes);
  if (!f) return null;

  const { p_up, raw_score } = scoreToProb(f);

  const doc = await Prediction.create({
    coin,
    horizon: "24h",
    p_up,
    features: {
      r1: f.r1,
      ema5: f.ema5,
      ema20: f.ema20,
      ema_cross: f.ema_cross,
      rsi14: f.rsi14,
      vol2h: f.vol2h,
      raw_score
    },
    model_ver: "v2-ema-rsi"
  });

  return { coin, p_up: doc.p_up, features: doc.features };
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });

    const tsStart = new Date();
    const out = [];
    for (const c of COINS) {
      const r = await makePredictionForCoin(c);
      if (r) out.push({ coin: r.coin, p_up: r.p_up, f: r.features });
    }
    console.log(`[${tsStart.toISOString()}] Forecasted v2:`, out);

    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Forecast error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
