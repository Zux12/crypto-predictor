// /public/chips.js  — SAFE v2 (no MutationObserver)
(() => {
  const QS = (s, r=document) => r.querySelector(s);
  const idToCoin = { btc: "bitcoin", eth: "ethereum" };

  // Feature flags (persisted via localStorage)
  const flags = {
    SHOW_CONF: localStorage.getItem("SHOW_CONF") !== "off", // default ON
    SHOW_DIP:  localStorage.getItem("SHOW_DIP")  === "on"   // default OFF
  };

  // Wire topbar toggles if they exist
  function wireToggles() {
    const tConf = QS("#toggle-conf");
    const tDip  = QS("#toggle-dip");
    if (tConf) {
      tConf.checked = !!flags.SHOW_CONF;
      tConf.onchange = () => {
        flags.SHOW_CONF = tConf.checked;
        localStorage.setItem("SHOW_CONF", flags.SHOW_CONF ? "on" : "off");
        hydrateAll();
      };
    }
    if (tDip) {
      tDip.checked = !!flags.SHOW_DIP;
      tDip.onchange = () => {
        flags.SHOW_DIP = tDip.checked;
        localStorage.setItem("SHOW_DIP", flags.SHOW_DIP ? "on" : "off");
        hydrateAll();
      };
    }
  }

  // Parse "p_up=60.3% • 7d(70–74%) +0.43% (n=92)"
  const RE_PUP = /p[_ ]?up\s*=\s*([\d.]+)%/i;
  const RE_N   = /\(n=(\d+)\)/i;
  const RE_BKT = /7d\([^)]*\)\s*([+\-]?\d+(?:\.\d+)?)%/i;

  function parseMetrics(text) {
    if (!text) return {};
    const p = RE_PUP.exec(text)?.[1];
    const n = RE_N.exec(text)?.[1];
    const b = RE_BKT.exec(text)?.[1];
    return {
      p_up: p ? Number(p) : undefined,
      n: n ? Number(n) : undefined,
      bucket: b != null ? Number(b) : undefined
    };
  }

  function buildConfChip(m) {
    const el = document.createElement("div");
    const bad  = (!isFinite(m.p_up) || m.p_up < 50) || (isFinite(m.bucket) && m.bucket < 0);
    const ok   = (m.p_up >= 55) && (!isFinite(m.bucket) || m.bucket >= 0);
    const clazz = bad ? "bad" : (ok ? "ok" : "warn");
    el.className = `chip chip-conf ${clazz}`;
    el.innerHTML = `<span class="dot"></span><b>Conf</b> ${isFinite(m.p_up)?m.p_up.toFixed(1):"?"}%`
      + (isFinite(m.n)?` • n=${m.n}`:"")
      + (isFinite(m.bucket)?` • 7d ${m.bucket>=0?"+":""}${m.bucket.toFixed(2)}%`:"");
    el.title = "Confidence hint: p_up • sample size n • recent 7d bucket average";
    return el;
  }

  function buildDipChip(on) {
    if (!on) return null;
    const el = document.createElement("div");
    el.className = "chip chip-dip";
    el.innerHTML = `<span class="dot"></span><b>Near-dip</b>`;
    el.title = "Informational: suggests an emerging dip-reversal zone";
    return el;
  }

  function hydrateRow(rowEl) {
    if (!rowEl) return;

    // Derive a key so we update only when needed
    const txt = rowEl.textContent || "";
    const m = parseMetrics(txt);
    const attrOn = rowEl.getAttribute("data-near-dip") === "1";
    const coin = idToCoin[rowEl.id] || rowEl.id;
    const mapOn  = (window.NEAR_DIP_MAP && (window.NEAR_DIP_MAP[coin] === true)) || false;
    const key = [
      rowEl.id,
      flags.SHOW_CONF ? (m.p_up ?? "?") : "x",
      flags.SHOW_CONF ? (m.n ?? "?") : "x",
      flags.SHOW_CONF ? (m.bucket ?? "?") : "x",
      flags.SHOW_DIP ? (attrOn || mapOn ? 1 : 0) : 0
    ].join("|");

    if (rowEl.dataset.chipsKey === key) return; // no changes

    // Build/replace chips
    let chips = rowEl.querySelector(".chips");
    if (!chips) { chips = document.createElement("div"); chips.className = "chips"; rowEl.appendChild(chips); }
    chips.innerHTML = "";

    if (flags.SHOW_CONF && (isFinite(m.p_up) || isFinite(m.n) || isFinite(m.bucket))) {
      chips.appendChild(buildConfChip(m));
    }
    if (flags.SHOW_DIP) {
      const dipEl = buildDipChip(attrOn || mapOn);
      if (dipEl) chips.appendChild(dipEl);
    }

    rowEl.dataset.chipsKey = key; // remember state
  }

  function hydrateAll() {
    hydrateRow(QS("#btc"));
    hydrateRow(QS("#eth"));
  }

  // Initial + delayed passes to catch async rendering from go.js
  document.addEventListener("DOMContentLoaded", () => {
    wireToggles();
    hydrateAll();
    setTimeout(hydrateAll, 600);
    setTimeout(hydrateAll, 2000);
  });

  // Re-hydrate after user hits "Refresh"
  const btn = QS("#refresh");
  if (btn) btn.addEventListener("click", () => setTimeout(hydrateAll, 800));
})();
