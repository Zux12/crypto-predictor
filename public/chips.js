// /public/chips.js
(() => {
  const QS = (s, r=document) => r.querySelector(s);
  const QSA = (s, r=document) => Array.from(r.querySelectorAll(s));
  const idToCoin = { btc: "bitcoin", eth: "ethereum" };

  // Feature flags (persisted)
  const flags = {
    SHOW_CONF: localStorage.getItem("SHOW_CONF") !== "off", // default ON
    SHOW_DIP:  localStorage.getItem("SHOW_DIP")  === "on"   // default OFF
  };

  // Wire topbar toggles if present
  const tConf = QS("#toggle-conf");
  const tDip  = QS("#toggle-dip");
  if (tConf) { tConf.checked = !!flags.SHOW_CONF; tConf.onchange = () => { flags.SHOW_CONF = tConf.checked; localStorage.setItem("SHOW_CONF", flags.SHOW_CONF ? "on" : "off"); hydrateAll(); }; }
  if (tDip)  { tDip.checked  = !!flags.SHOW_DIP;  tDip.onchange  = () => { flags.SHOW_DIP  = tDip.checked;  localStorage.setItem("SHOW_DIP",  flags.SHOW_DIP  ? "on" : "off");  hydrateAll(); }; }

  // Parse a "reason" text like: p_up=60.3% • 7d(70–74%) +0.43% (n=92)
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

  // Build confidence chip element
  function buildConfChip(m) {
    const wrap = document.createElement("div");
    const clazz = (!isFinite(m.p_up) || m.p_up < 50 || (isFinite(m.bucket) && m.bucket < 0))
      ? "bad" : (m.p_up >= 55 && (!isFinite(m.bucket) || m.bucket >= 0) ? "ok" : "warn");
    wrap.className = `chip chip-conf ${clazz}`;
    wrap.innerHTML = `<span class="dot"></span><b>Conf</b> ${isFinite(m.p_up)?m.p_up.toFixed(1):"?"}%` +
      (isFinite(m.n)?` • n=${m.n}`:"") + (isFinite(m.bucket)?` • 7d ${m.bucket>=0?"+":""}${m.bucket.toFixed(2)}%`:"");
    wrap.title = "Confidence hint: p_up • sample size n • recent 7d bucket average";
    return wrap;
  }

  // Build near-dip chip (uses window.NEAR_DIP_MAP or data-near-dip attr)
  function buildDipChip(isOn) {
    if (!isOn) return null;
    const wrap = document.createElement("div");
    wrap.className = "chip chip-dip";
    wrap.innerHTML = `<span class="dot"></span><b>Near-dip</b>`;
    wrap.title = "Informational: backend/user flag suggests an emerging dip-reversal zone";
    return wrap;
  }

  function hydrateRow(rowEl) {
    if (!rowEl) return;

    // Ensure chips container exists
    let chips = rowEl.querySelector(".chips");
    if (!chips) {
      chips = document.createElement("div");
      chips.className = "chips";
      rowEl.appendChild(chips);
    }
    chips.innerHTML = ""; // clear old chips

    const rawText = rowEl.textContent || "";
    const m = parseMetrics(rawText);

    if (flags.SHOW_CONF && (isFinite(m.p_up) || isFinite(m.n) || isFinite(m.bucket))) {
      chips.appendChild(buildConfChip(m));
    }

    if (flags.SHOW_DIP) {
      // coin id -> window.NEAR_DIP_MAP[coin] or data attribute
      const id = rowEl.id; // "btc" | "eth"
      const coin = idToCoin[id] || id;
      const attrOn = rowEl.getAttribute("data-near-dip") === "1";
      const mapOn  = (window.NEAR_DIP_MAP && (window.NEAR_DIP_MAP[coin] === true)) || false;
      const dipEl = buildDipChip(attrOn || mapOn);
      if (dipEl) chips.appendChild(dipEl);
    }
  }

  function hydrateAll() {
    hydrateRow(QS("#btc"));
    hydrateRow(QS("#eth"));
  }

  // Observe updates from /go.js rendering
  const mo = new MutationObserver(() => hydrateAll());
  QSA("#btc, #eth").forEach(el => mo.observe(el, { childList:true, subtree:true }));

  // Initial pass (in case content is already present)
  document.addEventListener("DOMContentLoaded", hydrateAll);
  setTimeout(hydrateAll, 600); // extra pass after go.js likely finishes
})();
