import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// Keep the list focused on a few liquid coins
const COINS = ["bitcoin","ethereum"]; // add "solana" later if desired

// ---------- math helpers ----------
function ema(values, period) {
  if (!values?.length || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function sma(values, period) {
  if (!values?.length || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
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

// ---------- data ----------
async function loadCloses(coin, n = 240) {
  // fetch the last N closes (10-min cadence; 240 ~ 40 hours)
  const rows = await Price.find({ coin }).sort({ ts: -1 }).limit(n).lean();
  rows.reverse(); // chronological
  return rows.map(r => Number(r.price)).filter(Number.isFinite);
}

// ---------- feature builders ----------
function buildFeatures(closes) {
  // Need enough history for all indicators
  // EMA20, RSI14, MACD(12/26) & signal(9), BB(20, 2σ) → ensure >= 26 for MACD base, >= 20 for BB, >= 14 for RSI.
  if (closes.length < 30) return null;

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const r1 = (last - prev) / prev; // 1-step (~10m) return

  // EMAs
  const ema5  = ema(closes.slice(-25), 5);
  const ema20 = ema(closes.slice(-100), 20);
  const ema_cross = (ema5 && ema20) ? (ema5 - ema20) / ema20 : null;

  // RSI14 over recent window
  const rsi14 = rsi(closes.slice(-60), 14);

  // Short-horizon volatility (last 12 steps ≈ 2 hours)
  const rets = [];
  for (let i = closes.length - 12; i < closes.length; i++) {
    if (i <= 0) continue;
    rets.push((closes[i] - closes[i-1]) / closes[i-1]);
  }
  const vol2h = stdev(rets);

  // --- NEW: MACD (12, 26) and signal (9) on MACD ---
  // compute EMA12 and EMA26 from a reasonable tail window
  const tailForMacd = closes.slice(-120); // ~20 hours of 10-min bars
  const ema12 = ema(tailForMacd, 12);
  const ema26 = ema(tailForMacd, 26);
  let macd = null, macd_signal = null, macd_hist = null;
  if (ema12 != null && ema26 != null) {
    macd = ema12 - ema26;
    // For signal, approximate using last ~40 points of macd proxy (cheap approach):
    // In a full implementation you'd compute macd at each step; here we reuse current macd.
    // We'll still create a meaningful signal by smoothing the last ~40 prices' macd proxy.
    const macdSeries = [];
    // Build a crude series by recomputing EMA12-EMA26 along the tail (cheap but serviceable)
    for (let i = 26; i < tailForMacd.length; i++) {
      const slice = tailForMacd.slice(0, i+1);
      const e12 = ema(slice, 12);
      const e26 = ema(slice, 26);
      if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
    }
    macd_signal = ema(macdSeries, 9);
    if (macd_signal != null) macd_hist = macd - macd_signal;
  }

  // --- NEW: Bollinger Bands %B (20, 2σ) ---
  const windowBB = closes.slice(-40); // enough for SMA20 + stdev20
  const sma20 = sma(windowBB, 20);
  const sd20  = stdev(windowBB.slice(-20));
  let bbp = null; // %B = (price - lower) / (upper - lower)
  if (sma20 != null && sd20 != null && sd20 > 0) {
    const upper = sma20 + 2 * sd20;
    const lower = sma20 - 2 * sd20;
    bbp = (last - lower) / (upper - lower); // typically in [0,1], can go outside
  }

  return {
    last, r1, ema5, ema20, ema_cross, rsi14, vol2h,
    ema12, ema26, macd, macd_signal, macd_hist,
    sma20, sd20, bbp
  };
}

// ---------- scoring ----------
function scoreToProb(f) {
  // Heuristic v3: blend momentum + trend + mean-reversion + volatility control.
  // - r1 (short momentum)
  // - ema_cross (trend)
  // - rsi14 centered around 50 (mean-reversion/overbought-oversold)
  // - macd_hist (momentum slope)
  // - bbp centered around 0.5 (position within bands)
  // - vol penalty to reduce overconfidence in high turbulence

  const r1_sig   = (f.r1 ?? 0) * 150;
  const ema_sig  = (f.ema_cross ?? 0) * 6;
  const rsi_sig  = (typeof f.rsi14 === "number" ? (f.rsi14 - 50) / 10 : 0);  // ~[-5,+5] → [-0.5,+0.5]
  const macd_sig = (f.macd_hist ?? 0) * 8;                                   // histogram as momentum slope
  const bbp_sig  = (typeof f.bbp === "number" ? (f.bbp - 0.5) * 2 : 0);      // center 0 → [-1,+1]

  const vol_pen  = (f.vol2h && isFinite(f.vol2h)) ? Math.min(f.vol2h / 0.01, 1.5) : 0; // >1% 10m vol → penalty

  const raw = r1_sig + ema_sig + rsi_sig + macd_sig + bbp_sig - vol_pen;
  const p = +sigmoid(raw).toFixed(4);
  return { p_up: p, raw_score: raw };
}

async function makePredictionForCoin(coin) {
  const closes = await loadCloses(coin, 240); // ~40 hours at 10-min cadence
  const canFallback = closes && closes.length >= 2;

  // Try full feature set first
  if (closes && closes.length >= 30) {
    const f = buildFeatures(closes);
    if (f) {
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
          ema12: f.ema12,
          ema26: f.ema26,
          macd: f.macd,
          macd_signal: f.macd_signal,
          macd_hist: f.macd_hist,
          sma20: f.sma20,
          sd20: f.sd20,
          bbp: f.bbp,
          raw_score
        },
        model_ver: "v3-macd-bb"
      });
      return { coin, p_up: doc.p_up, features: doc.features };
    }
  }

  // Fallback (v1 momentum) while history accumulates
  if (canFallback) {
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const r1 = (last - prev) / prev;
    const p_up = +sigmoid(r1 * 150).toFixed(4);
    const doc = await Prediction.create({
      coin,
      horizon: "24h",
      p_up,
      features: { r1 },
      model_ver: "v1-fallback"
    });
    return { coin, p_up: doc.p_up, features: doc.features };
  }

  // Not enough data to do anything yet
  return null;
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
    console.log(`[${tsStart.toISOString()}] Forecasted v3:`, out);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Forecast error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
