import mongoose from "mongoose";

const LabelSchema = new mongoose.Schema({
  pred_id:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  coin:      { type: String, required: true, index: true },
  horizon:   { type: String, default: "24h", index: true },
  model_ver: { type: String, default: "v1-momentum" },

  pred_ts:   { type: Date, required: true, index: true },   // when prediction was made
  eval_ts:   { type: Date, required: true, index: true },   // pred_ts + 24h (approx)

  p_up:      { type: Number, required: true },              // stored probability
  price_t0:  { type: Number, required: true },              // price near pred_ts
  price_t1:  { type: Number, required: true },              // price near eval_ts
  realized_ret: { type: Number, required: true },           // (p1 - p0)/p0
  label_up:  { type: Boolean, required: true },             // realized_ret > 0

  brier:     { type: Number, required: true },              // (y - p)^2
  correct:   { type: Boolean, required: true }              // (p>=0.5) === label_up
}, { versionKey: false });

LabelSchema.index({ coin:1, pred_ts:-1 });

export default mongoose.models.Label || mongoose.model("Label", LabelSchema);
