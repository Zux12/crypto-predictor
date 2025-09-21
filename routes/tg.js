// routes/tg.js  — safe, self-contained Telegram webhook (ESM)
import express from "express";
import mongoose from "mongoose";

// Route-local JSON parser so we don't change global middleware
const router = express.Router();
router.use(express.json({ limit: "1mb" }));

// ==== ENV ====
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const APP_BASE = process.env.APP_BASE_URL || ""; // e.g. https://crypto-...herokuapp.com

// Optional chat whitelist: "12345,67890"
const CHAT_WHITELIST = (process.env.TG_CHAT_WHITELIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Micro preset (same as UI; tune via Heroku config vars)
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

// ==== small helpers ====
async function httpFetch(url, opts) {
  const f = globalThis.fetch ?? (await import("node-fetch")).default;
  return f(url, opts);
}
async function tgSend(chatId, text) {
  if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const r = await httpFetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const js = await r.json().catch(() => ({}));
  if (!js.ok) {
    console.error("[TG ERROR]", r.status, js);
    throw new Error(js.description || `telegram send failed (${r.status})`);
  }
  return js;
}
function mytNow() {
  const z = new Date(Date.now() + 8 * 3600 * 1000);
  return z.toISOString().slice(11, 16);
}
function coinNorm(s = "") {
  s = s.toLowerCase().trim();
  if (!s) return "";
  const b = s.split("@")[0];               // handle /go@YourBot style
  if (b === "btc") return "bitcoin";
  if (b === "eth") return "ethereum";
  return b;
}
function cmdBase(text = "") {
  const t = text.trim().split(/\s+/)[0] || "";
  const base = t.split("@")[0].toLowerCase();
  return base; // e.g. "/go", "/why"
}

// 24h GO/NO-GO (reads gostates)
async function getGoStates() {
  const rows = await mongoose.connection.collection("gostates").find({}).toArray();
  const m = {}; rows.forEach(r => { m[r.coin] = r; });
  return m;
}

// Micro signals from your own API (keeps logic in one place)
async function getMicroSignals(req) {
  // derive base if APP_BASE_URL not set
  const base = APP_BASE || `${req.protocol}://${req.get("host")}`;
  const q = new URLSearchParams({
    coins: MICRO_COINS.join(","),
    p: MICRO_P, b: MICRO_B, w: MICRO_W, rsi: MICRO_RSI, mode: "flip", bbk: MICRO_BBK,
    tp: MICRO_TP, sl: MICRO_SL, hold: MICRO_HOLD
  }).toString();
  const r = await httpFetch(`${base}/api/combined/signal?${q}`, { cache: "no-store" });
  const js = await r.json();
  return js.signals || [];
}

function microLine(sig) {
  if (!sig || !sig.available) return "• Micro: —";
  if (sig.combined) {
    return `• Micro: ⚡ BUY — TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h\n  Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt}`;
  }
  if (sig.v4 && !sig.dip) return "• Micro: 👀 Watch (v4 OK) — waiting flip-dip (±30m)";
  return "• Micro: —";
}

function formatGoSnapshot(goMap, sigs) {
  const m = {}; (sigs || []).forEach(s => { m[s.coin] = s; });
  const lines = [];
  lines.push(`⏱️ Snapshot ${mytNow()} MYT`, "");
  for (const c of MICRO_COINS) {
    const st = (goMap[c]?.state || "NO-GO").toUpperCase();
    lines.push(`${c.toUpperCase()} — ${st === "GO" ? "🟢 GO" : "🔴 NO-GO"} [24h]`);
    lines.push(microLine(m[c]));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatWhyAll(goMap, sigs) {
  const m = {}; (sigs || []).forEach(s => { m[s.coin] = s; });
  const out = [];
  for (const c of MICRO_COINS) {
    const st = (goMap[c]?.state || "NO-GO").toUpperCase();
    const s = m[c];
    const pu = s ? (s.p_up*100).toFixed(1) : null;
    const b  = (s && Number.isFinite(s.bucket7d)) ? `${s.bucket7d>=0?"+":""}${(s.bucket7d*100).toFixed(2)}%` : "—";
    out.push(`${c.toUpperCase()} — ${st === "GO" ? "🟢 GO" : "🔴 NO-GO"} [24h]`);
    out.push(`• v4: ${s ? `p_up ${pu}% • n=${s.n} • 7d ${b}` : "—"}`);
    out.push(s ? (s.combined ? `• Micro: ⚡ BUY active` : (s.v4 ? `• Micro: 👀 Watch (v4 OK)` : `• Micro: —`)) : `• Micro: —`);
    out.push("");
  }
  return out.join("\n").trim();
}

function formatWhyOne(coin, goMap, sig) {
  const st = (goMap[coin]?.state || "NO-GO").toUpperCase();
  const pu = sig ? (sig.p_up*100).toFixed(1) : null;
  const b  = (sig && Number.isFinite(sig.bucket7d)) ? `${sig.bucket7d>=0?"+":""}${(sig.bucket7d*100).toFixed(2)}%` : "—";
  const preset = `p≥${MICRO_P}, n≥${MICRO_N}, bucket≥${MICRO_B}, dip=flip, window ±${MICRO_W}m, BB ${MICRO_BBK}σ`;
  const L = [];
  L.push(`${coin.toUpperCase()} — status`);
  L.push(`[24h] ${st}: classic rule (70–74% band)`);
  L.push(`Micro preset: ${preset}.`);
  if (!sig) {
    L.push("• v4: —"); L.push("• dip: —"); L.push("• Micro: —");
  } else {
    L.push(`• v4: ${sig.v4 ? "OK" : "OFF"} (p_up ${pu ?? "—"}%, n=${sig.n ?? "—"}, 7d ${b})`);
    L.push(`• dip: ${sig.dip ? "ON (flip)" : "OFF"}`);
    if (sig.combined) {
      L.push(`• Micro: ⚡ BUY — TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h`);
      L.push(`  Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt}`);
    } else if (sig.v4 && !sig.dip) {
      L.push(`• Micro: 👀 Watch (v4 OK) — awaiting flip-dip (±${MICRO_W}m)`);
    } else {
      L.push(`• Micro: —`);
    }
  }
  L.push("Trade rule on BUY: TP +0.30% • SL −0.20% • max 2h.");
  return L.join("\n");
}

// ==== Telegram webhook ====
router.post("/", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg || typeof msg.text !== "string") return res.sendStatus(200);

    const chatId = msg.chat?.id;
    const text = msg.text.trim();
    const base = cmdBase(text);                // handles /go and /go@YourBot
    const arg  = text.slice((text.split(/\s+/)[0] || "").length).trim();

    // Optional whitelist
    if (CHAT_WHITELIST.length && !CHAT_WHITELIST.includes(String(chatId))) {
      await tgSend(chatId, "Sorry, this bot is restricted.");
      return res.sendStatus(200);
    }

    // /start or /help
    if (base === "/start" || base === "/help") {
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

    // /go (combined snapshot)
    if (base === "/go") {
      const [sigs, goMap] = await Promise.all([
        getMicroSignals(req), getGoStates()
      ]);
      const out = formatGoSnapshot(goMap, sigs);
      await tgSend(chatId, out);
      return res.sendStatus(200);
    }

    // /why
    if (base === "/why") {
      const [sigs, goMap] = await Promise.all([
        getMicroSignals(req), getGoStates()
      ]);

      // /why micro
      if (arg.toLowerCase() === "micro") {
        const explain = [
          "Micro-Combined (0.5–2h): v4-xau filter (p≥0.55, n≥50, bucket≥−0.001) AND dip “flip”",
          "(RSI turns up after oversold or band-touch) within ±30m; Bollinger 1.5σ.",
          "Exit: TP +0.30%, SL −0.20%, max 2h.",
          "Standby (optional alert): v4 ON + proximity cues (RSI rising near oversold, near/touched band, small rejection)."
        ].join("\n");
        await tgSend(chatId, explain);
        return res.sendStatus(200);
      }

      // /why btc | /why eth | /why (all)
      const coin = coinNorm(arg);
      if (!coin || !MICRO_COINS.includes(coin)) {
        const out = formatWhyAll(goMap, sigs);
        await tgSend(chatId, out);
        return res.sendStatus(200);
      }
      const sig = (sigs || []).find(s => s.coin === coin);
      const out = formatWhyOne(coin, goMap, sig);
      await tgSend(chatId, out);
      return res.sendStatus(200);
    }

    // Unknown → short help (keeps old behavior friendly)
    await tgSend(chatId, "Unknown command. Try /go or /why.");
    return res.sendStatus(200);
  } catch (e) {
    console.error("[tg]", e);
    // Prevent Telegram retry storms
    try {
      const chatId = req.body?.message?.chat?.id || req.body?.edited_message?.chat?.id;
      if (chatId) await tgSend(chatId, "Oops, temporary error. Try again in a minute.");
    } catch {}
    return res.sendStatus(200);
  }
});

// Health-check
router.get("/ping", (req, res) => res.send("ok"));

export default router;
