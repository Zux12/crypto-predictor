import mongoose from "mongoose";
import Price from "../models/Price.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Missing MONGO_URI");
  process.exit(1);
}

// Add coins here using CoinGecko IDs
const COINS = ["bitcoin", "ethereum"]; // add more later (e.g., "binancecoin","solana", ...)

async function fetchPrices() {
  // Node 18+ has global fetch
  const ids = COINS.join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

  const r = await fetch(url, {
    headers: {
      "accept": "application/json",
      // Adding a UA reduces random 403s with some providers
      "user-agent": "cryptopredictor/0.1 (contact: admin@example.com)"
    },
    // CoinGecko is fast, but protect the job from hanging forever
    // No built-in timeout on fetch; keep job short overall
  });

  if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
  return r.json();
}

(async () => {
  const started = new Date();
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });

    const data = await fetchPrices();
    const ts = new Date();

    const docs = [];
    for (const coin of COINS) {
      const price = data?.[coin]?.usd;
      if (typeof price === "number" && Number.isFinite(price)) {
        docs.push({ ts, coin, price, source: "coingecko" });
      }
    }

    if (docs.length) {
      await Price.insertMany(docs, { ordered: false });
      console.log(`[${ts.toISOString()}] Ingested:`, docs);
    } else {
      console.warn("No prices parsed from CoinGecko payload:", data);
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("Ingest error:", e && e.message ? e.message : e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  } finally {
    const elapsed = (new Date() - started) / 1000;
    console.log(`Job finished in ${elapsed.toFixed(1)}s`);
  }
})();
