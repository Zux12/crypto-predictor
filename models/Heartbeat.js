import mongoose from "mongoose";
const HeartbeatSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now },
  note: { type: String, default: "boot" }
}, { versionKey: false });
export default mongoose.models.Heartbeat || mongoose.model("Heartbeat", HeartbeatSchema);
