import mongoose from "mongoose";
const { Schema } = mongoose;

const PredictionSchema = new Schema({
  ts:        { type: Date, default: Date.now, index: true },
  coin:      { type: String, required: true, index: true },
  horizon:   { type: String, default: "24h", index: true },
  p_up:      { type: Number, required: true },

  // Allow arbitrary nested fields under features (indicators, components, debug, etc.)
  features:  { type: Schema.Types.Mixed, default: {} },

  model_ver: { type: String, default: "v1-momentum" }
}, { versionKey: false });

PredictionSchema.index({ coin: 1, ts: -1 });

export default mongoose.models.Prediction || mongoose.model("Prediction", PredictionSchema);
