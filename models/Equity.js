import mongoose from "mongoose";

const EquitySchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },
  equity_usd: Number,    // cash + holdings at mark price
  cash_usd: Number,
  by_coin: [{
    coin: String,
    qty: Number,
    mark_price: Number,
    value_usd: Number
  }]
}, { versionKey: false });

export default mongoose.models.Equity || mongoose.model("Equity", EquitySchema);
