import mongoose from "mongoose";

const PriceSchema = new mongoose.Schema({
  ts:   { type: Date, default: Date.now, index: true },
  coin: { type: String, required: true, index: true }, // e.g. "bitcoin", "ethereum"
  price:{ type: Number, required: true },
  source:{ type: String, default: "coingecko" }
}, { versionKey: false });

PriceSchema.index({ coin: 1, ts: -1 });

export default mongoose.models.Price || mongoose.model("Price", PriceSchema);
