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
    bucket7d: bucketPct != null ? Number(bucketPct) / 100 : undefined
  };
}

export async function logInference({
  ts = new Date(),
  pred_ts,
  coin,
  model,
  p_up,
  n,
  bucket7d,
  decision,
  reason
}) {
  try {
    const parsed = parseReason(reason);
    await Inference.create({
      ts,
      pred_ts: pred_ts ?? ts,
      coin,
      model,
      p_up,
      n: n ?? parsed.n,
      bucket7d: bucket7d ?? parsed.bucket7d,
      decision,
      reason
    });
    return true;
  } catch (err) {
    console.error("[inferenceLogger] save failed:", err?.message || err);
    return false;
  }
}
