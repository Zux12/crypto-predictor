import mongoose from "mongoose";

const PaperTradeSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },
  coin: { type: String, index: true },
  side: { type: String, enum: ["BUY","SELL"], index: true },
  qty: Number,
  price: Number,
  fee_usd: Number,
  pnl_usd: Number,          // realized pnl on SELL; null on BUY
  reason: String            // "enter_threshold", "exit_threshold", "timeout_24h"
}, { versionKey: false });

PaperTradeSchema.index({ coin:1, ts:-1 });

export default mongoose.models.PaperTrade || mongoose.model("PaperTrade", PaperTradeSchema);
