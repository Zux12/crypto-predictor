import mongoose from "mongoose";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

// --------- CONFIG ---------
const COINS = [
  { coin: "bitcoin",  symbol: "BTCUSDT" },
  { coin: "ethereum", symbol: "ETHUSDT" },
];
const INTERVAL_MIN = 10;                         // 10-minute bars
const HORIZON_BARS = Math.round(24 * 60 / INTERVAL_MIN); // 24h ahead = 144 bars
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 60); // change if you like

// Binance kline endpoint (public)
const BAPI = "https://api.binance.com/api/v3/klines";
// Binance limit max 1000 per request; we’ll page by startTime
const MAX_LIMIT = 1000;

// ---------- math helpers (copy from forecast) ----------
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

// ---------- feature builder (aligned with v3) ----------
function buildFeaturesFromCloses(closes, i /* index of bar to compute on */) {
  // Need enough history behind i for indicators
  if (i < 30) return null;

  const last = closes[i];
  const prev = closes[i-1];
  const r1 = (last - prev) / prev;

  // EMA cross
  const tailEma5  = closes.slice(Math.max(0, i-24), i+1);
  const tailEma20 = closes.slice(Math.max(0, i-99), i+1);
  const ema5  = ema(tailEma5, 5);
  const ema20 = ema(tailEma20, 20);
  const ema_cross = (ema5 != null && ema20 != null && ema20 !== 0) ? (ema5 - ema20) / ema20 : null;

  // RSI14
  const tailRsi = closes.slice(Math.max(0, i-59), i+1);
  const rsi14 = rsi(tailRsi, 14);

  // short vol: last 12 returns
  const rets = [];
  const span = Math.min(12, i);
  for (let k = i - span + 1; k <= i; k++) {
    if (k <= 0) continue;
    rets.push((closes[k] - closes[k-1]) / closes[k-1]);
  }
  const vol2h = stdev(rets);

  // MACD(12,26) + signal(9) approximated on tail
  const tailMacd = closes.slice(Math.max(0, i-119), i+1);
  let macd_hist = null;
  if (tailMacd.length >= 26) {
    const macdSeries = [];
    for (let t = 26; t < tailMacd.length; t++) {
      const slice = tailMacd.slice(0, t+1);
      const e12 = ema(slice, 12);
      const e26 = ema(slice, 26);
      if (e12 != null && e26 != null) macdSeries.push(e12 - e26);
    }
    if (macdSeries.length) {
      const macd  = macdSeries[macdSeries.length - 1];
      const sig   = ema(macdSeries, Math.min(9, macdSeries.length));
      if (sig != null) macd_hist = macd - sig;
    }
  }

  // Bollinger %B (20, 2σ)
  const tailBB = closes.slice(Math.max(0, i-39), i+1);
  const sma20 = sma(tailBB, 20);
  const sd20  = stdev(tailBB.slice(-20));
  let bbp = null;
  if (sma20 != null && sd20 != null && sd20 > 0) {
    const upper = sma20 + 2 * sd20;
    const lower = sma20 - 2 * sd20;
    bbp = (last - lower) / (upper - lower);
  }

  return { r1, ema_cross, rsi14, macd_hist, bbp, vol2h };
}

// ---------- fetch 10-min klines from Binance over a time range ----------
async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchKlines10m(symbol, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const NOW = endMs || Date.now();

  while (cursor < NOW) {
    const url = `${BAPI}?symbol=${symbol}&interval=10m&limit=${MAX_LIMIT}&startTime=${cursor}`;
    let r, arr;

    // basic retry (3 tries) in case of transient 4xx/5xx
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await fetch(url, { headers: { "accept": "application/json" } });
      if (r.ok) break;
      if (attempt < 3) await sleep(300 * attempt);
    }
    if (!r.ok) throw new Error(`Binance ${symbol} HTTP ${r.status}`);

    arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;

    // arr[i] = [ openTime, open, high, low, close, volume, closeTime, ... ]
    for (const k of arr) {
      const close = Number(k[4]);
      const closeTime = Number(k[6]);          // ms
      out.push({ ts: closeTime, close });
    }

    // advance cursor using **last closeTime** + 1ms
    const lastClose = Number(arr[arr.length - 1][6]);
    const nextCursor = lastClose + 1;

    // stop if Binance gave us stale page
    if (nextCursor <= cursor) break;
    cursor = nextCursor;

    // be polite; avoid 429
    await sleep(120);
  }

  // sort + dedupe
  out.sort((a,b)=>a.ts - b.ts);
  const dedup = [];
  let lastTs = -1;
  for (const x of out) {
    if (x.ts !== lastTs) dedup.push(x), lastTs = x.ts;
  }
  return dedup;
}


async function backfillCoin(coin, symbol, col) {
  const now = Date.now();
  const startMs = now - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
  console.log(`[BF] ${coin} fetching ~${BACKFILL_DAYS}d of 10m candles...`);
  const rows = await fetchKlines10m(symbol, startMs, now);
  const closes = rows.map(r => r.close);

  console.log(`[BF] ${coin} got ${rows.length} bars`);

  const docs = [];
  for (let i = 30; i + HORIZON_BARS < rows.length; i++) {
    const f = buildFeaturesFromCloses(closes, i);
    if (!f) continue;
    const p0 = closes[i];
    const p1 = closes[i + HORIZON_BARS];
    const realized_ret = (p1 - p0) / p0;
    const label_up = realized_ret > 0;

    docs.push({
      coin,
      ts: new Date(rows[i].ts),
      horizon: "24h",
      r1: f.r1,
      ema_cross: f.ema_cross,
      rsi14: f.rsi14,
      macd_hist: f.macd_hist,
      bbp: f.bbp,
      vol2h: f.vol2h,
      label_up,
      realized_ret
    });

    // batch insert every 5k to keep memory low
    if (docs.length >= 5000) {
      await col.insertMany(docs, { ordered: false });
      console.log(`[BF] ${coin} inserted batch of 5000`);
      docs.length = 0;
    }
  }
  if (docs.length) {
    await col.insertMany(docs, { ordered: false });
    console.log(`[BF] ${coin} inserted final batch of ${docs.length}`);
  }
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const col = db.collection("backfill_training");

    // optional: clear previous backfill for a clean run
    if (process.env.BACKFILL_CLEAR === "1") {
      await col.deleteMany({});
      console.log("[BF] cleared existing backfill_training");
    }

    for (const { coin, symbol } of COINS) {
      await backfillCoin(coin, symbol, col);
    }

    await mongoose.disconnect();
    console.log("[BF] Done.");
    process.exit(0);
  } catch (e) {
    console.error("Backfill error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
