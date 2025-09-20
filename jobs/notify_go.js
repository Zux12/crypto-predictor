// jobs/notify_go.js
// Improved: flip alerts + heartbeats + robust logging + safe Telegram send

import "dotenv/config";
import mongoose from "mongoose";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";
import mongoosePkg from "mongoose";

// ===== Crash guards / visibility =====
process.on("unhandledRejection", (e) => { console.error("[UNHANDLED]", e); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("[UNCAUGHT]", e); process.exit(1); });

const MONGO_URI = process.env.MONGO_URI;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;

if (!MONGO_URI || !CHAT_ID || !TOKEN) {
  console.error("[BOOT] Missing MONGO_URI or TELEGRAM_* vars");
  process.exit(1);
}

// ===== Config (env-overridable) =====
const COINS = ["bitcoin", "ethereum"];
const MODEL = process.env.MODEL_VER ?? "v4-ai-logreg-xau";

const BUCKET_LO = Number(process.env.BUCKET_LO ?? 0.70);
const BUCKET_HI = Number(process.env.BUCKET_HI ?? 0.75);

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 7);
const LOOKBACK_MS   = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

const MIN_N = Number(process.env.MIN_N ?? 50);

const HEARTBEATS     = String(process.env.HEARTBEATS ?? "on").toLowerCase() === "on";
const HEARTBEAT_MODE = String(process.env.HEARTBEAT_MODE ?? "tenmin").toLowerCase(); // 'tenmin' | 'hourly'
const QUIET_HOURS    = process.env.QUIET_HOURS ?? ""; // e.g. "01:00-07:00" (MYT)

// ===== Helpers =====
function mytDate(d) { // "YYYY-MM-DD HH:mm" in MYT (+08:00, no DST)
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
}

function inQuietHours(nowUtc, quietSpec) {
  if (!quietSpec) return false;
  // Parse "HH:MM-HH:MM" in MYT
  const m = quietSpec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const [ , h1, m1, h2, m2 ] = m.map(Number);
  const nowMyt = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
  const curMin = nowMyt.getHours() * 60 + nowMyt.getMinutes();
  const a = h1 * 60 + m1, b = h2 * 60 + m2;
  if (a <= b) return curMin >= a && curMin < b;       // same day
  return curMin >= a || curMin < b;                   // crosses midnight
}

async function bucketOK(coin) {
  const since = new Date(Date.now() - LOOKBACK_MS);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: { from: "predictions", localField: "pred_id", foreignField: "_id", as: "pred" } },
    { $unwind: "$pred" },
    { $match: { "pred.model_ver": MODEL, "pred.coin": coin, "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI } } },
    { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$realized_ret" } } }
  ]);
  const d = rows[0] || { n: 0, avg: null };
  const ok = (d.n >= MIN_N) && (d.avg != null && d.avg >= 0);
  return { ok, n: d.n, avg: d.avg ?? null };
}

async function latest(coin) {
  // newest by ts for the given MODEL/coin
  return await Prediction.findOne({ coin, model_ver: MODEL }).sort({ ts: -1 }).lean();
}

// Minimal GoState model (extendable without breaking older docs)
const GoState = mongoosePkg.models.GoState || mongoosePkg.model("GoState", new mongoosePkg.Schema({
  coin: { type: String, unique: true },
  state: String,          // "GO" | "NO_GO"
  reason: String,         // human readable
  p_up: Number,           // convenience: last p_up
  pred_ts: Date,
  last_sent_type: String, // 'flip' | 'heartbeat'
  last_sent_at: { type: Date, default: null },
  updated_at: { type: Date, default: Date.now }
}));

async function tgSend(text) {
  // Use global fetch if available; otherwise lazy import node-fetch
  const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text,
    disable_web_page_preview: true
    // No parse_mode → safest (plain text)
    // If you really want formatting, switch to parse_mode:"HTML" and keep it simple.
  };
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    console.error("[TG ERROR]", res.status, JSON.stringify(json));
    throw new Error(json.description || `telegram send failed (${res.status})`);
  }
  console.log("[TG OK] message_id", json.result?.message_id);
  return json;
}

