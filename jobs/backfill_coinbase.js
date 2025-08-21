// jobs/backfill_coinbase.js
import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// ---- Config ----
const PRODUCTS = [
  { coin: "bitcoin",  product: "BTC-USD" },
  { coin: "ethereum", product: "ETH-USD" }
];
// how many days of hourly candles to fetch (default 90)
const CB_DAYS = Number(process.env.CB_DAYS || 90);

// 1-hour cadence => 24 bars for +24h lookahead
const HORIZON_BARS = 24;

// ---- Helpers ----
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function toISO(ms){ return new Date(ms).toISOString(); }

// Coinbase OHLC endpoint (public, no key)
// GET /products/{product_id}/candles?granularity=3600&start=...&end=...
// returns [[time, low, high, open, close, volume], ...]
async function fetchHourly(product, startMs, endMs) {
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=3600&start=${toISO(startMs)}&end=${toISO(endMs)}`;
  const r = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "cryptopredictor/0.1"
    }
  });
  if (!r.ok) throw new Error(`Coinbase ${product} HTTP ${r.status}`);
  const arr = await r.json();
  // normalize -> { ts: ms, close: number }
  const out = (Array.isArray(arr) ? arr : []).map(a => ({
    ts: Number(a[0]) * 1000,
    close: Number(a[4])
  })).filter(x => Number.isFinite(x.close));
  // ensure ascending + dedupe
  out.sort((a,b)=>a.ts - b.ts);
  const dedup = [];
  let last = -1;
  for (const x of out) { if (x.ts !== last) { dedup.push(x); last = x.ts; } }
  return dedup;
}

// Indicators (hourly versions; same names as live features)
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

  const ema5  = ema(closes.slice(Math.max(0,i-24), i+1), 5);
  const ema20 = ema(closes.slice(Math.max(0,i-99), i+1), 20);
  const ema_cross = (ema5!=null && ema20!=null && ema20!==0) ? (ema5-ema20)/ema20 : null;

  const rsi14 = rsi(closes.slice(Math.max(0,i-59), i+1), 14);

  const rets = [];
  const span = Math.min(12, i);
  for (let k = i - span + 1; k <= i; k++){
    if (k<=0) continue;
    rets.push((closes[k]-closes[k-1])/closes[k-1]);
  }
  const vol2h = stdev(rets);

  // MACD hist approx (12,26,9)
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

async function backfillProduct({ coin, product }, col){
  // We’ll fetch in safe 10‑day windows (<= 240 hourly candles per call)
  const now = Date.now();
  const startMs = now - CB_DAYS * 24 * 60 * 60 * 1000;
  const chunk = 10 * 24 * 60 * 60 * 1000;

  console.log(`[CB] ${coin} fetching ~${CB_DAYS}d hourly...`);
  const bars = [];

  for (let cursor = startMs; cursor < now; cursor += chunk){
    const end = Math.min(now, cursor + chunk - 1);
    try {
      const page = await fetchHourly(product, cursor, end);
      bars.push(...page);
      await sleep(150); // polite throttle
    } catch (e) {
      console.warn(`[CB] ${coin} window ${toISO(cursor)} → ${toISO(end)} failed: ${e.message}`);
      await sleep(400);
    }
  }

  // ensure ascending + dedupe again
  bars.sort((a,b)=>a.ts - b.ts);
  const uniq = [];
  let lastTs = -1;
  for (const b of bars){ if (b.ts !== lastTs){ uniq.push(b); lastTs = b.ts; } }

  console.log(`[CB] ${coin} got ${uniq.length} hours`);

  const closes = uniq.map(r=>r.close);
  let batch = [];
  for (let i=30; i + HORIZON_BARS < uniq.length; i++){
    const f = buildFeatures(closes, i);
    if (!f) continue;
    const p0 = closes[i];
    const p1 = closes[i + HORIZON_BARS];
    const realized_ret = (p1 - p0)/p0;
    const label_up = realized_ret > 0;

    batch.push({
      coin,
      ts: new Date(uniq[i].ts),
      horizon: "24h",
      r1: f.r1, ema_cross: f.ema_cross, rsi14: f.rsi14,
      macd_hist: f.macd_hist, bbp: f.bbp, vol2h: f.vol2h,
      label_up, realized_ret
    });

    if (batch.length >= 5000){
      await col.insertMany(batch, { ordered:false });
      console.log(`[CB] ${coin} inserted batch of 5000`);
      batch = [];
    }
  }
  if (batch.length){
    await col.insertMany(batch, { ordered:false });
    console.log(`[CB] ${coin} inserted final batch ${batch.length}`);
  }
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const col = db.collection("backfill_training");

    if (process.env.BACKFILL_CLEAR === "1"){
      await col.deleteMany({});
      console.log("[CB] cleared existing backfill_training");
    }

    for (const p of PRODUCTS){
      await backfillProduct(p, col);
    }

    await mongoose.disconnect();
    console.log("[CB] Done.");
    process.exit(0);
  } catch (e) {
    console.error("CB backfill error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
