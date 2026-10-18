// Observatorio Legislativo — Monitoreo, filtros y tabla de Diputados, e índice de efectividad legislativa
// ── CHIPS & VIEW ──────────────────────────────────
// MONITOREO
function fmtMoney(v){
  return v!=null && v!=='' && Number.isFinite(Number(v)) ? 'B/. ' + fmtNum(v) : '—';
}
function fmtScore(v){
  return Number.isFinite(Number(v)) ? Number(v).toFixed(1).replace('.0','') : '—';
}
function scoreClass(v){
  v = Number(v);
  if(!Number.isFinite(v)) return 'score-low';
  if(v >= 4.5) return 'score-good';
  if(v >= 3) return 'score-mid';
  return 'score-low';
}
function monitorData(){
  return (D&&D.diputados||[]).filter(d=>d.planilla_valor!=null||d.asistencia_pleno!=null||d.asistencia_comisiones!=null||d.calificacion!=null);
}
function avg(items, key){
  const vals=items.map(d=>Number(d[key])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
}
function initMonitor(){
  document.querySelectorAll('thead th[data-mcol]').forEach(th=>{
    th.addEventListener('click',()=>{
      const col=th.dataset.mcol;
      if(monitorSortCol===col)monitorSortDir=monitorSortDir==='desc'?'asc':'desc';
      else{monitorSortCol=col;monitorSortDir=col==='nombre'?'asc':'desc'}
      document.querySelectorAll('thead th[data-mcol]').forEach(h=>{h.classList.remove('sorted');const s=h.querySelector('.si');if(s)s.textContent='↕'});
      th.classList.add('sorted');
      const si=th.querySelector('.si'); if(si)si.textContent=monitorSortDir==='desc'?'↓':'↑';
      renderMonitorTable();
    });
  });
  renderMonitorSummary();
  try{ renderMonitorChart(); }catch(e){ console.error('Monitor chart:',e); }
  renderMonitorTable();
  renderMonitorHist();
}
function renderMonitorSummary(){
  const items=monitorData();
  const totalPlanilla=items.reduce((s,d)=>s+(Number(d.planilla_valor)||0),0);
  const cards=[
    {l:'Planilla acumulada',v:Math.round(totalPlanilla),s:`${items.length} diputados monitoreados`,c:'var(--costo)',money:true},
    {l:'Prom. pleno',v:avg(items,'asistencia_pleno'),s:'Escala 1-5',c:'var(--acc)'},
    {l:'Prom. comisiones',v:avg(items,'asistencia_comisiones'),s:'Escala 1-5',c:'var(--acc)'},
    {l:'Prom. calificación',v:avg(items,'calificacion'),s:'Desempeño ponderado',c:'var(--acc5)'},
  ];
  document.getElementById('monitor-summary').innerHTML=cards.map((c,i)=>`
    <div class="kpi fade-in" style="--kc:${c.c};animation-delay:${i*.08}s">
      <div class="kpi-label">${c.l}</div>
      <div class="kpi-value">${c.money?fmtMoney(c.v):fmtScore(c.v)}</div>
      <div class="kpi-sub">${c.s}</div>
    </div>`).join('');

  const lowPleno=items.filter(d=>(Number(d.asistencia_pleno)||0)<3).length;
  const highSpend=[...items].sort((a,b)=>(b.planilla_valor||0)-(a.planilla_valor||0))[0];
  const topScore=[...items].sort((a,b)=>(b.calificacion||0)-(a.calificacion||0))[0];
  const maxPlanilla=Math.max(...items.map(d=>Number(d.planilla_valor)||0),1);
  document.getElementById('monitor-insights').innerHTML=[
    {l:'Pleno',v:avg(items,'asistencia_pleno'),max:5,c:'var(--acc)',t:`Promedio ${fmtScore(avg(items,'asistencia_pleno'))}/5`},
    {l:'Comis.',v:avg(items,'asistencia_comisiones'),max:5,c:'var(--acc)',t:`Promedio ${fmtScore(avg(items,'asistencia_comisiones'))}/5`},
    {l:'Planilla',v:highSpend?.planilla_valor||0,max:maxPlanilla,c:'var(--costo)',t:`Mayor: ${highSpend?.nombre||'—'}`,money:true},
    {l:'Alertas',v:lowPleno,max:items.length||1,c:'var(--st-neg)',t:`${lowPleno} con pleno bajo 3/5`},
  ].map(x=>`<div class="mini-row">
      <span>${x.l}</span><div class="mini-track"><div class="mini-fill" style="width:${Math.max(4,Math.round((x.v/x.max)*100))}%;background:${x.c}"></div></div><span>${x.money?fmtMoney(x.v):(Number.isFinite(x.v)?Math.round(x.v):0)}</span>
      <div style="grid-column:1/-1;color:var(--muted);font-size:.65rem">${esc(x.t)}${topScore&&x.l==='Comis.'?` · Mejor calificación: ${esc(topScore.nombre)}`:''}</div>
    </div>`).join('');
}
function renderMonitorChart(){
  const top=[...monitorData()].sort((a,b)=>(b.planilla_valor||0)-(a.planilla_valor||0)).slice(0,18);
  const ctx=document.getElementById('c-monitor-planilla'), ctx2=document.getElementById('c-monitor-calif');
  if(!ctx) return;
  // Dos gráficos con el mismo eje X (mismos diputados, mismo orden) en vez de uno con dos
  // escalas verticales: comparar alturas de escalas distintas induce a conclusiones falsas.
  const labels=top.map(d=>d.nombre.split(' ').slice(-2).join(' '));
  const base=(fmt,max)=>({responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
      callbacks:{title:c=>top[c[0].dataIndex].nombre,label:c=>' '+fmt(c.raw)}}},
    scales:{x:{ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:9},maxRotation:50},grid:{display:false}},
      y:{beginAtZero:true,max,ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},callback:v=>fmt(v)},grid:{color:'rgba(255,255,255,.03)'}}}});
  new Chart(ctx,{type:'bar',
    data:{labels,datasets:[{label:'Planilla acumulada',data:top.map(d=>d.planilla_valor||0),backgroundColor:'rgba(245,158,11,.8)',borderRadius:4}]},
    options:base(v=>'B/. '+fmtNum(v))});
  if(ctx2) new Chart(ctx2,{type:'bar',
    data:{labels,datasets:[{label:'Calificación (1–5)',data:top.map(d=>d.calificacion??null),backgroundColor:'rgba(167,139,250,.85)',borderRadius:4}]},
    options:base(v=>v==null?'—':Number(v).toFixed(1)+' / 5',5)});
}
function renderMonitorTable(){
  const q=(document.getElementById('monitor-search')||{value:''}).value.toLowerCase();
  const sorted=monitorData().filter(d=>!q||d.nombre.toLowerCase().includes(q)||(d.partido||'').toLowerCase().includes(q)||(d.provincia||'').toLowerCase().includes(q)).sort((a,b)=>{
    const av=a[monitorSortCol], bv=b[monitorSortCol];
    if(typeof av==='string')return monitorSortDir==='asc'?av.localeCompare(bv||'',undefined,{sensitivity:'base'}):(bv||'').localeCompare(av||'',undefined,{sensitivity:'base'});
    return monitorSortDir==='asc'?(Number(av)||0)-(Number(bv)||0):(Number(bv)||0)-(Number(av)||0);
  });
  monitorSorted=sorted;
  document.getElementById('monitor-tbody').innerHTML=sorted.map((d,i)=>{
    const pc='var(--muted)';  // partido en tinta neutra (sin color por partido)
    const fotoEl=d.foto?`<img class="dep-avatar" loading="lazy" decoding="async" src="${safeUrl(d.foto)}" alt="${esc(d.nombre)}" onerror="this.style.display='none'">`:`<div class="dep-avatar"></div>`;
    return`<tr>
      <td class="td-main"><div class="dep-cell">${fotoEl}<div><div class="dep-name">${esc(d.nombre)}</div><div class="dep-sub" style="color:${pc}">${esc(d.partido||'—')} · ${esc(d.circuito||'')}</div></div></div></td>
      <td class="money-cell" data-label="Planilla">${fmtMoney(d.planilla_valor)}</td>
      <td class="num" data-label="Pleno"><span class="score-pill ${scoreClass(d.asistencia_pleno)}">${fmtScore(d.asistencia_pleno)}</span></td>
      <td class="num" data-label="Comisiones"><span class="score-pill ${scoreClass(d.asistencia_comisiones)}">${fmtScore(d.asistencia_comisiones)}</span></td>
      <td class="num" data-label="Participa en"><button class="comm-btn" onclick="showComisiones(${i})">${d.comisiones_cantidad||0}</button></td>
      <td class="num" data-label="Calificación"><span class="score-pill ${scoreClass(d.calificacion)}">${fmtScore(d.calificacion)}</span></td>
      <td class="col-md" data-label="Provincia" style="font-family:var(--fm);font-size:.75rem;color:var(--muted)">${esc(d.provincia||'—')}</td>
    </tr>`;
  }).join('');
}

