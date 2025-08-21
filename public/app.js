const coins = ["bitcoin","ethereum"];

function fmt(n, d=2){ return typeof n === "number" ? n.toFixed(d) : "—"; }
function pill(p){
  if (typeof p !== "number") return `<span class="pill">—</span>`;
  const good = p >= 0.5;
  return `<span class="pill ${good ? "good":"bad"}">${(p*100).toFixed(1)}%</span>`;
}

async function fetchJSON(url){
  try {
    const r = await fetch(url, { headers: { "accept": "application/json" }});
    if (!r.ok) {
      console.warn("[fetchJSON] non-200", url, r.status);
      return { ok: false, _http: r.status, _url: url };
    }
    try {
      return await r.json();
    } catch (parseErr) {
      console.error("[fetchJSON] JSON parse error", url, parseErr);
      return { ok: false, _parse: true, _url: url };
    }
  } catch (e) {
    console.error("[fetchJSON] network error", url, e);
    return { ok: false, _err: String(e), _url: url };
  }
}


async function load(){
  const [prices, preds, scores] = await Promise.all([
    fetchJSON(`/api/prices/latest?coins=${coins.join(",")}`),
    fetchJSON(`/api/predictions/latest?coins=${coins.join(",")}`),
    fetchJSON(`/api/scores/summary?days=7`) // fetchJSON is resilient
  ]);

  // Prices (resilient if results missing)
  const pDiv = document.getElementById("prices");
  const priceResults = prices?.results || {};
  pDiv.innerHTML = coins.map(c=>{
    const row = priceResults[c] || {};
    return `<div class="row"><span>${c}</span><strong>$${fmt(row.price, 2)}</strong></div>`;
  }).join("");

  // Predictions (show multiple models per coin)
  const prDiv = document.getElementById("preds");
  prDiv.innerHTML = coins.map(c=>{
    const arr = (preds?.results?.[c] || []).slice(); // copy to avoid mutating
    // sort latest first
    arr.sort((a,b)=> new Date(b.ts) - new Date(a.ts));

    const activeModel = (window.ACTIVE_MODEL || "v3-macd-bb");

    if (!arr.length) {
      return `
        <div class="row"><strong>${c}</strong><span></span></div>
        <div class="row" style="margin-left:12px">
          <span class="muted">no predictions yet</span>
        </div>`;
    }

    const lines = arr.map(row=>{
      const p = row.p_up;
      const t = row.ts ? new Date(row.ts).toLocaleString() : "—";
      const model = row.model_ver || "—";
      const isActive = (model === activeModel);
      const tag = isActive ? `<span class="pill good" style="margin-right:6px">active</span>` : "";
      return `
        <div class="row" style="margin-left:12px">
          <span class="muted">• ${model}</span>
          <span>
            ${tag}${pill(p)}
            <span class="muted" style="margin-left:8px">${t}</span>
          </span>
        </div>`;
    }).join("");

    return `
      <div class="row"><strong>${c}</strong><span></span></div>
      ${lines}
    `;
  }).join("");

  // Scores
  const sDiv = document.getElementById("scores");
  if (scores?.ok && (scores.overall || (scores.byCoin && scores.byCoin.length))){
    const overall = scores.overall
      ? `<div class="row"><span>Overall</span><span>n=${scores.overall.n} • acc=${fmt(scores.overall.accuracy*100,1)}% • brier=${fmt(scores.overall.brier,4)}</span></div>`
      : "";
    const per = (scores.byCoin||[]).map(x =>
      `<div class="row"><span>${x.coin}</span><span>n=${x.n} • acc=${fmt(x.accuracy*100,1)}% • brier=${fmt(x.brier,4)}</span></div>`
    ).join("");
    sDiv.innerHTML = overall + per;
  } else {
    sDiv.textContent = "Waiting for first 24h to mature…";
  }

  document.getElementById("last-upd").textContent = `Last updated: ${new Date().toLocaleString()}`;
}



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



