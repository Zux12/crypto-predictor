// jobs/notify_go.js  — 24h GO/NO-GO + 10-min snapshot with Micro status line
import "dotenv/config";
import mongoose from "mongoose";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";
import { logInference } from "./inferenceLogger.js";


// ===== Crash guards (keep process visible, but don’t hang) =====
process.on("unhandledRejection", (e) => { console.error("[UNHANDLED]", e); process.exit(1); });
process.on("uncaughtException",  (e) => { console.error("[UNCAUGHT]",  e); process.exit(1); });

// ===== Env =====
const MONGO_URI = process.env.MONGO_URI;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;

// ===== 24h Config =====
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

// ===== Micro (for snapshot line ONLY; trading/push handled by notify_micro.js) =====
const APP_BASE = process.env.APP_BASE_URL || "https://crypto-predictor25-39d642d53c5b.herokuapp.com";
const MICRO_P   = process.env.MICRO_P   || "0.55";
const MICRO_B   = process.env.MICRO_B   || "-0.001";
const MICRO_W   = process.env.MICRO_W   || "30";
const MICRO_RSI = process.env.MICRO_RSI || "35";
const MICRO_BBK = process.env.MICRO_BBK || "1.5";
const MICRO_TP  = process.env.MICRO_TP  || "0.003";
const MICRO_SL  = process.env.MICRO_SL  || "0.002";
const MICRO_HOLD= process.env.MICRO_HOLD|| "2";

// ===== Helpers =====
function mytDate(d) { // "YYYY-MM-DD HH:mm" in MYT (+08:00)
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 16).replace("T", " ");
}
function inQuietHours(nowUtc, quietSpec) {
  if (!quietSpec) return false;
  const m = quietSpec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return false;
  const [ , h1, m1, h2, m2 ] = m.map(Number);
  const nowMyt = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
  const curMin = nowMyt.getHours() * 60 + nowMyt.getMinutes();
  const a = h1 * 60 + m1, b = h2 * 60 + m2;
  return a <= b ? (curMin >= a && curMin < b) : (curMin >= a || curMin < b);
}
function shouldSendHeartbeat(nowUtc) {
  if (!HEARTBEATS) return false;
  if (inQuietHours(nowUtc, QUIET_HOURS)) return false;
  if (HEARTBEAT_MODE === "hourly") {
    const nowMyt = new Date(nowUtc.getTime() + 8 * 60 * 60 * 1000);
    return nowMyt.getMinutes() === 0; // only at :00 MYT
  }
  // default: every run (e.g., Scheduler every 10m)
  return true;
}

