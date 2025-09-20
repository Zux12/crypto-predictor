// routes/tg.js
import { Router } from "express";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const r = Router();

const COINS = ["bitcoin", "ethereum"];
const MODEL = "v4-ai-logreg-xau";
const BUCKET_LO = 0.70, BUCKET_HI = 0.75; // target bucket [70,75)
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_N = 50;
const ENTRY_SEC = 60 * 60;
const EXIT_SEC  = 24 * 60 * 60;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TG_SECRET = process.env.TG_SECRET || "";

function secsLeft(sinceMs, horizonSec){
  const dt = Math.floor((horizonSec*1000) - (Date.now() - sinceMs));
  return dt > 0 ? Math.floor(dt/1000) : 0;
}
function fmtMins(secs){
  const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
  return h > 0 ? `${h}h ${String(m).padStart(2,"0")}m` : `${m}m`;
}
async function bucketStats(coin){
  const since = new Date(Date.now() - LOOKBACK_MS);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: { from:"predictions", localField:"pred_id", foreignField:"_id", as:"pred" } },
    { $unwind: "$pred" },
    { $match: { "pred.model_ver":MODEL, "pred.coin":coin, "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI } } },
    { $group: { _id:null, n:{ $sum:1 }, avg:{ $avg:"$realized_ret" } } }
  ]);
  const d = rows[0] || { n:0, avg:null };
  return { n: d.n, avg: d.avg };
}
async function latestPred(coin){
  return await Prediction.findOne({ coin, model_ver: MODEL }).sort({ ts:-1 }).lean();
}
async function computeOne(coin){
  const [pred, bucket] = await Promise.all([ latestPred(coin), bucketStats(coin) ]);
  if (!pred) return { coin, status:"NO-GO", reason:"no prediction" };
  const p = Number(pred.p_up ?? pred.prob_up ?? 0);
  const inBucket = p >= BUCKET_LO && p < BUCKET_HI;
  const bucketOk = (bucket.n >= MIN_N) && (bucket.avg != null && bucket.avg >= 0);
  const status = (inBucket && bucketOk) ? "GO" : "NO-GO";
  const tsMs = new Date(pred.ts).getTime();
  const entryLeft = secsLeft(tsMs, ENTRY_SEC);
  const exitLeft  = secsLeft(tsMs, EXIT_SEC);
  const parts = [];
  parts.push(`p_up=${(p*100).toFixed(1)}%`);
  if (bucket.avg != null) parts.push(`7d(70–74%) ${(bucket.avg>=0?"+":"")}${(bucket.avg*100).toFixed(2)}%`);
  parts.push(`n=${bucket.n}`);
  if (!inBucket) parts.push("outside 70–74%");
  if (bucket.n < MIN_N) parts.push("n<threshold");
  if (bucket.avg != null && bucket.avg < 0) parts.push("bucket<0");
  return {
    coin, status,
    entry: entryLeft, exit: exitLeft,
    reason: parts.join(" • ")
  };
}
async function computeAll(){
  const rows = await Promise.all(COINS.map(c => computeOne(c)));
  return Object.fromEntries(rows.map(r => [r.coin, r]));
}
async function reply(chatId, text){
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chat_id: chatId, text })
  }).catch(()=>{});
}

function formatOne(r){
  const icon = r.status === "GO" ? "🟢" : "🔴";
  const entry = r.entry ? fmtMins(r.entry) + " left" : "elapsed";
  const exit  = r.exit  ? fmtMins(r.exit)  + " left" : "elapsed";
  return `${r.coin.toUpperCase()}: ${icon} ${r.status}\n${r.reason}\nEntry: ${entry} • Exit: ${exit}`;
}

function helpText(){
  return [
    "Commands:",
    "/go — status for BTC & ETH",
    "/go btc — BTC only",
    "/go eth — ETH only",
    "/why — rule summary"
  ].join("\n");
}

function ruleText(){
  return "Rule: v4-xau with p_up ∈ [70%,74%) AND 7d bucket avg ≥ 0 AND n ≥ 50. Entry window 1h; exit 24h.";
}

// Webhook endpoint: /api/tg/:secret
r.post("/:secret", async (req, res) => {
  try {
    if (!TOKEN || !CHAT_ID || !TG_SECRET) return res.sendStatus(200);
    if (req.params.secret !== TG_SECRET) return res.sendStatus(404);

    const update = req.body;
    const msg = update?.message;
    const chatId = String(msg?.chat?.id || "");
    const text = (msg?.text || "").trim();

    // (Optional simple allowlist: only reply to your CHAT_ID)
    if (chatId && CHAT_ID && chatId !== String(CHAT_ID)) {
      // ignore others silently
      return res.sendStatus(200);
    }

    if (!text || text === "/start") {
      await reply(chatId || CHAT_ID, "Hi! Send /go for BTC & ETH status or /help for commands.");
      return res.sendStatus(200);
    }

    if (text === "/help") {
      await reply(chatId || CHAT_ID, helpText());
      return res.sendStatus(200);
    }

    if (text === "/why") {
      await reply(chatId || CHAT_ID, ruleText());
      return res.sendStatus(200);
    }

    if (text === "/go") {
      const all = await computeAll();
      const body = [formatOne(all.bitcoin), formatOne(all.ethereum)].join("\n\n");
      await reply(chatId || CHAT_ID, body);
      return res.sendStatus(200);
    }

    if (text.toLowerCase() === "/go btc" || text.toLowerCase() === "/go bitcoin") {
      const r1 = await computeOne("bitcoin");
      await reply(chatId || CHAT_ID, formatOne(r1));
      return res.sendStatus(200);
    }
    if (text.toLowerCase() === "/go eth" || text.toLowerCase() === "/go ethereum") {
      const r2 = await computeOne("ethereum");
      await reply(chatId || CHAT_ID, formatOne(r2));
      return res.sendStatus(200);
    }

    // fallback
    await reply(chatId || CHAT_ID, "Unknown command. Try /go or /help");
    res.sendStatus(200);
  } catch (e) {
    // Always 200 to Telegram
    res.sendStatus(200);
  }
});

export default r;
