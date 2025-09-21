// Lightweight fetch + render; no loops, no DOM churn
(() => {
  const QS = (s,r=document)=>r.querySelector(s);
  const idMap = { bitcoin: "btc", ethereum: "eth" };

  // Combined v1 preset (edit if you want to tighten later)
const PRESET = {
  coins: "bitcoin,ethereum",
  p: 0.55,        // keep 0.55 so today’s ETH can pass v4
  b: -0.001,      // allow slightly negative bucket (ETH is -0.025%)
  w: 30, rsi: 35, mode: "flip", bbk: 1.5,
  tp: 0.003, sl: 0.002, hold: 2
};


  function chip(text, cls="ok", title=""){
    const el = document.createElement("div");
    el.className = `chip chip-signal ${cls}`;
    el.innerHTML = `<span class="dot"></span>${text}`;
    if (title) el.title = title;
    return el;
  }

  function upsertSignal(row, sig){
    if (!row) return;
    let box = row.querySelector(".chips"); if (!box){ box = document.createElement("div"); box.className="chips"; row.appendChild(box); }
    // remove previous signal chips
    Array.from(box.querySelectorAll(".chip-signal")).forEach(n=>n.remove());
    if (!sig.available) return;

    if (sig.combined){
      const txt = `<b>⚡ BUY (Micro)</b> TP +${(sig.tp*100).toFixed(2)}% • SL −${(sig.sl*100).toFixed(2)}% • max ${sig.max_hold_h}h`;
      const tip = `Entry until ${sig.entry_until_myt} • Exit by ${sig.exit_by_myt} • v4 p_up=${(sig.p_up*100).toFixed(1)}% n=${sig.n}`;
      box.appendChild(chip(txt, "ok", tip));
    } else if (sig.v4 || sig.dip){
      const txt = `<b>Watch</b> ${sig.v4 ? "v4 OK" : ""} ${sig.dip ? "dip OK" : ""}`.trim();
      const tip = `v4=${sig.v4} dip=${sig.dip} • p_up=${(sig.p_up*100).toFixed(1)}% n=${sig.n}`;
      box.appendChild(chip(txt, "warn", tip));
    }
  }

  async function loadSignals(){
    try{
      const q = new URLSearchParams(PRESET).toString();
      const res = await fetch(`/api/combined/signal?${q}`, { cache:"no-store" });
      const js = await res.json();
      (js.signals||[]).forEach(s => {
        const id = idMap[s.coin] || s.coin;
        upsertSignal(QS(`#${id}`), s);
      });
    }catch(e){ console.error("[combined-signal]", e); }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(loadSignals, 600);   // after go.js renders
    const btn = QS("#refresh");
    if (btn) btn.addEventListener("click", () => setTimeout(loadSignals, 800));
  });
})();