function buildChips(){
  if(!D)return;
  const parties=[...new Set((D.diputados||[]).map(d=>d.partido).filter(Boolean))].sort();
  const provinces=[...new Set((D.diputados||[]).map(d=>d.provincia).filter(Boolean))].sort();
  const hasFilter=selectedParties.size>0||selectedProvinces.size>0;
  const cpEl=document.getElementById('chip-partidos');
  const cvEl=document.getElementById('chip-provincias');
  if(!cpEl||!cvEl)return;
  cpEl.innerHTML=`<span class="chip-lbl">Partido</span>`+
    parties.map(p=>`<button class="chip${selectedParties.has(p)?' active':''}" style="--cc:var(--acc)" data-val="${esc(p)}" onclick="toggleChip('party',this.dataset.val)"><span class="chip-dot"></span>${esc(p.replace(/^(Partido|Movimiento)\s/,''))}</button>`).join('')+
    `<button class="filter-clear${hasFilter?' visible':''}" onclick="clearFilters()">✕ Limpiar</button>`;
  cvEl.innerHTML=`<span class="chip-lbl">Provincia</span>`+
    provinces.map(p=>`<button class="chip${selectedProvinces.has(p)?' active':''}" style="--cc:var(--acc2)" data-val="${esc(p)}" onclick="toggleChip('prov',this.dataset.val)"><span class="chip-dot"></span>${esc(p)}</button>`).join('');
}
function toggleChip(type,val){
  if(type==='party'){if(selectedParties.has(val))selectedParties.delete(val);else selectedParties.add(val);}
  else{if(selectedProvinces.has(val))selectedProvinces.delete(val);else selectedProvinces.add(val);}
  buildChips();buildFiltered();page=1;viewMode==='grid'?renderGrid():renderTable();
}
function clearFilters(){
  selectedParties.clear();selectedProvinces.clear();
  const s=document.getElementById('search');if(s)s.value='';
  buildChips();buildFiltered();page=1;viewMode==='grid'?renderGrid():renderTable();
}
function setView(mode){
  viewMode=mode;
  document.getElementById('vt-table').classList.toggle('active',mode==='table');
  document.getElementById('vt-grid').classList.toggle('active',mode==='grid');
  const tw=document.getElementById('tbl-wrap');
  const dg=document.getElementById('dep-grid');
  if(tw)tw.style.display=mode==='table'?'':'none';
  if(dg)dg.style.display=mode==='grid'?'':'none';
  buildFiltered();
  if(mode==='grid')renderGrid();else{page=1;renderTable();}
}
function renderGrid(){
  const sorted=[...filtered].sort((a,b)=>{
    const av=a[sortCol],bv=b[sortCol];
    if(typeof av==='string')return sortDir==='asc'?av.localeCompare(bv,undefined,{sensitivity:'base'}):bv.localeCompare(av,undefined,{sensitivity:'base'});
    return sortDir==='asc'?av-bv:bv-av;
  });
  sortedDeps=sorted;
  const maxProp=Math.max(...sorted.map(d=>d.proyectos||0),1);
  const maxCosp=Math.max(...sorted.map(d=>d.co_patrocinios||0),1);
  document.getElementById('dep-grid').innerHTML=sorted.map((d,i)=>{
    const pc='var(--muted)';  // partido en tinta neutra (sin color por partido)
    const bwProp=Math.round((d.proyectos||0)/maxProp*100);
    const bwCosp=Math.round((d.co_patrocinios||0)/maxCosp*100);
    const leyes=(d.leyes_detalle||[]).length;
    const fotoEl=d.foto
      ?`<a href="${safeUrl(d.perfil)}" target="_blank" rel="noopener"><img class="dep-card-photo" loading="lazy" decoding="async" src="${safeUrl(d.foto)}" alt="${esc(d.nombre)}" onerror="this.outerHTML='<div class=dep-card-photo-placeholder>👤</div>'"></a>`
      :`<div class="dep-card-photo-placeholder">👤</div>`;
    return`<div class="dep-card fade-in" style="animation-delay:${Math.min(i,20)*.03}s">
      <div class="dep-card-top">${fotoEl}<div class="dep-card-rank">#${i+1}</div></div>
      <div class="dep-card-body">
        <div class="dep-card-name">${esc(d.nombre)}</div>
        <div class="dep-card-party" style="color:${pc}">${esc(d.partido||'—')}</div>
        <div class="dep-card-prov">${esc(d.provincia||'—')}</div>
        <div class="dep-card-bars">
          <div class="dbar-row"><div class="dbar-lbl c-blue" data-tip="Propuestos">P</div><div class="dbar-wrap"><div class="dbar-fill" style="width:${bwProp}%;background:var(--acc)"></div></div><div class="dbar-val c-blue">${d.proyectos||0}</div></div>
          <div class="dbar-row"><div class="dbar-lbl c-purple" data-tip="Co-patrocinios">C</div><div class="dbar-wrap"><div class="dbar-fill" style="width:${bwCosp}%;background:var(--acc5)"></div></div><div class="dbar-val c-purple">${d.co_patrocinios||0}</div></div>
        </div>
        ${d.efectividad_ley?.autor?.proyectos?`<div class="dep-card-ief"><span>Efectividad</span>${celdaIndice(d.efectividad_ley)}</div>`:''}
        ${leyes>0?`<div class="dep-card-leyes" onclick="showLeyes(${i})"><span class="badge etapa-ley">${leyes} ley${leyes>1?'es':''}</span></div>`:''}
      </div>
    </div>`;
  }).join('');
}

