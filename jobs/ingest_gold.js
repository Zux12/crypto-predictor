// jobs/ingest_gold.js
import 'dotenv/config';
import mongoose from 'mongoose';
import yahooFinance from 'yahoo-finance2';
import Price from '../models/Price.js';

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI missing');
  await mongoose.connect(uri, { dbName: process.env.MONGO_DB || 'cryptopredictor' });

  // Try Gold spot first, fallback to futures if needed
  let symbol = 'XAUUSD=X'; // Gold spot
  let q;
  try {
    q = await yahooFinance.quote(symbol);
    if (!q || !q.regularMarketPrice) throw new Error('no spot quote');
  } catch {
    symbol = 'GC=F'; // COMEX Gold futures
    q = await yahooFinance.quote(symbol);
  }

  const price = Number(q.regularMarketPrice ?? q.previousClose);
  if (!Number.isFinite(price)) throw new Error('bad price');

  await Price.create({
    coin: 'gold',
    ts: new Date(),
    price
  });

  console.log(`[gold] stored ${price} from ${symbol}`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
