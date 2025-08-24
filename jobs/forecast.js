import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// Keep the list focused on a few liquid coins
const COINS = ["bitcoin", "ethereum"]; // add "solana" later if desired

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
  const rows = await Price.find({ coin }).sort({ ts: -1 }).limit(n).lean();
  rows.reverse(); // chronological
  return rows.map(r => Number(r.price)).filter(Number.isFinite);
}

// --- GOLD helpers (non-invasive) ---
async function loadGoldCloses(n = 300) {
  const rows = await Price.find({ coin: "gold" }).sort({ ts: -1 }).limit(n).lean();
  rows.reverse();
  return rows.map(r => Number(r.price)).filter(Number.isFinite);
}

// cumulative return over `lag` days for GOLD (today vs `lag` days ago)
async function goldRetLag(lag = 10) {
  const g = await loadGoldCloses(Math.max(60, lag + 30));
  if (!g || g.length <= lag) return null;
  const now = g[g.length - 1];
  const past = g[g.length - 1 - lag];
  if (!Number.isFinite(now) || !Number.isFinite(past) || past === 0) return null;
  return (now - past) / past;
}

// clamp helper
function clamp01(x) { return Math.max(0, Math.min(1, x)); }


// ---------- feature builder ----------
function buildFeatures(closes) {
  if (!closes || closes.length < 20) return null;

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const r1 = (last - prev) / prev;

  // EMA cross (shorter tails OK)
  const tailEma5  = closes.slice(-Math.max(10, Math.min(25, closes.length)));
  const tailEma20 = closes.slice(-Math.max(25, Math.min(80, closes.length)));
  const ema5  = ema(tailEma5, 5);
  const ema20 = ema(tailEma20, 20);
  const ema_cross = (ema5 != null && ema20 != null && ema20 !== 0) ? (ema5 - ema20) / ema20 : null;

  // RSI14 (accept 30–60 closes)
  const tailRsi = closes.slice(-Math.max(30, Math.min(60, closes.length)));
  const rsi14 = rsi(tailRsi, 14);

  // short vol (up to 12 returns)
  const span = Math.min(12, closes.length - 1);
  const rets = [];
  for (let i = closes.length - span; i < closes.length; i++) {
    if (i <= 0) continue;
    rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const vol2h = stdev(rets);

  // MACD(12,26) + signal(9)
  const tailForMacd = closes.slice(-Math.max(30, Math.min(120, closes.length)));
  let macd = null, macd_signal = null, macd_hist = null;
  if (tailForMacd.length >= 26) {
    const macdSeries = [];
    for (let i = 26; i < tailForMacd.length; i++) {
      const slice = tailForMacd.slice(0, i + 1);
      const e12 = ema(slice, 12);
      const e26 = ema(slice, 26);
      if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
    }
    if (macdSeries.length) {
      macd = macdSeries[macdSeries.length - 1];
      macd_signal = ema(macdSeries, Math.min(9, macdSeries.length));
      if (macd_signal != null) macd_hist = macd - macd_signal;
    }
  }

  // Bollinger %B (20, 2σ)
  const tailBB = closes.slice(-Math.max(20, Math.min(40, closes.length)));
  const sma20 = sma(tailBB, 20);
  const sd20  = stdev(tailBB.slice(-20));
  let bbp = null;
  if (sma20 != null && sd20 != null && sd20 > 0) {
    const upper = sma20 + 2 * sd20;
    const lower = sma20 - 2 * sd20;
    bbp = (last - lower) / (upper - lower);
  }

  return {
    r1, ema_cross, rsi14, vol2h,
    macd_hist, bbp,
    // keep extras for storage/inspection (optional)
    ema5, ema20, sma20, sd20
  };
}

// ---------- v3 heuristic scoring (for comparison) ----------
function scoreToProb(f, debug = false) {
  const W = { r1:80, ema_cross:5, rsi:0.06, macd_hist:3, bbp:0.7, vol_div:0.03, vol_cap:0.5, clip:6 };
  const sat = (x, s = 3) => Math.tanh(x / s);

  const r1_sig   = sat((f.r1 ?? 0) * W.r1);
  const ema_sig  = sat((f.ema_cross ?? 0) * W.ema_cross);
  const rsi_sig  = (typeof f.rsi14 === "number") ? sat((f.rsi14 - 50) * W.rsi) : 0;
  let   macd_sig = sat((f.macd_hist ?? 0) * W.macd_hist);
  const bbp_sig  = (typeof f.bbp === "number") ? sat((f.bbp - 0.5) * 2 * W.bbp) : 0;

  const MACD_CAP = 0.8;
  if (macd_sig >  MACD_CAP) macd_sig =  MACD_CAP;
  if (macd_sig < -MACD_CAP) macd_sig = -MACD_CAP;

  const vol_pen  = (f.vol2h && isFinite(f.vol2h)) ? Math.min(f.vol2h / W.vol_div, W.vol_cap) : 0;

  let raw = r1_sig + ema_sig + rsi_sig + macd_sig + bbp_sig - vol_pen;
  raw = Math.max(-W.clip, Math.min(W.clip, raw));
  const p = Number((1 / (1 + Math.exp(-raw))).toFixed(6));

  if (debug) console.log("scoring components:", { r1_sig, ema_sig, rsi_sig, macd_sig, bbp_sig, vol_pen, raw, p });

  return { p_up: p, raw_score: raw, components: { r1_sig, ema_sig, rsi_sig, macd_sig, bbp_sig, vol_pen } };
}

// ---------- v4 logistic regression (your trained weights) ----------
function safeNumber(x, fallback=0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function predictLogReg(features) {
  const means  = [1.42467183e-04, 9.31440186e-04, 5.17405728e+01, -2.67657268e-01, 5.32486170e-01, 4.59951208e-03];
  const scales = [5.32684168e-03, 8.31257249e-03, 1.21705107e+01, 9.20304426e+01, 3.25832753e-01, 2.68113746e-03];
  const coefs  = [0.05120787, 0.36343205, -0.35128315, 0.09548162, -0.02806779, -0.07244374];
  const intercept = 0.17018936045733382;
  const xs = [
    Number.isFinite(features.r1) ? features.r1 : 0,
    Number.isFinite(features.ema_cross) ? features.ema_cross : 0,
    Number.isFinite(features.rsi14) ? features.rsi14 : 50,
    Number.isFinite(features.macd_hist) ? features.macd_hist : 0,
    Number.isFinite(features.bbp) ? features.bbp : 0.5,
    Number.isFinite(features.vol2h) ? features.vol2h : 0
  ];
  const z = xs.map((v,i)=> (v - means[i]) / (scales[i] || 1e-9));
  const s = Math.max(-10, Math.min(10, z.reduce((acc, v, i)=> acc + v*coefs[i], intercept)));
  return 1 / (1 + Math.exp(-s));
}


// ---------- main per-coin function ----------
async function makePredictionForCoin(coin) {
  const closes = await loadCloses(coin, 240);
  if (!closes || closes.length < 20) return null;

  const f = buildFeatures(closes);
  if (!f) return null;

  // v4 (AI) first
 const p_up_v4 = predictLogReg(f);
await Prediction.create({
  coin,
  horizon: "24h",
  ts: new Date(),
  p_up: p_up_v4,
  prob_up: p_up_v4,  // keep both
  features: f,
  model_ver: "v4-ai-logreg"
});

  
  // v4 + XAU lead nudge (ETH ≈ 8d, BTC ≈ 10d), small & symmetric
try {
  const lag = (coin === "ethereum") ? 8 : 10;     // from your Granger results
  const xauLagRet = await goldRetLag(lag);

  // Size of the nudge (you can change via env XAU_NUDGE=0.12 etc.)
  const NUDGE = Number(process.env.XAU_NUDGE || 0.08);

  let p_adj = p_up_v4;
  if (Number.isFinite(xauLagRet)) {
    // simple signed nudge: up if gold rose over the lag window, down if fell
    const sign = xauLagRet > 0 ? 1 : -1;
    p_adj = clamp01(p_up_v4 + sign * NUDGE);
  }

await Prediction.create({
  coin,
  horizon: "24h",
  ts: new Date(),
  p_up: p_adj,
  prob_up: p_adj,    // keep both
  features: { ...f, xau_ret_lag: xauLagRet, xau_lag_used: lag },
  model_ver: "v4-ai-logreg-xau"
});

} catch (e) {
  console.warn(`[xau-nudge] skipped for ${coin}:`, e?.message || e);
}


  // v3 (heuristic) for comparison
  const { p_up: p_up_v3, raw_score, components } = scoreToProb(f, process.env.PRED_DEBUG === "1");
  const docV3 = await Prediction.create({
    coin,
    horizon: "24h",
    p_up: p_up_v3,
    features: {
      ...f,
      raw_score, components
    },
    model_ver: "v3-macd-bb"
  });

  return { coin, v4: p_up_v4, v3: docV3.p_up };
}

// ---------- runner ----------
(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const tsStart = new Date();
    const out = [];
    for (const c of COINS) {
      const r = await makePredictionForCoin(c);
      if (r) out.push(r);
    }
    console.log(`[${tsStart.toISOString()}] Forecasted v3+v4:`, out);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Forecast error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
