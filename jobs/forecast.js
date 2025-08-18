import mongoose from "mongoose";
import Price from "../models/Price.js";
import Prediction from "../models/Prediction.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error("Missing MONGO_URI"); process.exit(1); }

const COINS = ["bitcoin","ethereum"];

function sigmoid(x){ return 1/(1+Math.exp(-x)); }

async function makePredictionForCoin(coin){
  const rows = await Price.find({ coin }).sort({ ts:-1 }).limit(2).lean();
  if (rows.length < 2) return null;
  const [latest, prev] = rows;
  const r1 = (latest.price - prev.price) / prev.price;
  const score = r1 * 150;                 // simple scaling for v1
  const p_up = +sigmoid(score).toFixed(4);

  return Prediction.create({
    coin, horizon:"24h", p_up, features:{ r1 }, model_ver:"v1-momentum"
  });
}

(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const tsStart = new Date();
    const out = [];
    for (const c of COINS) {
      const doc = await makePredictionForCoin(c);
      if (doc) out.push({ coin:c, p_up:doc.p_up, r1:doc.features.r1 });
    }
    console.log(`[${tsStart.toISOString()}] Forecasted:`, out);
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Forecast error:", e.message || e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  }
})();
