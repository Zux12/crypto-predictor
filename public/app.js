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

// ---------- Helpers for paper trading UI ----------
function svgSparkline(values, width=600, height=100, pad=6){
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const stepX = (width - pad*2) / (values.length - 1);
  const normY = v => height - pad - ((v - min) / span) * (height - pad*2);
  const points = values.map((v,i)=>`${pad + i*stepX},${normY(v)}`).join(' ');
  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
      <polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}" />
    </svg>`;
}

async function loadPaper(){
  // fetch summary, equity series, trades
  const [summary, equity, trades] = await Promise.all([
    fetchJSON(`/api/paper/summary`).catch(()=>({ ok:false })),
    fetchJSON(`/api/paper/equity?limit=200`).catch(()=>({ ok:false })),
    fetchJSON(`/api/paper/trades?limit=20`).catch(()=>({ ok:false }))
  ]);

  // ----- Equity summary + sparkline -----
  const es = document.getElementById("equity-summary");
  const ec = document.getElementById("equity-chart");

  if (summary?.ok && summary.state){
    const s = summary.state;
    const eq = Number(s.equity_usd || 0);
    const cash = Number(s.cash_usd || 0);
    const upd = s.updated_at ? new Date(s.updated_at).toLocaleString() : "—";
    es.innerHTML = `
      <div class="row"><span>Equity</span><strong>$${fmt(eq,2)}</strong></div>
      <div class="row"><span>Cash</span><span>$${fmt(cash,2)}</span></div>
      <div class="row"><span>Holdings</span><span>${(s.holdings||[]).map(h=>`${h.coin}:${h.qty.toFixed(4)}`).join('  ') || "—"}</span></div>
      <div class="muted">Updated: ${upd}</div>
    `;
  } else {
    es.textContent = "No paper state yet (run jobs/paper.js once).";
  }

  if (equity?.ok && equity.rows?.length){
    const vals = equity.rows.map(r => Number(r.equity_usd || 0));
    ec.innerHTML = svgSparkline(vals, 600, 100);
  } else {
    ec.innerHTML = '<div class="muted">No equity history yet.</div>';
  }

  // ----- Recent trades table -----
  const tDiv = document.getElementById("trades");
  if (trades?.ok && trades.rows?.length){
    const rows = trades.rows.map(r=>{
      const ts = new Date(r.ts).toLocaleString();
      const pnl = (r.pnl_usd==null) ? "" : `$${fmt(r.pnl_usd,2)}`;
      const fee = `$${fmt(r.fee_usd,2)}`;
      return `
        <div class="row" style="gap:8px;">
          <span class="muted" style="min-width:160px">${ts}</span>
          <strong style="min-width:80px">${r.side}</strong>
          <span style="min-width:100px">${r.coin}</span>
          <span style="min-width:120px">px $${fmt(r.price,2)}</span>
          <span style="min-width:120px">qty ${fmt(r.qty,4)}</span>
          <span style="min-width:100px">fee ${fee}</span>
          <span style="min-width:120px">${pnl}</span>
          <span class="muted" style="min-width:140px">${r.reason||''}</span>
        </div>`;
    }).join("");
    tDiv.innerHTML = rows;
  } else {
    tDiv.innerHTML = '<div class="muted">No trades yet (waiting for thresholds).</div>';
  }
}

// hook into your existing loader + auto-refresh
const _origLoad = load;
load = async function(){
  await _origLoad();
  await loadPaper();
};


// auto-refresh every 30s
load();
setInterval(load, 30_000);

