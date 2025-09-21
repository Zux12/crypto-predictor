// /models/Inference.js  (ESM)
import mongoose from "mongoose";

const InferenceSchema = new mongoose.Schema({
  ts:       { type: Date,   required: true, index: true },   // log time
  pred_ts:  { type: Date },                                   // model's own timestamp (if you have it)
  coin:     { type: String, required: true, index: true },
  model:    { type: String, required: true, index: true },    // e.g. "v4-xau"
  p_up:     { type: Number, required: true },                 // 0..1
  n:        { type: Number },                                 // optional
  bucket7d: { type: Number },                                 // decimal (e.g., 0.0043 for +0.43%)
  decision: { type: String, enum: ["GO","NO_GO","NEAR_GO"], index: true },
  reason:   { type: String },
}, { collection: "inferences" });

InferenceSchema.index({ coin: 1, model: 1, ts: -1 });

export default mongoose.models.Inference
  || mongoose.model("Inference", InferenceSchema);
