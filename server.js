import express from "express";
import mongoose from "mongoose";
import Price from "./models/Price.js";
import Prediction from "./models/Prediction.js";



// Heroku provides env vars automatically.
// Locally, create a .env with MONGO_URI, JWT_SECRET, TIMEZONE.
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const TZ_DISPLAY = process.env.TIMEZONE || "UTC";

const app = express();

// Serve static files (dashboard shell)
app.use(express.static("public"));

// Health endpoint (no secrets)
app.get("/health", (req, res) => {
  const up = process.uptime();
  res.json({
    status: "ok",
    uptime_s: Math.round(up),
    timezone: TZ_DISPLAY,
    mongo_connected: mongoose.connection.readyState === 1
  });
});

// Root → serves /public/index.html
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

// Start server first; connect to Mongo in the background
app.listen(PORT, () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
  if (!MONGO_URI) {
    console.warn("⚠️  MONGO_URI is missing. Set it in Heroku Config Vars.");
    return;
  }
  mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.error("❌ MongoDB connection error:", err.message));
});

import Heartbeat from "./models/Heartbeat.js";

app.get("/api/ping-db", async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok:false, error:"Mongo not connected" });
    const doc = await Heartbeat.create({ note: "hello from heroku" });
    res.json({ ok:true, id: doc._id.toString(), at: doc.ts });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.get("/api/heartbeats", async (_req, res) => {
  try {
    const rows = await Heartbeat.find().sort({ ts:-1 }).limit(5).lean();
    res.json({ ok:true, rows });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/prices/latest", async (req, res) => {
  try {
    const coins = (req.query.coins || "bitcoin,ethereum")
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const results = {};
    for (const c of coins) {
      const row = await Price.findOne({ coin: c }).sort({ ts: -1 }).lean();
      if (row) results[c] = row;
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/predictions/latest", async (req, res) => {
  try {
    const coins = (req.query.coins || "bitcoin,ethereum")
      .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const results = {};
    for (const c of coins) {
      const row = await Prediction.findOne({ coin:c, horizon:"24h" })
        .sort({ ts:-1 }).lean();
      if (row) results[c] = row;
    }
    res.json({ ok:true, results });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
