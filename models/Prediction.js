import mongoose from "mongoose";

const PredictionSchema = new mongoose.Schema(
  {
    coin: { type: String, index: true },
    model_ver: { type: String, index: true },
    ts: { type: Date, index: true, default: Date.now },   // <-- ensure a timestamp is stored
    horizon: { type: String, default: "24h" },

    // main probability field (what your UI reads)
    p_up: { type: Number },

    // keep for compatibility if any old code used it:
    prob_up: { type: Number },

    // === labeling fields ===
    labeled_at: { type: Date, index: true },
    label_up: { type: Boolean },
    price_t0: { type: Number },
    price_t1: { type: Number },
    brier: { type: Number },
    correct: { type: Boolean }
  },
  { versionKey: false }
);

PredictionSchema.index({ coin: 1, model_ver: 1, ts: -1 });

const Prediction = mongoose.model("Prediction", PredictionSchema);
export default Prediction;