// ── TABLE ──────────────────────────────────────────
function setMetric(m){
  metrica=m;
  document.getElementById('mt-prop').classList.toggle('active',m==='proyectos');
  document.getElementById('mt-cosp').classList.toggle('active',m==='co_patrocinios');
  const th=document.getElementById('th-main');
  if(th){th.dataset.col=m;th.innerHTML=(m==='proyectos'?'Propuestos':'Co-patrocinios')+' <span class="si">↓</span>'}
  sortCol=m;sortDir='desc';
  document.querySelectorAll('thead th').forEach(h=>h.classList.remove('sorted'));
  if(th)th.classList.add('sorted');
  page=1;renderTable();
}

function buildFiltered(){
  const q=(document.getElementById('search')||{value:''}).value.toLowerCase();
  filtered=(D&&D.diputados||[]).map(d=>{
    const ef=d.proyectos>0?+((d.leyes/d.proyectos)*100).toFixed(1):0;
    const topEtapa=Object.entries(d.etapas||{}).sort((a,b)=>b[1]-a[1])[0]?.[0]||'-';
    const e=d.efectividad_ley||{};
    return{...d,efectividad:ef,topEtapa,
      tasaAutor:e.autor?.tasa??-1, tasaCopat:e.copat?.tasa??-1,
      // Al ordenar, los índices con "pocos datos" van después de los que tienen evidencia suficiente
      indiceAutor:e.autor?.indice==null ? -99999 : e.autor.indice-(e.autor.evidencia==='baja'?10000:0)};
  }).filter(d=>{
    if(q&&!d.nombre.toLowerCase().includes(q)&&!(d.partido||'').toLowerCase().includes(q)&&!(d.provincia||'').toLowerCase().includes(q))return false;
    if(selectedParties.size>0&&!selectedParties.has(d.partido))return false;
    if(selectedProvinces.size>0&&!selectedProvinces.has(d.provincia))return false;
    if(selectedMonth){
      const [yr,mo]=selectedMonth.split('-');
      const suffix=`-${mo}-${yr}`;
      const items=(d.proyectos_detalle||d.leyes_detalle||[]);
      if(!items.some(p=>p.fecha&&p.fecha.endsWith(suffix)))return false;
    }
    return true;
  });
}