// ===== Telegram =====
async function tgSend(text) {
  const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = { chat_id: CHAT_ID, text, disable_web_page_preview: true };
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

// ===== Models used by this job =====
const GoState = mongoose.models.GoState || mongoose.model("GoState", new mongoose.Schema({
  coin: { type: String, unique: true },
  state: String,          // "GO" | "NO_GO"
  reason: String,         // human readable
  p_up: Number,           // convenience: last p_up
  pred_ts: Date,
  last_sent_type: String, // 'flip' | 'heartbeat'
  last_sent_at: { type: Date, default: null },
  updated_at: { type: Date, default: Date.now }
}));

// ===== 24h logic =====
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
async function latestPrediction(coin) {
  return Prediction.findOne({ coin, model_ver: MODEL }).sort({ ts: -1 }).lean();
}
function bucketLabel() {
  // e.g. 0.70–0.75 → "70–74%" (upper bound exclusive)
  const lo = Math.round(BUCKET_LO * 100);
  const hi = Math.round(BUCKET_HI * 100) - 1;
  return `${lo}–${hi}%`;
}

// ===== Micro snapshot helpers (absolute URL + safe fetch) =====
async function fetchMicroSignalsSafe() {
  try {
    const q = new URLSearchParams({
      coins: COINS.join(","),
      p: MICRO_P, b: MICRO_B, w: MICRO_W, rsi: MICRO_RSI, mode: "flip",
      bbk: MICRO_BBK, tp: MICRO_TP, sl: MICRO_SL, hold: MICRO_HOLD
    }).toString();
    const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
    const url = `${APP_BASE}/api/combined/signal?${q}`;
    const res = await fetchFn(url, { cache: "no-store" });
    const js  = await res.json().catch(() => ({}));
    const map = {};
    (js.signals || []).forEach(s => map[s.coin] = s);
    return map; // { bitcoin: sig, ethereum: sig }
  } catch (e) {
    console.error("[micro-snapshot] fetch failed:", e?.message || e);
    return {};
  }
}
function fmtMicroLine(sig) {
  if (!sig || !sig.available) return "• Micro: —";
  if (sig.combined)
    return `• Micro: ⚡ BUY — TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h\n  Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt}`;
  if (sig.standby && !sig.dip)
    return "• Micro: 🟡 Standby (near flip) — watching ±30m";
  if (sig.v4 && !sig.dip)
    return "• Micro: 👀 Watch (v4 OK) — waiting flip-dip (±30m)";
  return "• Micro: —";
}

// ===== Main =====
(async () => {
  console.log("[BOOT]", new Date().toISOString(), {
    MODEL, BUCKET_LO, BUCKET_HI, LOOKBACK_DAYS, MIN_N, HEARTBEATS, HEARTBEAT_MODE, QUIET_HOURS
  });

  if (!MONGO_URI || !CHAT_ID || !TOKEN) {
    console.error("[BOOT] Missing MONGO_URI or TELEGRAM_* vars");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("[MONGO] connected");

  const now = new Date();

  // Fetch Micro signals ONCE per job run (used for snapshot line)
  const microMap = await fetchMicroSignalsSafe();

  for (const coin of COINS) {
    const pred = await latestPrediction(coin);
    if (!pred) {
      console.warn(`[SKIP] No prediction for ${coin} MODEL=${MODEL}`);
      continue;
    }

    const p = Number(pred.p_up ?? pred.prob_up ?? 0);
    const inBucket = p >= BUCKET_LO && p < BUCKET_HI;
    const b = await bucketOK(coin);
    const state = (inBucket && b.ok) ? "GO" : "NO_GO";

    const entryUntil = mytDate(new Date(pred.ts.getTime() + 60 * 60 * 1000));
    const exitBy     = mytDate(new Date(pred.ts.getTime() + 24 * 60 * 60 * 1000));
    const avgStr     = (b.avg == null) ? "—" : `${b.avg >= 0 ? "+" : ""}${(b.avg * 100).toFixed(2)}%`;
    const reason     = `p_up=${(p * 100).toFixed(1)}% • 7d(${bucketLabel()}) ${avgStr} (n=${b.n})`;
    
    
    // ——— Log a fresh inference so Micro API sees the same (live) p_up/n/bucket ———
try {
  await logInference({
    ts: new Date(),
    pred_ts: pred.ts,
    coin,
    model: MODEL,
    p_up: p,           // 0..1
    n: b.n,            // sample count used in your reason
    bucket7d: b.avg,   // decimal (e.g., 0.0046 for +0.46%)
    decision: state,   // "GO" | "NO_GO"
    reason             // same debug string used in the snapshot
  });
} catch (e) {
  console.error("[inference log] failed:", e?.message || e);
}


    const head = `${coin.toUpperCase()}: ${state==="GO" ? "🟢 GO" : "🔴 NO-GO"} — ${reason}`;
    const windowTxt  = state==="GO" ? `\nEntry until ${entryUntil} MYT\nExit by ${exitBy} MYT` : "";

    const prev = await GoState.findOne({ coin }).lean();
    const stateChanged = !prev || prev.state !== state;

    if (stateChanged) {
      const flipMsg = head + windowTxt;
      console.log("[SEND] flip alert →", coin, state);
      await tgSend(flipMsg);
      await GoState.updateOne(
        { coin },
        { $set: { state, reason, p_up: p, pred_ts: pred.ts, last_sent_type: "flip", last_sent_at: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } else if (shouldSendHeartbeat(now)) {
      // Build the 10-min snapshot with a Micro status line
      const sig = microMap[coin]; // may be undefined → handled by fmtMicroLine
      const snapshot =
        `⏱️ Snapshot ${mytDate(now)} MYT\n` +
        head + "\n" +
        fmtMicroLine(sig) + "\n";

      console.log("[SEND] heartbeat →", coin);
      await tgSend(snapshot);
      await GoState.updateOne(
        { coin },
        { $set: { reason, p_up: p, pred_ts: pred.ts, last_sent_type: "heartbeat", last_sent_at: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } else {
      console.log("[SKIP] no flip & heartbeat suppressed →", coin);
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
