// Observatorio Legislativo — Pestaña Novedades (novedades.json, etapas_historico.json) y botón Compartir
// ── NOVEDADES (novedades.json y etapas_historico.json, generados por el scraper) ──
let _novPromise=null, _etapasPromise=null, NOV=null, novFiltradas=[], novMostradas=0;
const NOV_PAGINA=40;
const NOV_TIPOS={
  ley:{lbl:'Nueva ley',ico:'✔'}, avance:{lbl:'Avanza',ico:'▲'}, nuevo:{lbl:'Proyecto nuevo',ico:'+'},
  objetado:{lbl:'Objetado',ico:'!'}, detenido:{lbl:'Se detiene',ico:'■'}, cambio:{lbl:'Cambio de etapa',ico:'↔'},
};
const cargarJSON=url=>fetch(url).then(r=>r.ok?r.json():null).catch(()=>null);
const ensureNovedades=()=>_novPromise||(_novPromise=cargarJSON('novedades.json'));
const ensureEtapas=()=>_etapasPromise||(_etapasPromise=cargarJSON('etapas_historico.json'));
const diasEntre=(a,b)=>Math.round((new Date(b+'T12:00')-new Date(a+'T12:00'))/864e5);
const fmtFechaLarga=f=>new Date(f+'T12:00').toLocaleDateString('es-PA',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

function autorDeFicha(){
  if(autorDeFicha.m) return autorDeFicha.m;
  const m={}; (D.diputados||[]).forEach(d=>(d.proyectos_detalle||[]).forEach(p=>{ m[p.ficha]=d; }));
  return autorDeFicha.m=m;
}

async function initNovedades(){
  if(!D) return;
  NOV=await ensureNovedades();
  if(!NOV){ document.getElementById('nov-kpis').innerHTML='<div class="loader" style="grid-column:1/-1">Todavía no hay historial de novedades.</div>'; return; }
  const fin=NOV.actualizado, ev=NOV.eventos;
  const ult7=ev.filter(e=>diasEntre(e.fecha,fin)<7);
  const cuenta=t=>ult7.filter(e=>e.tipo===t).length;
  document.getElementById('nov-kpis').innerHTML=[
    {l:'Proyectos nuevos',v:cuenta('nuevo'),c:'var(--st-analisis)'},
    {l:'Avances de etapa',v:cuenta('avance'),c:'var(--st-debate)'},
    {l:'Nuevas leyes',v:cuenta('ley'),c:'var(--st-ley)'},
    {l:'Se detuvieron',v:cuenta('detenido')+cuenta('objetado'),c:'var(--st-sin)'},
  ].map(k=>`<div class="kpi" style="--kc:${k.c}"><div class="kpi-label">${k.l}</div><div class="kpi-value">${fmtNum(k.v)}</div><div class="kpi-sub">últimos 7 días</div></div>`).join('');
  const t=NOV.tiempo_ley||{};
  document.getElementById('nov-tiempo').innerHTML = t.n
    ? `<div class="nov-tiempo-num">${fmtNum(t.mediana)}<small>días (mediana)</small></div>
       <p class="monitor-note" style="margin-top:10px">Desde la presentación hasta que figura como ley. La mitad de los casos tardó entre <b>${fmtNum(t.p25)}</b> y <b>${fmtNum(t.p75)}</b> días.
       Se midieron <b>${t.n}</b> leyes detectadas a menos de ${NOV.precision_dias} días de ocurrir; las demás se excluyen porque no se sabe con precisión cuándo ocurrieron.</p>`
    : '<p class="monitor-note">Aún no hay suficientes leyes con fecha precisa.</p>';
  const huecos=(NOV.huecos||[]).map(h=>`del ${fmtFecha(h.desde)} al ${fmtFecha(h.hasta)}`);
  document.getElementById('nov-nota').innerHTML=`Fechas = día en que el observatorio detectó el cambio (la Asamblea no publica la fecha de cada paso). Historial desde el ${esc(fmtFecha(NOV.desde))}.`
    +(huecos.length?` No hubo extracciones ${esc(huecos.join(', '))}: los cambios detectados al final de ese periodo pueden haber ocurrido antes.`:'');
  renderNovedades();
}

function renderNovedades(){
  if(!NOV) return;
  const dias=+document.getElementById('nov-periodo').value, tipo=document.getElementById('nov-tipo').value;
  novFiltradas=NOV.eventos.filter(e=>(!dias||diasEntre(e.fecha,NOV.actualizado)<dias)&&(!tipo||e.tipo===tipo));
  novMostradas=0;
  document.getElementById('nov-lista').innerHTML = novFiltradas.length ? '' : '<div class="gs-empty">No hay novedades de este tipo en el periodo elegido.</div>';
  masNovedades();
}

function masNovedades(){
  const autores=autorDeFicha(), lista=document.getElementById('nov-lista');
  const lote=novFiltradas.slice(novMostradas, novMostradas+NOV_PAGINA);
  let ultima=novMostradas ? novFiltradas[novMostradas-1].fecha : null, html='';
  lote.forEach(e=>{
    if(e.fecha!==ultima){
      const n=novFiltradas.filter(x=>x.fecha===e.fecha).length;
      html+=`<div class="nov-fecha">${esc(fmtFechaLarga(e.fecha))} <small>${n} novedad${n===1?'':'es'}</small></div>`;
      ultima=e.fecha;
    }
    const t=NOV_TIPOS[e.tipo]||NOV_TIPOS.cambio, a=autores[e.ficha];
    const paso = e.de
      ? `<span class="badge ${etapaClass(e.de)}">${esc(e.de)}</span><span class="nov-flecha">→</span><span class="badge ${etapaClass(e.a)}">${esc(e.a)}</span>`
      : `<span class="badge ${etapaClass(e.a)}">${esc(e.a)}</span>`;
    html+=`<article class="nov-item t-${e.tipo}">
      <div class="nov-ico" aria-hidden="true">${t.ico}</div>
      <div><div class="nov-tipo">${t.lbl}${e.tipo==='avance'?' a '+esc(e.a):''}</div>
        <div class="nov-tit"><a href="#proyecto=${esc(e.ficha)}">${esc(e.titulo||'Sin título registrado')}</a></div>
        <div class="nov-meta"><span>Ficha ${esc(e.ficha)}</span>${paso}${a?`<span>Autor: <a href="#diputado=${esc(depSlug(a))}">${esc(a.nombre)}</a></span>`:''}</div></div>
    </article>`;
  });
  lista.insertAdjacentHTML('beforeend',html);
  novMostradas+=lote.length;
  const btn=document.getElementById('nov-mas');
  btn.style.display=novMostradas<novFiltradas.length?'':'none';
  btn.textContent=`Mostrar más (${fmtNum(novFiltradas.length-novMostradas)} restantes)`;
}

// Línea de tiempo de etapas de un proyecto (en la pestaña Proyectos)
function historialEtapasHTML(ficha, H){
  const h=(H?.proyectos?.[ficha]||[]).filter(x=>x[1]);
  if(h.length<2) return '';
  return `<details class="proy-hist proy-firmas"><summary>Historial de etapas (${h.length})</summary><ol>${
    h.map(([f,e],i)=>`<li><span class="badge ${etapaClass(e)}">${esc(e)}</span>${esc(fmtFecha(f))}${i===0&&f===H.desde?' o antes':''}</li>`).join('')
  }</ol></details>`;
}

// ── COMPARTIR FICHA ───────────────────────────────
// Comparte la página estática del diputado (diputado/<slug>/), que tiene vista previa propia.
async function compartirFicha(btn){
  const dep=_modalDep;
  if(!dep) return copyLink(btn);
  const url=`${location.origin}/diputado/${depSlug(dep)}/`;
  if(navigator.share && isMobile()){
    try{ await navigator.share({title:`${dep.nombre} — Observatorio Legislativo`, url}); return; }
    catch(e){ if(e.name==='AbortError') return; }
  }
  copyLink(btn, url);
}

