import mongoose from "mongoose";

const PredictionSchema = new mongoose.Schema(
  {
    coin: { type: String, index: true },
    model_ver: { type: String, index: true },
    ts: { type: Date, index: true },
    horizon: { type: String, default: "24h" },
    prob_up: { type: Number },

    // === Added fields for labels ===
    labeled_at: { type: Date, index: true },   // when this prediction was labeled
    label_up: { type: Boolean },               // actual outcome (true = up)
    price_t0: { type: Number },                // price at prediction time
    price_t1: { type: Number },                // price at eval time (+24h)
    brier: { type: Number },                   // Brier score contribution
    correct: { type: Boolean }                 // whether prediction was correct
    // =================================
  },
  { versionKey: false }
);

PredictionSchema.index({ coin: 1, model_ver: 1, ts: -1 });

const Prediction = mongoose.model("Prediction", PredictionSchema);

export default Prediction;
