// jobs/notify_go.js
import "dotenv/config";
import mongoose from "mongoose";
import Prediction from "../models/Prediction.js";
import Label from "../models/Label.js";

const MONGO_URI = process.env.MONGO_URI;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!MONGO_URI || !CHAT_ID || !TOKEN) {
  console.error("Missing MONGO_URI or TELEGRAM_* vars"); process.exit(1);
}

const COINS = ["bitcoin","ethereum"];
const MODEL = "v4-ai-logreg-xau";
const BUCKET_LO = 0.70, BUCKET_HI = 0.75;
const LOOKBACK_MS = 7*24*60*60*1000;
const MIN_N = 50;

function mytDate(d){ // MYT (+08:00)
  const t = new Date(d.getTime() + 8*3600*1000);
  return t.toISOString().slice(0,16).replace("T"," ");
}
async function bucketOK(coin){
  const since = new Date(Date.now()-LOOKBACK_MS);
  const rows = await Label.aggregate([
    { $match: { labeled_at: { $gte: since } } },
    { $lookup: { from:"predictions", localField:"pred_id", foreignField:"_id", as:"pred" }},
    { $unwind: "$pred" },
    { $match: { "pred.model_ver":MODEL, "pred.coin":coin, "pred.p_up": { $gte: BUCKET_LO, $lt: BUCKET_HI } } },
    { $group: { _id:null, n:{ $sum:1 }, avg:{ $avg:"$realized_ret" } } }
  ]);
  const d = rows[0] || { n:0, avg:null };
  return { ok: (d.n>=MIN_N) && (d.avg!=null && d.avg>=0), n:d.n, avg:d.avg ?? null };
}
async function latest(coin){
  return await Prediction.findOne({ coin, model_ver:MODEL }).sort({ ts:-1 }).lean();
}

// minimal GoState model in-line
import mongoosePkg from "mongoose";
const GoState = mongoosePkg.models.GoState || mongoosePkg.model("GoState", new mongoosePkg.Schema({
  coin: { type:String, unique:true },
  state: String,
  reason: String,
  pred_ts: Date,
  updated_at: { type: Date, default: Date.now }
}));

async function send(text){
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chat_id: CHAT_ID, text }) });
  if (!res.ok) console.error("telegram send failed", await res.text());
}

(async ()=>{
  await mongoose.connect(MONGO_URI);
  for (const coin of COINS){
    const pred = await latest(coin);
    if (!pred) continue;
    const p = Number(pred.p_up ?? pred.prob_up ?? 0);
    const inBucket = p>=BUCKET_LO && p<BUCKET_HI;
    const b = await bucketOK(coin);
    const state = (inBucket && b.ok) ? "GO" : "NO_GO";

    const prev = await GoState.findOne({ coin }).lean();
    if (!prev || prev.state !== state){
      const entryUntil = mytDate(new Date(pred.ts.getTime()+60*60*1000));
      const exitBy    = mytDate(new Date(pred.ts.getTime()+24*60*60*1000));
      const reason = `p_up=${(p*100).toFixed(1)}% • 7d(70–74%) ${b.avg!=null?(b.avg>=0?"+":"")+(b.avg*100).toFixed(2)+"%":"—"} (n=${b.n})`;
      const msg = `${coin.toUpperCase()}: ${state==="GO"?"🟢 GO":"🔴 NO-GO"} — ${reason}${state==="GO"?`\nEntry until ${entryUntil} MYT\nExit by ${exitBy} MYT`:""}`;
      await send(msg);
      await GoState.updateOne({ coin }, { $set: { state, reason, pred_ts: pred.ts, updated_at: new Date() } }, { upsert:true });
    }
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch(async e=>{ console.error(e); try{ await mongoose.disconnect(); }catch{} process.exit(1); });