// --- Monitoring client helpers ---
function svgBarChart(pairs, width=600, height=120, pad=6){
  // pairs: [{xLabel, pred, real, n}]
  if (!pairs?.length) return '<div class="muted">No data</div>';
  const w = width, h = height;
  const barW = (w - pad*2) / pairs.length;
  let maxY = 1; // probs in [0,1]
  const y = v => h - pad - v * (h - pad*2);
  const barsPred = pairs.map((p,i)=>{
    const x = pad + i*barW + barW*0.15;
    const bh = (h - pad*2) * p.pred;
    return `<rect x="${x}" y="${y(p.pred)}" width="${barW*0.3}" height="${bh}" fill="currentColor" opacity="0.7">
      <title>bin ${p.xLabel} • pred ${p.pred.toFixed(2)} • n=${p.n}</title></rect>`;
  }).join("");
  const barsReal = pairs.map((p,i)=>{
    const x = pad + i*barW + barW*0.55;
    const bh = (h - pad*2) * p.real;
    return `<rect x="${x}" y="${y(p.real)}" width="${barW*0.3}" height="${bh}" fill="currentColor" opacity="0.35">
      <title>bin ${p.xLabel} • real ${p.real.toFixed(2)} • n=${p.n}</title></rect>`;
  }).join("");
  const xLabels = pairs.map((p,i)=>{
    const x = pad + i*barW + barW/2;
    return `<text x="${x}" y="${h-2}" font-size="10" text-anchor="middle" fill="#9ca3af">${p.xLabel}</text>`;
  }).join("");

  // diagonal reference line (perfect calibration)
  const line = `<line x1="${pad}" y1="${y(0)}" x2="${w-pad}" y2="${y(1)}" stroke="#64748b" stroke-dasharray="4 4"/>`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    ${line}${barsPred}${barsReal}${xLabels}
  </svg>
  <div class="muted" style="margin-top:6px">Dark bars = predicted, light bars = realized. Hover for counts.</div>`;
}

function toISOrow(r){
  const mm = String(r.m).padStart(2,"0"); const dd = String(r.d).padStart(2,"0");
  const hh = r.h==null ? "" : " " + String(r.h).padStart(2,"0") + ":00";
  return `${r.y}-${mm}-${dd}${hh}`;
}

function svgLine(points, width=600, height=120, pad=6){
  if (!points?.length) return '<div class="muted">No data</div>';
  const vals = points.map(p=>p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const stepX = (width - pad*2) / (points.length - 1);
  const y = v => height - pad - ((v - min) / span) * (height - pad*2);
  const poly = points.map((p,i)=>`${pad + i*stepX},${y(p.v)}`).join(' ');
  const dots = points.map((p,i)=>`<circle cx="${pad + i*stepX}" cy="${y(p.v)}" r="2">
    <title>${p.t} • ${p.v.toFixed(3)} (${p.n} labels)</title></circle>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">
    <polyline fill="none" stroke="currentColor" stroke-width="2" points="${poly}" />
    ${dots}
  </svg>`;
}

async function loadMonitoring(){
  // calibration (30d, 10 bins, all coins)
  const calib = await fetchJSON(`/api/scores/calibration?days=30&bins=10&coin=all`).catch(()=>({ok:false}));
  const calibDiv = document.getElementById("calibration");
  if (calib?.ok && calib.rows?.length){
    // build pairs for chart
    const pairs = calib.rows.map(r=>{
      const lo = (r.bin / calib.bins).toFixed(2);
      const hi = ((r.bin+1) / calib.bins).toFixed(2);
      return { xLabel: `${lo}-${hi}`, pred: r.avg_pred, real: r.avg_real, n: r.n };
    });
    calibDiv.innerHTML = svgBarChart(pairs, 600, 120);
  } else {
    calibDiv.textContent = "Waiting for labels…";
  }

  // accuracy trend (30d by day, all coins)
  const acc = await fetchJSON(`/api/scores/accuracy_trend?days=30&bucket=day&coin=all`).catch(()=>({ok:false}));
  const accDiv = document.getElementById("acc-trend");
  if (acc?.ok && acc.rows?.length){
    const pts = acc.rows.map(r=>({ t: toISOrow(r), v: r.accuracy, n: r.n }));
    accDiv.innerHTML = svgLine(pts, 600, 120);
  } else {
    accDiv.textContent = "Waiting for labels…";
  }
}


async function loadByModel(){
  console.log("[Dashboard] loadByModel() called");
  const div = document.getElementById("by-model");
  try {
    const j = await fetchJSON(`/api/scores/by_model?days=30`);
    console.log("[Dashboard] by_model response:", j);

    if (!j?.ok || !j.rows?.length) {
      div.textContent = "Waiting for labels…";
      return;
    }

    div.innerHTML = j.rows.map(r => `
      <div class="row">
        <span>${r.model_ver || '—'}</span>
        <span>n=${r.n} • acc=${fmt((r.accuracy||0)*100,1)}% • brier=${fmt(r.brier,4)}</span>
      </div>
    `).join("");
  } catch (e) {
    console.error("[Dashboard] loadByModel error:", e);
    div.textContent = "Failed to load.";
  }
}

async function loadLabelsCard(){
  const box = document.getElementById("labels-card");
  try {
    const j = await fetchJSON(`/api/debug/labels?limit=8`);
    // Debug log (remove later if noisy)
    console.log("[Dashboard] labels response:", j);

    if (!j?.ok || !j.rows || !j.rows.length) {
      box.textContent = "Waiting for first 24h to mature…";
      return;
    }

    // Render compact rows
    box.innerHTML = j.rows.map(r=>{
      const ts = new Date(r.pred_ts).toLocaleString();
      const coin = r.coin || "—";
      const up   = r.label_up ? "↑" : "↓";
      const p    = typeof r.p_up === "number" ? (r.p_up*100).toFixed(1) + "%" : "—";
      const acc  = r.correct ? "✅" : "❌";
      const brier = (typeof r.brier === "number") ? r.brier.toFixed(4) : "—";
      return `
        <div class="row" style="gap:10px">
          <span class="muted" style="min-width:160px">${ts}</span>
          <strong style="min-width:90px">${coin}</strong>
          <span style="min-width:70px">${up}</span>
          <span style="min-width:100px">p_up ${p}</span>
          <span style="min-width:70px">${acc}</span>
          <span class="muted" style="min-width:100px">brier ${brier}</span>
        </div>`;
    }).join("");
  } catch (e) {
    console.error("[Dashboard] loadLabelsCard error:", e);
    box.textContent = "Failed to load labels.";
  }
}

async function loadPnL(){
  const box = document.getElementById("pnl-card");
  try {
    const j = await fetchJSON(`/api/paper/pnl`);
    if (!j?.ok || !j.pnl) {
      box.textContent = "No PnL yet.";
      return;
    }
    const p = j.pnl;
    const net = p.net_pnl_usd.toFixed(2);
    const pct = p.net_pnl_pct.toFixed(2);
    const color = p.net_pnl_usd >= 0 ? "good" : "bad";
    box.innerHTML = `
      <div class="row"><span>Start</span><span>$${fmt(p.start_balance,2)}</span></div>
      <div class="row"><span>Current</span><span>$${fmt(p.current_equity,2)}</span></div>
      <div class="row"><span>PnL</span><span class="${color}">$${net} (${pct}%)</span></div>
      <div class="row"><span>Total Fees</span><span>$${fmt(p.total_fees,2)}</span></div>
    `;
  } catch (e) {
    box.textContent = "Failed to load PnL.";
  }
}


// ---- override load() ONCE, then call it + schedule auto-refresh ----
const originalLoad = load;
load = async function(){
  try {
    await originalLoad();
    await loadPaper();
    await loadMonitoring();
    await loadByModel();
    await loadLabelsCard();
    await loadPnL();   // 👈 new
  } catch (e) {
    console.error("[Dashboard] load error:", e);
  }
};


load();
setInterval(load, 30_000);

