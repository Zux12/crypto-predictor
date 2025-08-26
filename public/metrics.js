async function fetchJSON(u){
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status + " " + r.statusText);
  return r.json();
}
function fmtPct(x){ return (x==null) ? "—" : (x*100).toFixed(2)+"%"; }

async function run(){
  const out = document.getElementById("out");
  const note = document.getElementById("note");
  const hrs = Number(document.getElementById("hrs").value || 24);
  const th  = document.getElementById("th").value || "0.6,0.7";

  out.innerHTML = `<div class="muted">Loading…</div>`;
  note.textContent = "";

  try {
    // cache-buster to avoid 304 and stale bodies
    const url = `/api/metrics/v4-vs-xau?hrs=${hrs}&th=${encodeURIComponent(th)}&_=${Date.now()}`;
    const j = await fetchJSON(url);
    const rows = j.rows || [];

    let html = `<table><thead><tr>
      <th>Model</th><th>Thresh</th><th>Trades</th><th>Win</th><th>Loss</th><th>Flat</th><th>Avg 24h Ret</th>
    </tr></thead><tbody>`;
    for (const r of rows){
      const cls = (r.avgRet||0) >= 0 ? "good" : "bad";
      html += `<tr>
        <td>${r.model}</td>
        <td>${(r.th*100).toFixed(0)}%</td>
        <td>${r.n}</td>
        <td>${r.wins}</td>
        <td>${r.losses}</td>
        <td>${r.flats}</td>
        <td class="${cls}">${fmtPct(r.avgRet)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
    out.innerHTML = html;
    note.textContent = `Window=${j.hrs}h • thresholds=${(j.thresholds||[]).join(", ")}`;
  } catch (e) {
    out.innerHTML = `<div class="bad">Failed to load (${e.message}).</div>`;
  }
}

document.getElementById("run").addEventListener("click", ()=>run());
window.addEventListener("load", ()=>run());
setInterval(()=>run(), 60_000);
