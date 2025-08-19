import express from "express";
import mongoose from "mongoose";
import Price from "./models/Price.js";
import Prediction from "./models/Prediction.js";
import PaperState from "./models/PaperState.js";
import PaperTrade from "./models/PaperTrade.js";
import Equity from "./models/Equity.js";

// At top if needed:
// import Label from "./models/Label.js";
// import Prediction from "./models/Prediction.js";

app.get("/api/scores/by_model", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "30", 10));
    const since = new Date(Date.now() - days*24*60*60*1000);

    const rows = await Label.aggregate([
      { $match: { pred_ts: { $gte: since } } },
      { $lookup: { from: "predictions", localField: "pred_id", foreignField: "_id", as: "pred" } },
      { $unwind: "$pred" },
      { $group: {
          _id: "$pred.model_ver",
          n: { $sum: 1 },
          accuracy: { $avg: { $cond: ["$correct", 1, 0] } },
          brier: { $avg: "$brier" }
      }},
      { $project: { _id: 0, model_ver: "$_id", n:1, accuracy:{ $round:["$accuracy",4] }, brier:{ $round:["$brier",6] } } },
      { $sort: { model_ver: 1 } }
    ]);

    res.json({ ok:true, days, rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});


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

import Label from "./models/Label.js";

app.get("/api/scores/summary", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "7", 10)); // last 7 days by default
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const pipe = [
      { $match: { pred_ts: { $gte: since } } },
      { $group: {
          _id: "$coin",
          n: { $sum: 1 },
          acc: { $avg: { $cond: ["$correct", 1, 0] } },
          brier: { $avg: "$brier" }
      }},
      { $project: {
          _id: 0, coin: "$_id",
          n: 1,
          accuracy: { $round: ["$acc", 4] },
          brier: { $round: ["$brier", 6] }
      }},
      { $sort: { coin: 1 } }
    ];

    const byCoin = await Label.aggregate(pipe);
    const overallAgg = await Label.aggregate([
      { $match: { pred_ts: { $gte: since } } },
      { $group: {
          _id: null,
          n: { $sum: 1 },
          acc: { $avg: { $cond: ["$correct", 1, 0] } },
          brier: { $avg: "$brier" }
      }},
      { $project: {
          _id: 0,
          n: 1,
          accuracy: { $round: ["$acc", 4] },
          brier: { $round: ["$brier", 6] }
      }}
    ]);

    res.json({ ok: true, window_days: days, overall: overallAgg[0] || null, byCoin });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get("/api/paper/summary", async (_req, res) => {
  try {
    const s = await PaperState.findById("default").lean();
    if (!s) return res.json({ ok: true, state: null });
    res.json({
      ok: true,
      state: {
        cash_usd: s.cash_usd,
        equity_usd: s.equity_usd,
        holdings: s.holdings,
        params: s.params,
        updated_at: s.updated_at
      }
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/paper/trades", async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit || "50", 10));
    const rows = await PaperTrade.find().sort({ ts: -1 }).limit(limit).lean();
    res.json({ ok:true, rows });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/paper/equity", async (req, res) => {
  try {
    const limit = Math.min(1000, parseInt(req.query.limit || "200", 10));
    const rows = await Equity.find().sort({ ts: -1 }).limit(limit).lean();
    res.json({ ok:true, rows: rows.reverse() }); // chronological
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// --- Monitoring APIs ---
// 1) Calibration: bucket predictions by p_up and compare average predicted prob vs. realized frequency
app.get("/api/scores/calibration", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "30", 10));
    const bins = Math.min(50, Math.max(5, parseInt(req.query.bins || "10", 10)));
    const coin = (req.query.coin || "all").toLowerCase();
    const since = new Date(Date.now() - days*24*60*60*1000);

    const match = { pred_ts: { $gte: since } };
    if (coin !== "all") match.coin = coin;

    // place predictions into equal-probability-width bins
    const pipe = [
      { $match: match },
      { $project: {
          coin: 1,
          p_up: 1,
          label_up: 1
      }},
      { $addFields: {
          bin: {
            $let: {
              vars: { b: { $floor: { $multiply: ["$p_up", bins] } } },
              in: { $min: [ { $max: [ "$$b", 0 ] }, bins - 1 ] }
            }
          }
      }},
      { $group: {
          _id: "$bin",
          n: { $sum: 1 },
          avg_pred: { $avg: "$p_up" },
          avg_real: { $avg: { $cond: ["$label_up", 1, 0] } }
      }},
      { $project: {
          _id: 0,
          bin: "$_id",
          n: 1,
          avg_pred: { $round: ["$avg_pred", 4] },
          avg_real: { $round: ["$avg_real", 4] }
      }},
      { $sort: { bin: 1 } }
    ];

    const rows = await Label.aggregate(pipe);
    res.json({ ok: true, bins, days, coin, rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// 2) Accuracy trend bucketed by day/hour
app.get("/api/scores/accuracy_trend", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "30", 10));
    const bucket = (req.query.bucket || "day").toLowerCase(); // "day" or "hour"
    const coin = (req.query.coin || "all").toLowerCase();
    const since = new Date(Date.now() - days*24*60*60*1000);

    const match = { pred_ts: { $gte: since } };
    if (coin !== "all") match.coin = coin;

    const dateFields = bucket === "hour"
      ? { y: { $year: "$pred_ts" }, m: { $month: "$pred_ts" }, d: { $dayOfMonth: "$pred_ts" }, h: { $hour: "$pred_ts" } }
      : { y: { $year: "$pred_ts" }, m: { $month: "$pred_ts" }, d: { $dayOfMonth: "$pred_ts" } };

    const groupId = bucket === "hour"
      ? { y: "$y", m: "$m", d: "$d", h: "$h" }
      : { y: "$y", m: "$m", d: "$d" };

    const pipe = [
      { $match: match },
      { $addFields: dateFields },
      { $group: {
          _id: groupId,
          n: { $sum: 1 },
          acc: { $avg: { $cond: ["$correct", 1, 0] } }
      }},
      { $project: {
          _id: 0,
          y: "$_id.y", m: "$_id.m", d: "$_id.d",
          h: bucket === "hour" ? "$_id.h" : null,
          n: 1,
          accuracy: { $round: ["$acc", 4] }
      }},
      { $sort: { y:1, m:1, d:1, h:1 } }
    ];

    const rows = await Label.aggregate(pipe);
    res.json({ ok: true, days, bucket, coin, rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// 3) Brier trend bucketed by day/hour
app.get("/api/scores/brier_trend", async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days || "30", 10));
    const bucket = (req.query.bucket || "day").toLowerCase();
    const coin = (req.query.coin || "all").toLowerCase();
    const since = new Date(Date.now() - days*24*60*60*1000);

    const match = { pred_ts: { $gte: since } };
    if (coin !== "all") match.coin = coin;

    const dateFields = bucket === "hour"
      ? { y: { $year: "$pred_ts" }, m: { $month: "$pred_ts" }, d: { $dayOfMonth: "$pred_ts" }, h: { $hour: "$pred_ts" } }
      : { y: { $year: "$pred_ts" }, m: { $month: "$pred_ts" }, d: { $dayOfMonth: "$pred_ts" } };

    const groupId = bucket === "hour"
      ? { y: "$y", m: "$m", d: "$d", h: "$h" }
      : { y: "$y", m: "$m", d: "$d" };

    const pipe = [
      { $match: match },
      { $addFields: dateFields },
      { $group: {
          _id: groupId,
          n: { $sum: 1 },
          brier: { $avg: "$brier" }
      }},
      { $project: {
          _id: 0,
          y: "$_id.y", m: "$_id.m", d: "$_id.d",
          h: bucket === "hour" ? "$_id.h" : null,
          n: 1,
          brier: { $round: ["$brier", 6] }
      }},
      { $sort: { y:1, m:1, d:1, h:1 } }
    ];

    const rows = await Label.aggregate(pipe);
    res.json({ ok: true, days, bucket, coin, rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get("/api/predictions/inspect", async (req, res) => {
  try {
    const coins = (req.query.coins || "bitcoin,ethereum")
      .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const results = {};
    for (const c of coins) {
      const row = await Prediction.findOne({ coin: c, horizon: "24h" })
        .sort({ ts: -1 }).lean();
      if (row) {
        results[c] = {
          ts: row.ts, p_up: row.p_up, model_ver: row.model_ver,
          components: row.features?.components || null,
          core: {
            r1: row.features?.r1 ?? null,
            ema_cross: row.features?.ema_cross ?? null,
            rsi14: row.features?.rsi14 ?? null,
            macd_hist: row.features?.macd_hist ?? null,
            bbp: row.features?.bbp ?? null,
            vol2h: row.features?.vol2h ?? null
          }
        };
      }
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Debug: last N labels (default 5)
app.get("/api/debug/labels", async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit || "5", 10));
    const rows = await Label.find({})
      .sort({ pred_ts: -1 })
      .limit(limit)
      .lean();
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Debug: matured predictions waiting for label
app.get("/api/debug/matured", async (req, res) => {
  try {
    const HORIZON_MS = 24 * 60 * 60 * 1000;
    const GRACE_MS   = 2 * 60 * 1000;
    const cutoff = new Date(Date.now() - HORIZON_MS - GRACE_MS);

    const rows = await Prediction.find({
      ts: { $lte: cutoff },
      $or: [ { labeled_at: { $exists: false } }, { labeled_at: null } ]
    })
    .sort({ ts: -1 })
    .limit(10)
    .lean();

    res.json({ ok: true, count: rows.length, sample: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
