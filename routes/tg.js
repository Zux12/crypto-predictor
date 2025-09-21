// routes/tg.js  (ESM)
import express from "express";
import mongoose from "mongoose";

// Use global fetch if available; otherwise lazy import node-fetch
async function httpFetch(url, opts) {
  const f = globalThis.fetch ?? (await import("node-fetch")).default;
  return f(url, opts);
}

const router = express.Router();

// ===== ENV =====
const TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const APP_BASE    = process.env.APP_BASE_URL || ""; // e.g. https://crypto-predictor25-…herokuapp.com
const CHAT_WHITELIST = (process.env.TG_CHAT_WHITELIST || "").split(",").map(s => s.trim()).filter(Boolean);

// Micro preset (same as UI preset; adjust via Heroku config vars)
const MICRO_COINS = (process.env.MICRO_COINS || "bitcoin,ethereum").split(",").map(s => s.trim());
const MICRO_P     = process.env.MICRO_P   ?? "0.55";
const MICRO_N     = process.env.MICRO_N   ?? "50";
const MICRO_B     = process.env.MICRO_B   ?? "-0.001";
const MICRO_W     = process.env.MICRO_W   ?? "30";
const MICRO_RSI   = process.env.MICRO_RSI ?? "35";
const MICRO_BBK   = process.env.MICRO_BBK ?? "1.5";
const MICRO_TP    = process.env.MICRO_TP  ?? "0.003";
const MICRO_SL    = process.env.MICRO_SL  ?? "0.002";
const MICRO_HOLD  = process.env.MICRO_HOLD?? "2";

// ===== helpers =====
function mytNow() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return t.toISOString().slice(11, 16); // "HH:MM"
}
function coinNorm(s="") {
  s = s.toLowerCase();
  if (s === "btc") return "bitcoin";
  if (s === "eth") return "ethereum";
  return s;
}

async function tgSend(chatId, text) {
  if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const res = await httpFetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const js = await res.json().catch(() => ({}));
  if (!js.ok) {
    console.error("[TG ERROR]", res.status, js);
    throw new Error(js.description || `telegram send failed (${res.status})`);
  }
  return js;
}

async function getGoStates() {
  // reads gostates collection directly (existing 24h state)
  const rows = await mongoose.connection.collection("gostates").find({}).toArray();
  const map = {};
  rows.forEach(r => { map[r.coin] = r; });
  return map;
}

async function getMicroSignals() {
  // Call your own API so UI, Telegram, and stats stay consistent
  const base = APP_BASE || "";
  if (!base) {
    // fallback: try relative (works when this route shares the same host)
    const q = new URLSearchParams({
      coins: MICRO_COINS.join(","),
      p: MICRO_P, b: MICRO_B, w: MICRO_W, rsi: MICRO_RSI, mode: "flip", bbk: MICRO_BBK,
      tp: MICRO_TP, sl: MICRO_SL, hold: MICRO_HOLD
    }).toString();
    // Using relative path when same app serves API
    const r = await httpFetch(`/api/combined/signal?${q}`, { cache: "no-store" });
    const js = await r.json();
    return js.signals || [];
  } else {
    const q = new URLSearchParams({
      coins: MICRO_COINS.join(","),
      p: MICRO_P, b: MICRO_B, w: MICRO_W, rsi: MICRO_RSI, mode: "flip", bbk: MICRO_BBK,
      tp: MICRO_TP, sl: MICRO_SL, hold: MICRO_HOLD
    }).toString();
    const r = await httpFetch(`${base}/api/combined/signal?${q}`, { cache: "no-store" });
    const js = await r.json();
    return js.signals || [];
  }
}

function microLine(sig) {
  if (!sig || !sig.available) return "• Micro: —";
  if (sig.combined) {
    return `• Micro: ⚡ BUY — TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h\n  Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt}`;
  }
  if (sig.v4 && !sig.dip) {
    return "• Micro: 👀 Watch (v4 OK) — waiting flip-dip (±30m)";
  }
  return "• Micro: —";
}

