// ESM
import mongoose from "mongoose";

const InferenceSchema = new mongoose.Schema({
  ts:       { type: Date, required: true, index: true },
  pred_ts:  { type: Date },
  coin:     { type: String, required: true, index: true },
  model:    { type: String, required: true, index: true },
  p_up:     { type: Number, required: true },
  n:        { type: Number },
  bucket7d: { type: Number }, // decimal (e.g., 0.0043 = +0.43%)
  decision: { type: String, enum: ["GO","NO_GO","NEAR_GO"], index: true },
  reason:   { type: String }
}, { collection: "inferences" });

InferenceSchema.index({ coin: 1, model: 1, ts: -1 });

export default mongoose.models.Inference
  || mongoose.model("Inference", InferenceSchema);
