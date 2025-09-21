// /models/MicroState.js  (ESM)
import mongoose from "mongoose";

const MicroStateSchema = new mongoose.Schema({
  coin: { type: String, unique: true },
  state: { type: String, enum: ["none", "watch", "standby", "buy"], default: "none" },
  // timestamps for debounce/cooldown
  state_since: { type: Date, default: Date.now },
  last_buy_at: { type: Date },
  last_standby_at: { type: Date },
  last_heartbeat_at: { type: Date },
  // debugging
  last_reason: { type: String }
}, { collection: "micro_states", timestamps: true });

export default mongoose.models.MicroState
  || mongoose.model("MicroState", MicroStateSchema);
