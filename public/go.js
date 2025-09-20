async function fetchJSON(u){ const r=await fetch(u,{cache:"no-store"}); if(!r.ok) throw new Error(r.statusText); return r.json(); }
function fmtPct(x){ return (x==null) ? "—" : (x*100).toFixed(2)+"%"; }
function fmtMissed(r){ if(!r || typeof r.realized_ret!=="number") return "—"; const p=(r.realized_ret*100).toFixed(2); return (r.realized_ret>=0?"+":"") + p + "%"; }

function renderCoin(id, name, d){
  const el = document.getElementById(id);
  if (!d){ el.innerHTML = `<div class="coin"><span>${name}</span><span class="nogo">NO DATA</span></div>`; return; }
  const cls = d.status === "GO" ? "go" : "nogo";
  el.innerHTML = `
    <div class="coin">
      <span>${name.toUpperCase()}</span>
      <span class="status ${cls}">${d.status.replace("_","-")}</span>
    </div>
    <div class="muted" style="margin-top:6px">${d.reason}</div>
    <div class="timers">
      <div>Entry: <span id="${id}-entry"></span></div>
      <div>Exit: <span id="${id}-exit"></span></div>
      <div>Prev GO (24h): <span>${fmtMissed(d.lastMissed)}</span></div>
    </div>
  `;
  tickCountdown(`${id}-entry`, d.entryCountdownSec);
  tickCountdown(`${id}-exit`, d.exitCountdownSec);
}

function tickCountdown(spanId, secs){
  const el = document.getElementById(spanId);
  function fmt(s){
    const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
    return h>0 ? `${h}h ${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
               : `${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  }
  el.textContent = fmt(secs);
  const t = setInterval(()=>{
    secs = Math.max(0, secs-1);
    el.textContent = fmt(secs);
    if (secs<=0) clearInterval(t);
  },1000);
}

async function run(){
  const j = await fetchJSON("/api/go?_="+Date.now());
  document.getElementById("asof").textContent = `as of ${new Date(j.asof).toLocaleString()}`;
  renderCoin("btc","BTC", j.coins.bitcoin);
  renderCoin("eth","ETH", j.coins.ethereum);
}

document.getElementById("refresh").addEventListener("click", ()=>run().catch(()=>{}));
window.addEventListener("load", ()=>run().catch(()=>{}));
setInterval(()=>run().catch(()=>{}), 90_000);