function formatGoSnapshot(goMap, sigs) {
  const m = {};
  (sigs || []).forEach(s => { m[s.coin] = s; });
  const coins = MICRO_COINS;
  const lines = [];
  lines.push(`⏱️ Snapshot ${mytNow()} MYT`, "");
  for (const c of coins) {
    const st = (goMap[c]?.state || "NO-GO").toUpperCase();
    lines.push(`${c.toUpperCase()} — ${st === "GO" ? "🟢 GO" : "🔴 NO-GO"} [24h]`);
    lines.push(microLine(m[c]));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatWhyAll(goMap, sigs) {
  const m = {};
  (sigs || []).forEach(s => { m[s.coin] = s; });
  const coins = MICRO_COINS;
  const out = [];
  for (const c of coins) {
    const st = (goMap[c]?.state || "NO-GO").toUpperCase();
    const s = m[c];
    const pu = s ? (s.p_up*100).toFixed(1) : null;
    const bucket = (s && Number.isFinite(s.bucket7d)) ? `${s.bucket7d>=0?"+":""}${(s.bucket7d*100).toFixed(2)}%` : "—";
    out.push(`${c.toUpperCase()} — ${st === "GO" ? "🟢 GO" : "🔴 NO-GO"} [24h]`);
    out.push(`• v4: ${s ? `p_up ${pu}% • n=${s.n} • 7d ${bucket}` : "—"}`);
    out.push(s ? (s.combined ? `• Micro: ⚡ BUY active` : (s.v4 ? `• Micro: 👀 Watch (v4 OK)` : `• Micro: —`)) : `• Micro: —`);
    out.push("");
  }
  return out.join("\n").trim();
}

function formatWhyOne(coin, goMap, sig) {
  const st = (goMap[coin]?.state || "NO-GO").toUpperCase();
  const pu = sig ? (sig.p_up*100).toFixed(1) : null;
  const bucket = (sig && Number.isFinite(sig.bucket7d)) ? `${sig.bucket7d>=0?"+":""}${(sig.bucket7d*100).toFixed(2)}%` : "—";
  const microPreset = `p≥${MICRO_P}, n≥${MICRO_N}, bucket≥${MICRO_B}, dip=flip, window ±${MICRO_W}m, BB ${MICRO_BBK}σ`;
  const lines = [];
  lines.push(`${coin.toUpperCase()} — status`);
  lines.push(`[24h] ${st}: classic rule (70–74% band)`);
  lines.push(`Micro preset: ${microPreset}.`);
  if (!sig) {
    lines.push("• v4: —");
    lines.push("• dip: —");
    lines.push("• Micro: —");
  } else {
    lines.push(`• v4: ${sig.v4 ? "OK" : "OFF"} (p_up ${pu ?? "—"}%, n=${sig.n ?? "—"}, 7d ${bucket})`);
    lines.push(`• dip: ${sig.dip ? "ON (flip)" : "OFF"}`);
    if (sig.combined) {
      lines.push(`• Micro: ⚡ BUY — TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h`);
      lines.push(`  Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt}`);
    } else if (sig.v4 && !sig.dip) {
      lines.push(`• Micro: 👀 Watch (v4 OK) — awaiting flip-dip (±${MICRO_W}m)`);
    } else {
      lines.push(`• Micro: —`);
    }
  }
  lines.push("Trade rule on BUY: TP +0.30% • SL −0.20% • max 2h.");
  return lines.join("\n");
}

// ===== Telegram webhook route =====
router.post("/", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) return res.sendStatus(200);

    const chatId = msg.chat?.id;
    const textRaw = (msg.text || "").trim();
    const first = textRaw.split(/\s+/)[0].toLowerCase();
    const arg = textRaw.slice(first.length).trim();

    // Optional whitelist
    if (CHAT_WHITELIST.length && !CHAT_WHITELIST.includes(String(chatId))) {
      await tgSend(chatId, "Sorry, this bot is restricted.");
      return res.sendStatus(200);
    }

    if (first === "/start" || first === "/help") {
      const help = [
        "Hi! Commands:",
        "• /go  — snapshot (24h + Micro line)",
        "• /why — reasons for all coins",
        "• /why btc|eth — reasons for one coin",
        "• /why micro — explain the Micro preset",
      ].join("\n");
      await tgSend(chatId, help);
      return res.sendStatus(200);
    }

    if (first === "/go") {
      const [sigs, goMap] = await Promise.all([getMicroSignals(), getGoStates()]);
      const out = formatGoSnapshot(goMap, sigs);
      await tgSend(chatId, out);
      return res.sendStatus(200);
    }

    if (first === "/why") {
      if (!arg || arg === "all") {
        const [sigs, goMap] = await Promise.all([getMicroSignals(), getGoStates()]);
        const out = formatWhyAll(goMap, sigs);
        await tgSend(chatId, out);
        return res.sendStatus(200);
      }
      if (arg === "micro") {
        const explain = [
          "Micro-Combined (0.5–2h): v4-xau filter (p≥0.55, n≥50, bucket≥−0.001) AND dip “flip”",
          "(RSI turns up after oversold or band-touch) within ±30m; Bollinger 1.5σ.",
          "Exit: TP +0.30%, SL −0.20%, max 2h.",
          "Standby (optional alert): v4 ON + 2 of 3 cues (RSI rising near oversold, near/touched band, small rejection)."
        ].join("\n");
        await tgSend(chatId, explain);
        return res.sendStatus(200);
      }
      const coin = coinNorm(arg);
      if (!MICRO_COINS.includes(coin)) {
        await tgSend(chatId, "Please use /why btc or /why eth (or /why micro).");
        return res.sendStatus(200);
      }
      const [sigs, goMap] = await Promise.all([getMicroSignals(), getGoStates()]);
      const sig = (sigs || []).find(s => s.coin === coin);
      const out = formatWhyOne(coin, goMap, sig);
      await tgSend(chatId, out);
      return res.sendStatus(200);
    }

    // Unknown command → keep your previous behavior (echo a short help)
    await tgSend(chatId, "Unknown command. Try /go or /why.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("[tg]", e);
    // Avoid Telegram retries by returning 200 even on internal error
    try {
      const chatId = req.body?.message?.chat?.id || req.body?.edited_message?.chat?.id;
      if (chatId) await tgSend(chatId, "Oops, temporary error. Try again in a minute.");
    } catch {}
    return res.sendStatus(200);
  }
});

// Simple health-check
router.get("/ping", (req, res) => res.send("ok"));

export default router;
