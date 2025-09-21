import "dotenv/config";
import mongoose from "mongoose";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";
import { logInference } from "./inferenceLogger.js";

// ===== Crash guards =====
process.on("unhandledRejection", e => { console.error("[UNHANDLED]", e); process.exit(1); });
process.on("uncaughtException",  e => { console.error("[UNCAUGHT]",  e); process.exit(1); });

// ===== ENV =====
const MONGO_URI = process.env.MONGO_URI;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
if (!MONGO_URI || !CHAT_ID || !TOKEN) {
  console.error("[BOOT] Missing MONGO_URI or TELEGRAM_* vars"); process.exit(1);
}

// ===== Config =====
const COINS = ["bitcoin", "ethereum"];
const MODEL = process.env.MODEL_VER ?? "v4-ai-logreg-xau";
const BUCKET_LO = Number(process.env.BUCKET_LO ?? 0.70);
const BUCKET_HI = Number(process.env.BUCKET_HI ?? 0.75);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 7);
const LOOKBACK_MS   = LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const MIN_N = Number(process.env.MIN_N ?? 50);
const HEARTBEATS     = String(process.env.HEARTBEATS ?? "on").toLowerCase() === "on";
const HEARTBEAT_MODE = String(process.env.HEARTBEAT_MODE ?? "tenmin").toLowerCase(); // 'tenmin' | 'hourly'
const QUIET_HOURS    = process.env.QUIET_HOURS ?? "";

// ===== Helpers =====
function mytDate(d) { const t = new Date(d.getTime() + 8*60*60*1000); return t.toISOString().slice(0,16).replace("T"," "); }
function inQuietHours(nowUtc, spec) {
  if (!spec) return false;
  const m = spec.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/); if (!m) return false;
  const [ , h1, m1, h2, m2 ] = m.map(Number);
  const nowMyt = new Date(nowUtc.getTime() + 8*60*60*1000);
  const cur = nowMyt.getHours()*60 + nowMyt.getMinutes();
  const a = h1*60 + m1, b = h2*60 + m2;
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}
function bucketLabel(){ const lo=Math.round(BUCKET_LO*100); const hi=Math.round(BUCKET_HI*100)-1; return `${lo}–${hi}%`; }
function shouldSendHeartbeat(nowUtc){
  if (!HEARTBEATS || inQuietHours(nowUtc, QUIET_HOURS)) return false;
  if (HEARTBEAT_MODE === "hourly") {
    const nowMyt=new Date(nowUtc.getTime()+8*60*60*1000); return nowMyt.getMinutes()===0;
  }
  return true;
}

async function tgSend(text){
  const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
  const res = await fetchFn(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview:true })
  });
  const json = await res.json().catch(()=>({}));
  if (!json.ok) { console.error("[TG ERROR]", res.status, json); throw new Error(json.description||`telegram send failed (${res.status})`); }
  console.log("[TG OK] message_id", json.result?.message_id);
}

async function latest(coin){
  // newest by ts for the given MODEL/coin
  return Prediction.findOne({ coin, model_ver: MODEL }).sort({ ts: -1 }).lean();
}

async function bucketOK(coin){
  const since = new Date(Date.now() - LOOKBACK_MS);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: { from: "predictions", localField: "pred_id", foreignField: "_id", as: "pred" } },
    { $unwind: "$pred" },
    { $match: { "pred.model_ver": MODEL, "pred.coin": coin, "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI } } },
    { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: "$realized_ret" } } }
  ]);
  const d = rows[0] || { n: 0, avg: null };
  return { ok: (d.n >= MIN_N) && (d.avg != null && d.avg >= 0), n: d.n, avg: d.avg ?? null };
}

// ===== GoState (lightweight) =====
const GoState = mongoose.models.GoState || mongoose.model("GoState", new mongoose.Schema({
  coin: { type: String, unique: true },
  state: String, reason: String, p_up: Number, pred_ts: Date,
  last_sent_type: String, last_sent_at: Date,
  updated_at: { type: Date, default: Date.now }
}));

// ===== Main =====
(async () => {
  console.log("[BOOT]", new Date().toISOString(), { MODEL, BUCKET_LO, BUCKET_HI, LOOKBACK_DAYS, MIN_N, HEARTBEATS, HEARTBEAT_MODE, QUIET_HOURS });
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("[MONGO] connected");

  const now = new Date();

  for (const coin of COINS) {
    const pred = await latest(coin);
    if (!pred) { console.warn(`[SKIP] No prediction for ${coin} MODEL=${MODEL}`); continue; }

    const p = Number(pred.p_up ?? pred.prob_up ?? 0);
    const inBucket = p >= BUCKET_LO && p < BUCKET_HI;
    const b = await bucketOK(coin);
    const state = (inBucket && b.ok) ? "GO" : "NO_GO";

    const entryUntil = mytDate(new Date(pred.ts.getTime() + 60*60*1000));
    const exitBy     = mytDate(new Date(pred.ts.getTime() + 24*60*60*1000));
    const avgStr     = (b.avg == null) ? "—" : `${b.avg >= 0 ? "+" : ""}${(b.avg*100).toFixed(2)}%`;
    const reason     = `p_up=${(p*100).toFixed(1)}% • 7d(${bucketLabel()}) ${avgStr} (n=${b.n})`;
    const head       = `${coin.toUpperCase()}: ${state==="GO" ? "🟢 GO" : "🔴 NO-GO"} — ${reason}`;
    const windowTxt  = state==="GO" ? `\nEntry until ${entryUntil} MYT\nExit by ${exitBy} MYT` : "";

    // —— NEW: append-only inference log (safe) ——
    await logInference({
      ts: new Date(),
      pred_ts: pred.ts,
      coin,
      model: MODEL,
      p_up: p,
      n: b.n,
      bucket7d: b.avg,
      decision: state,
      reason
    });

    const prev = await GoState.findOne({ coin }).lean();
    const stateChanged = !prev || prev.state !== state;

    if (stateChanged) {
      await tgSend(head + windowTxt);
      await GoState.updateOne(
        { coin },
        { $set: { state, reason, p_up: p, pred_ts: pred.ts, last_sent_type: "flip", last_sent_at: new Date(), updated_at: new Date() } },
        { upsert: true }
      );
    } else if (shouldSendHeartbeat(now)) {
      const snapshot = `⏱️ Snapshot ${mytDate(now)} MYT\n${head}`;
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
