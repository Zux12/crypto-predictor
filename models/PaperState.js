import mongoose from "mongoose";

const HoldingSchema = new mongoose.Schema({
  coin: { type: String, index: true },      // e.g., "bitcoin"
  qty:  { type: Number, default: 0 },       // virtual coins held
  entry_price: { type: Number, default: 0 },
  opened_at: { type: Date, default: null }
}, { _id: false });

const PaperStateSchema = new mongoose.Schema({
  _id: { type: String, default: "default" }, // single-doc pattern
  cash_usd: { type: Number, default: 0 },
  equity_usd: { type: Number, default: 0 },  // computed each run
  holdings: { type: [HoldingSchema], default: [] },
  params: {
    start_bal: Number, trade_threshold: Number, exit_threshold: Number,
    max_pos_pct: Number, fee_bps: Number
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { versionKey: false });

export default mongoose.models.PaperState || mongoose.model("PaperState", PaperStateSchema);
