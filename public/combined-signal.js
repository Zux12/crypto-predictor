/* /public/combined-signal.js */

/* ===== Debug & Build marker ===== */
const DEBUG = true;
const BUILD_TAG = "cs-20250921-1555"; // bump this string each deploy to verify cache bust
console.log("[combined-signal] loaded", BUILD_TAG);

(function showBuildBadge() {
  const top = document.querySelector(".topbar");
  if (!top) return;
  let el = document.getElementById("build-badge");
  if (!el) {
    el = document.createElement("span");
    el.id = "build-badge";
    el.className = "badge";
    top.appendChild(el);
  }
  el.textContent = `UI ${BUILD_TAG} ✓`;
})();

/* ===== BUY/Watch chips from /api/combined/signal (Micro-Combined v1) ===== */
(() => {
  const QS = (s, r = document) => r.querySelector(s);
  const idMap = { bitcoin: "btc", ethereum: "eth" };

  // Preset = Micro-Combined v1 (the one that cleared ≥70% in diagnostics)
  const PRESET = {
    coins: "bitcoin,ethereum",
    p: 0.55,        // lets today's ETH pass v4 gate
    b: -0.001,      // allow small negative bucket (≈ -0.025% becomes OK)
    w: 30,          // ±30 minutes dip window
    rsi: 35,
    mode: "flip",   // RSI turning up after oversold / band-touch
    bbk: 1.5,       // Bollinger sigma (1.5σ)
    tp: 0.003,      // +0.30% take-profit
    sl: 0.002,      // -0.20% stop-loss
    hold: 2         // max hold 2h
  };

  function chip(text, cls = "ok", title = "") {
    const el = document.createElement("div");
    el.className = `chip chip-signal ${cls}`;
    el.innerHTML = `<span class="dot"></span>${text}`;
    if (title) el.title = title;
    return el;
  }

  function ensureChipsContainer(row) {
    let box = row.querySelector(".chips");
    if (!box) {
      box = document.createElement("div");
      box.className = "chips";
      row.appendChild(box);
    }
    return box;
  }

  function upsertSignal(row, sig) {
    if (!row) return;
    const box = ensureChipsContainer(row);

    // Remove only our signal chips; keep your existing Conf chips intact
    Array.from(box.querySelectorAll(".chip-signal")).forEach(n => n.remove());

    if (!sig || !sig.available) {
      if (DEBUG) {
        const dbg = chip("dbg no-data", "warn", "debug view");
        dbg.style.opacity = 0.7;
        box.appendChild(dbg);
      }
      return;
    }

    if (sig.combined) {
      const txt = `<b>⚡ BUY (Micro)</b> TP +${(sig.tp * 100).toFixed(2)}% • SL −${(sig.sl * 100).toFixed(2)}% • max ${sig.max_hold_h}h`;
      const tip = `Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt} • p_up=${(sig.p_up * 100).toFixed(1)}% • n=${sig.n}`;
      box.appendChild(chip(txt, "ok", tip));
    } else if (sig.v4 || sig.dip) {
      // Not both yet → show a Watch chip so you can see the state in the UI
      const txt = `<b>Watch</b> ${sig.v4 ? "v4 OK" : ""} ${sig.dip ? "dip OK" : ""}`.trim();
      const tip = `v4=${sig.v4} • dip=${sig.dip} • p_up=${(sig.p_up * 100).toFixed(1)}% • n=${sig.n}`;
      box.appendChild(chip(txt, "warn", tip));
    }

    // --- DEBUG chip (always last) ---
    if (DEBUG) {
      const dbg = chip(`dbg v4:${sig.v4} dip:${sig.dip}`, "warn", "debug view");
      dbg.style.opacity = 0.7;
      box.appendChild(dbg);
    }
  }

  async function loadSignals() {
    try {
      const q = new URLSearchParams(PRESET).toString();
      const res = await fetch(`/api/combined/signal?${q}`, { cache: "no-store" });
      const js = await res.json();
      if (DEBUG) console.log("[combined-signal] params", PRESET, js);

      (js.signals || []).forEach(s => {
        const id = idMap[s.coin] || s.coin;
        upsertSignal(QS(`#${id}`), s);
      });
    } catch (e) {
      console.error("[combined-signal]", e);
    }
  }

  function scheduleLoads() {
    // Multiple delayed calls so we render after /go.js populates the rows
    setTimeout(loadSignals, 600);
    setTimeout(loadSignals, 1500);
    setTimeout(loadSignals, 3000);
    setTimeout(loadSignals, 5000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    scheduleLoads();
    const btn = QS("#refresh");
    if (btn) btn.addEventListener("click", () => setTimeout(loadSignals, 800));
  });
})();
