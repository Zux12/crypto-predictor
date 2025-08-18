const coins = ["bitcoin","ethereum"];

function fmt(n, d=2){ return typeof n === "number" ? n.toFixed(d) : "—"; }
function pill(p){
  if (typeof p !== "number") return `<span class="pill">—</span>`;
  const good = p >= 0.5;
  return `<span class="pill ${good ? "good":"bad"}">${(p*100).toFixed(1)}%</span>`;
}

async function fetchJSON(url){
  const r = await fetch(url, { headers: { "accept":"application/json" }});
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function load(){
  const [prices, preds, scores] = await Promise.all([
    fetchJSON(`/api/prices/latest?coins=${coins.join(",")}`),
    fetchJSON(`/api/predictions/latest?coins=${coins.join(",")}`),
    fetchJSON(`/api/scores/summary?days=7`).catch(()=>({ ok:false })) // will be empty until 24h
  ]);

  // Prices
  const pDiv = document.getElementById("prices");
  pDiv.innerHTML = coins.map(c=>{
    const row = prices.results?.[c];
    return `<div class="row"><span>${c}</span><strong>$${fmt(row?.price, 2)}</strong></div>`;
  }).join("");

  // Predictions
  const prDiv = document.getElementById("preds");
  prDiv.innerHTML = coins.map(c=>{
    const row = preds.results?.[c];
    const p = row?.p_up;
    const t = row?.ts ? new Date(row.ts).toLocaleString() : "—";
    return `<div class="row"><span>${c}</span><span>${pill(p)} <span class="muted" style="margin-left:8px">${t}</span></span></div>`;
  }).join("");

  // Scores
  const sDiv = document.getElementById("scores");
  if (scores?.ok && (scores.overall || (scores.byCoin && scores.byCoin.length))){
    const overall = scores.overall ? 
      `<div class="row"><span>Overall</span><span>n=${scores.overall.n} • acc=${fmt(scores.overall.accuracy*100,1)}% • brier=${fmt(scores.overall.brier,4)}</span></div>` 
      : "";
    const per = (scores.byCoin||[]).map(x=>(
      `<div class="row"><span>${x.coin}</span><span>n=${x.n} • acc=${fmt(x.accuracy*100,1)}% • brier=${fmt(x.brier,4)}</span></div>`
    )).join("");
    sDiv.innerHTML = overall + per;
  } else {
    sDiv.textContent = "Waiting for first 24h to mature…";
  }

  document.getElementById("last-upd").textContent = `Last updated: ${new Date().toLocaleString()}`;
}

document.getElementById("refresh").addEventListener("click", async (e)=>{
  e.target.disabled = true;
  try { await load(); } finally { e.target.disabled = false; }
});

// auto-refresh every 30s
load();
setInterval(load, 30_000);
