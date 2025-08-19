// jobs/backfill_coingecko.js
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// ---- Config ----
const COINS = [
  { id: "bitcoin",  cg: "bitcoin"  },
  { id: "ethereum", cg: "ethereum" }
];
const DAYS = Number(process.env.COINGECKO_DAYS || 90);  // 1..90
const HORIZON_BARS = 24; // 24h ahead at hourly cadence

// ---- Helpers ----
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchHourlyPrices(coinId, days){
  // CoinGecko: /coins/{id}/market_chart?vs_currency=usd&days=90&interval=hourly
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
  const r = await fetch(url, { headers: { "accept":"application/json" }});
  if (!r.ok) throw new Error(`CoinGecko ${coinId} HTTP ${r.status}`);
  const j = await r.json();
  // j.prices = [[tsMs, price], ...]
  const out = (j?.prices || []).map(([ts, p]) => ({ ts, close: Number(p) }))
                                .filter(x => Number.isFinite(x.close));
  // ensure ascending & dedup
  out.sort((a,b)=>a.ts - b.ts);
  const dedup = [];
  let last = -1;
  for (const x of out) { if (x.ts !== last){ dedup.push(x); last = x.ts; } }
  return dedup;
}

// ---- Indicators (aligned names; hourly windows) ----
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
    const d = close[i] - close[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  gains /= period; losses /= period;
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i] - close[i-1];
    gains = (gains * (period - 1) + (d>0?d:0)) / period;
    losses = (losses * (period - 1) + (d<0?-d:0)) / period;
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

function buildFeatures(closes, i){
  if (i < 30) return null;
  const last = closes[i], prev = closes[i-1];
  const r1 = (last - prev) / prev;

  // hourly EMA5/EMA20 (short/medium trend)
  const ema5  = ema(closes.slice(Math.max(0,i-24), i+1), 5);
  const ema20 = ema(closes.slice(Math.max(0,i-99), i+1), 20);
  const ema_cross = (ema5!=null && ema20!=null && ema20!==0) ? (ema5-ema20)/ema20 : null;

  // RSI14 (hours)
  const rsi14 = rsi(closes.slice(Math.max(0,i-59), i+1), 14);

  // short vol: last 12 hours
  const rets = [];
  const span = Math.min(12, i);
  for (let k = i - span + 1; k <= i; k++){
    if (k<=0) continue;
    rets.push((closes[k]-closes[k-1])/closes[k-1]);
  }
  const vol2h = stdev(rets);

  // MACD(12,26) hist approx with signal(9) over hourly tail
  const tail = closes.slice(Math.max(0, i-119), i+1);
  let macd_hist = null;
  if (tail.length >= 26) {
    const macdSeries = [];
    for (let t = 26; t < tail.length; t++){
      const slice = tail.slice(0, t+1);
      const e12 = ema(slice, 12);
      const e26 = ema(slice, 26);
      if (e12!=null && e26!=null) macdSeries.push(e12 - e26);
    }
    if (macdSeries.length){
      const macd  = macdSeries[macdSeries.length-1];
      const sig   = ema(macdSeries, Math.min(9, macdSeries.length));
      if (sig!=null) macd_hist = macd - sig;
    }
  }

  // Bollinger %B (20, 2σ)
  const windowBB = closes.slice(Math.max(0, i-39), i+1);
  const sma20 = sma(windowBB, 20);
  const sd20  = stdev(windowBB.slice(-20));
  let bbp = null;
  if (sma20!=null && sd20!=null && sd20>0){
    const upper = sma20 + 2*sd20;
    const lower = sma20 - 2*sd20;
    bbp = (last - lower) / (upper - lower);
  }

  return { r1, ema_cross, rsi14, macd_hist, bbp, vol2h };
}

async function backfillCoin(coinId, cgId, col){
  console.log(`[CG] ${coinId} fetching ~${DAYS}d hourly...`);
  const rows = await fetchHourlyPrices(cgId, DAYS);
  const closes = rows.map(r=>r.close);

  console.log(`[CG] ${coinId} got ${rows.length} hours`);
  let batch = [];
  for (let i=30; i + HORIZON_BARS < rows.length; i++){
    const f = buildFeatures(closes, i);
    if (!f) continue;
    const p0 = closes[i];
    const p1 = closes[i + HORIZON_BARS];
    const realized_ret = (p1 - p0)/p0;
    const label_up = realized_ret > 0;

    batch.push({
      coin: coinId,
      ts: new Date(rows[i].ts),
      horizon: "24h",
      r1: f.r1, ema_cross: f.ema_cross, rsi14: f.rsi14,
      macd_hist: f.macd_hist, bbp: f.bbp, vol2h: f.vol2h,
      label_up, realized_ret
    });

    if (batch.length >= 5000){
      await col.insertMany(batch, { ordered:false });
      console.log(`[CG] ${coinId} inserted batch of 5000`);
      batch = [];
      await sleep(150);
    }
  }
  if (batch.length){
    await col.insertMany(batch, { ordered:false });
    console.log(`[CG] ${coinId} inserted final batch ${batch.length}`);
  }
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const col = db.collection("backfill_training");

    if (process.env.BACKFILL_CLEAR === "1"){
      await col.deleteMany({});
      console.log("[CG] cleared existing backfill_training");
    }

    for (const c of COINS){
      await backfillCoin(c.id, c.cg, col);
      await sleep(500); // polite to API
    }

    await mongoose.disconnect();
    console.log("[CG] Done.");
    process.exit(0);
  } catch (e) {
    console.error("CG backfill error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
