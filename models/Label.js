// models/Label.js
import mongoose from "mongoose";

const LabelSchema = new mongoose.Schema(
  {
    // 1 row per prediction
    pred_id:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    // metadata
    coin:      { type: String, required: true, index: true },
    horizon:   { type: String, default: "24h", index: true },
    model_ver: { type: String, default: null },     // <-- no misleading default
    labeled_at:{ type: Date, default: Date.now, index: true },  // <-- when this label was written

    // timing
    pred_ts:   { type: Date, required: true, index: true },   // when prediction was made
    eval_ts:   { type: Date, required: true, index: true },   // ~pred_ts + horizon

    // prediction + outcomes
    p_up:         { type: Number, required: true },
    price_t0:     { type: Number, required: true },
    price_t1:     { type: Number, required: true },
    realized_ret: { type: Number, required: true },
    label_up:     { type: Boolean, required: true },

    // scoring
    brier:    { type: Number, required: true },
    correct:  { type: Boolean, required: true }
  },
  { versionKey: false }
);

// --- Indexes ---
// LabelSchema.index({ pred_id: 1 }, { unique: true });                       // one label per pred
LabelSchema.index({ coin: 1, horizon: 1, model_ver: 1, pred_ts: -1 });     // common filters
LabelSchema.index({ labeled_at: -1 });                                     // recency queries
LabelSchema.index({ coin: 1, pred_ts: -1 });                                // quick coin streams

export default mongoose.models.Label || mongoose.model("Label", LabelSchema);
