// /jobs/inferenceLogger.js  (ESM)
import Inference from "../models/Inference.js";

// parse "p_up=60.3% • 7d(70–74%) +0.43% (n=92)"
const RE_N = /\(n=(\d+)\)/i;
const RE_BUCKET = /7d\([^)]*\)\s*([+\-]?\d+(?:\.\d+)?)%/i;

export function parseReason(reason) {
  if (!reason) return {};
  const n = RE_N.exec(reason)?.[1];
  const bucketPct = RE_BUCKET.exec(reason)?.[1];
  return {
    n: n ? Number(n) : undefined,
    bucket7d: bucketPct != null ? Number(bucketPct) / 100 : undefined,
  };
}

/**
 * Append-only log; safe even if it fails.
 * Call this right after you decide/send the Telegram message.
 */
export async function logInference({
  ts = new Date(),
  pred_ts,
  coin,
  model = "v4-xau",
  p_up,
  n,
  bucket7d,
  decision,   // "GO" | "NO_GO" | "NEAR_GO"
  reason,
}) {
  try {
    const parsed = parseReason(reason);
    const doc = new Inference({
      ts,
      pred_ts: pred_ts ?? ts,
      coin,
      model,
      p_up,
      n: n ?? parsed.n,
      bucket7d: bucket7d ?? parsed.bucket7d,
      decision,
      reason,
    });
    await doc.save();
    return true;
  } catch (err) {
    console.error("[inferenceLogger] save failed:", err?.message || err);
    return false;
  }
}