function bucketLabel() {
  // e.g. 0.70–0.75 → "70–74%" (upper bound exclusive)
  const lo = Math.round(BUCKET_LO * 100);
  const hi = Math.round(BUCKET_HI * 100) - 1;
  return `${lo}–${hi}%`;
}

function shouldSendHeartbeat(nowUtc) {
  if (!HEARTBEATS) return false;
  if (inQuietHours(nowUtc, QUIET_HOURS)) return false;
  if (HEARTBEAT_MODE === "hourly") {
    const nowMyt = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
    return nowMyt.getMinutes() === 0; // only at :00 MYT
  }
  // default: every run (tenmin)
  return true;
}

// ===== Main =====
(async () => {
  console.log("[BOOT]", new Date().toISOString(), {
    MODEL, BUCKET_LO, BUCKET_HI, LOOKBACK_DAYS, MIN_N, HEARTBEATS, HEARTBEAT_MODE, QUIET_HOURS
  });

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("[MONGO] connected");

  const now = new Date();

  for (const coin of COINS) {
    const pred = await latest(coin);
    if (!pred) {
      console.warn(`[SKIP] No prediction for ${coin} MODEL=${MODEL}`);
      continue;
    }

    const p = Number(pred.p_up ?? pred.prob_up ?? 0);
    const inBucket = p >= BUCKET_LO && p < BUCKET_HI;
    const b = await bucketOK(coin);
    const state = (inBucket && b.ok) ? "GO" : "NO_GO";

    console.log(`[EVAL] ${coin} ts=${pred.ts?.toISOString?.() ?? "?"} p=${(p*100).toFixed(1)} inBucket=${inBucket} bucketOK=${b.ok} n=${b.n} avg=${b.avg}`);

    const prev = await GoState.findOne({ coin }).lean();
    const stateChanged = !prev || prev.state !== state;

    const entryUntil = mytDate(new Date(pred.ts.getTime() + 60 * 60 * 1000));
    const exitBy     = mytDate(new Date(pred.ts.getTime() + 24 * 60 * 60 * 1000));
    const avgStr     = (b.avg == null) ? "—" : `${b.avg >= 0 ? "+" : ""}${(b.avg * 100).toFixed(2)}%`;
    const reason     = `p_up=${(p * 100).toFixed(1)}% • 7d(${bucketLabel()}) ${avgStr} (n=${b.n})`;

    const head      = coin.toUpperCase() + ": " + (state === "GO" ? "🟢 GO" : "🔴 NO-GO") + " — " + reason;
    const windowTxt = state === "GO"
      ? `\nEntry until ${entryUntil} MYT\nExit by ${exitBy} MYT`
      : "";

    if (stateChanged) {
      const msg = head + windowTxt;
      console.log("[SEND] flip alert →", coin, state);
      await tgSend(msg);
      await GoState.updateOne(
        { coin },
        { $set: { state, reason, p_up: p, pred_ts: pred.ts, last_sent_type: "flip", last_sent_at: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } else if (shouldSendHeartbeat(now)) {
      // Minimal heartbeat snapshot (keeps it useful but not spammy)
      const snapshot = `⏱️ Snapshot ${mytDate(now)} MYT\n` + head;
      console.log("[SEND] heartbeat →", coin);
      await tgSend(snapshot);
      await GoState.updateOne(
        { coin },
        { $set: { reason, p_up: p, pred_ts: pred.ts, last_sent_type: "heartbeat", last_sent_at: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } else {
      console.log("[SKIP] no flip & heartbeat suppressed (quiet hours / mode) →", coin);
    }
  }

  await mongoose.disconnect();
  console.log("[DONE]");
  process.exit(0);
})().catch(async (e) => {
  console.error("[FATAL]", e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