function initTable(){
  buildChips();
  buildFiltered();
  if(tableInited){ renderTable(); return; }
  tableInited = true;
  document.getElementById('search').addEventListener('input',()=>{buildFiltered();page=1;viewMode==='grid'?renderGrid():renderTable()});
  document.querySelectorAll('thead th[data-col]').forEach(th=>{
    th.addEventListener('click',()=>{
      const col=th.dataset.col;
      if(sortCol===col)sortDir=sortDir==='desc'?'asc':'desc';
      else{sortCol=col;sortDir=['nombre','partido','provincia'].includes(col)?'asc':'desc'}
      document.querySelectorAll('thead th').forEach(h=>h.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.si').textContent=sortDir==='desc'?'↓':'↑';
      renderTable();
    });
  });
  renderTable();
}

// ── EFECTIVIDAD LEGISLATIVA (calculada en scraper.py: calcular_efectividad) ──
// Índice = (leyes + k) / (esperadas + k) × 100. Las esperadas salen de la tasa de la Cámara en el
// semestre de cada proyecto, así no se castiga a quien propuso recientemente.
const IEF_ALTO=120, IEF_BAJO=80;
function nivelIndice(r){
  if(!r||r.indice==null) return {cls:'ief-nd',txt:'sin proyectos',icono:''};
  if(r.evidencia==='baja') return {cls:'ief-poca',txt:'pocos datos',icono:'·'};
  if(r.indice>=IEF_ALTO) return {cls:'ief-alto',txt:'sobre el promedio',icono:'▲'};
  if(r.indice<=IEF_BAJO) return {cls:'ief-bajo',txt:'bajo el promedio',icono:'▼'};
  return {cls:'ief-medio',txt:'en el promedio',icono:'●'};
}
function celdaTasa(r){
  if(!r||!r.proyectos) return '<span class="ief-tasa-nd">—</span>';
  return `<div class="ief-tasa">${r.tasa.toLocaleString('es-PA')}%</div><div class="ief-sub">${r.leyes} de ${r.proyectos}</div>`;
}
function tituloIndice(e){
  const f=(r,rol)=>r&&r.proyectos?`${rol}: ${r.leyes} leyes de ${r.proyectos} proyectos; se esperaban ${r.esperadas.toLocaleString('es-PA')} por su antigüedad → índice ${r.indice}`:`${rol}: sin proyectos`;
  return esc(f(e?.autor,'Como autor')+'\n'+f(e?.copat,'Como co-patrocinador')+'\n100 = promedio de la Cámara');
}
function celdaIndice(e){ return celdaIndiceRol(e,'autor'); }
function celdaIndiceRol(e,rol){
  const r=e?.[rol], n=nivelIndice(r);
  if(!r||r.indice==null) return '<span class="ief-tasa-nd">—</span>';
  return `<div class="ief ${n.cls}" title="${tituloIndice(e)}"><span class="ief-val">${n.icono} ${r.indice}</span><span class="ief-lbl">${n.txt}</span></div>`;
}

function renderTable(){
  const sorted=[...filtered].sort((a,b)=>{
    const av=a[sortCol],bv=b[sortCol];
    if(typeof av==='string')return sortDir==='asc'?av.localeCompare(bv,undefined,{sensitivity:'base'}):bv.localeCompare(av,undefined,{sensitivity:'base'});
    return sortDir==='asc'?av-bv:bv-av;
  });
  sortedDeps = sorted;
  const maxProp=Math.max(...sorted.map(d=>d.proyectos||0),1);
  const maxCosp=Math.max(...sorted.map(d=>d.co_patrocinios||0),1);
  const total=sorted.length, pages=Math.ceil(total/PAGE);
  const slice=sorted.slice((page-1)*PAGE,page*PAGE);

  document.getElementById('tbody').innerHTML=slice.map((d,i)=>{
    const rank=(page-1)*PAGE+i+1;
    const pc='var(--muted)';  // partido en tinta neutra (sin color por partido)
    const topEt=d.topEtapa||'-';
    const bwProp=Math.round((d.proyectos||0)/maxProp*100);
    const bwCosp=Math.round((d.co_patrocinios||0)/maxCosp*100);
    const fotoEl=d.foto
      ?`<a href="${safeUrl(d.perfil)}" target="_blank" rel="noopener" style="text-decoration:none"><img class="dep-avatar" loading="lazy" decoding="async" src="${safeUrl(d.foto)}" alt="${esc(d.nombre)}" onerror="this.outerHTML='<div class=dep-avatar style=display:flex;align-items:center;justify-content:center;font-size:14px>👤</div>'"></a>`
      :`<div class="dep-avatar" style="display:flex;align-items:center;justify-content:center;font-size:14px">👤</div>`;
    return`<tr>
      <td class="rank">${rank}</td>
      <td><div class="dep-cell">${fotoEl}<div>
        <div class="dep-name">${esc(d.nombre)}</div>
        ${d.partido?`<div class="dep-sub" style="color:${pc}">${esc(d.partido)}</div>`:''}
      </div></div></td>
      <td class="col-md"><span class="badge" style="background:var(--surface2);color:var(--text);border:1px solid var(--border)">${esc(d.partido||'—')}</span></td>
      <td class="col-sm" style="font-family:var(--fm);font-size:.75rem;color:var(--muted)">${esc(d.provincia||'—')}</td>
      <td class="num">
        <div class="dual-bar">
          <div class="dbar-row">
            <div class="dbar-lbl c-blue" data-tip="Proyectos donde es autor principal">P</div>
            <div class="dbar-wrap"><div class="dbar-fill" style="width:${bwProp}%;background:var(--acc)"></div></div>
            <div class="dbar-val c-blue">${d.proyectos||0}</div>
          </div>
          <div class="dbar-row">
            <div class="dbar-lbl c-purple" data-tip="Proyectos donde co-firma">C</div>
            <div class="dbar-wrap"><div class="dbar-fill" style="width:${bwCosp}%;background:var(--acc5)"></div></div>
            <div class="dbar-val c-purple">${d.co_patrocinios||0}</div>
          </div>
        </div>
      </td>
      <td class="num c-green col-md">${(d.proyectos||0)>0?`<span class="leyes-btn" onclick="showLeyes(${(page-1)*PAGE+i})">${d.leyes||0}</span>`:(d.leyes||0)}</td>
      <td class="num col-md">${celdaTasa(d.efectividad_ley?.autor)}</td>
      <td class="num col-md">${celdaTasa(d.efectividad_ley?.copat)}</td>
      <td class="num">${celdaIndice(d.efectividad_ley)}</td>
      <td class="col-sm"><span class="badge ${etapaClass(topEt)}">${esc(topEt)}</span></td>
    </tr>`;
  }).join('');

  const btns=[];
  for(let p=1;p<=pages;p++){
    if(p===1||p===pages||Math.abs(p-page)<=1)btns.push(`<button class="pb${p===page?' active':''}" onclick="goPage(${p})">${p}</button>`);
    else if(Math.abs(p-page)===2)btns.push(`<span style="color:var(--muted);padding:0 2px">…</span>`);
  }
  document.getElementById('pag').innerHTML=`
    <span>Mostrando ${(page-1)*PAGE+1}–${Math.min(page*PAGE,total)} de ${total}</span>
    <div class="pag-btns">
      <button class="pb" onclick="goPage(${page-1})" ${page===1?'disabled':''}>←</button>
      ${btns.join('')}
      <button class="pb" onclick="goPage(${page+1})" ${page===pages?'disabled':''}>→</button>
    </div>`;
}

function goPage(p){
  const pages=Math.ceil(filtered.length/PAGE);
  if(p<1||p>pages)return;
  page=p;renderTable();
  const tw=document.getElementById('tbl-wrap');if(tw)tw.scrollIntoView({behavior:'smooth',block:'start'});
}

