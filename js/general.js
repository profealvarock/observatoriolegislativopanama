// Observatorio Legislativo — Pestaña General (línea de tiempo, etapas, embudo, mapa), Partidos y Otros proponentes
// ── GENERAL ───────────────────────────────────────
function renderGeneral(){
  const tlKeys=Object.keys(D.timeline), tlVals=Object.values(D.timeline);
  const months=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const labels=tlKeys.map(k=>{const[y,m]=k.split('-');return`${months[+m-1]} ${y.slice(2)}`});
  const maxTl=Math.max(...tlVals,1);

  const isMobileTl = isMobile();
  const tlChart = new Chart(document.getElementById('c-timeline'),{
    type:'bar',
    data:{labels,datasets:[{data:tlVals,
      backgroundColor:tlVals.map((v,i)=>i===tlVals.length-1?'#f59e0b':`rgba(59,130,246,${.35+.6*v/maxTl})`),
      borderRadius:5,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},
        tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
          callbacks:{label:ctx=>` ${ctx.raw} proyectos — clic para filtrar`}}},
      scales:{x:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:isMobileTl?9:10},maxRotation:45,maxTicksLimit:isMobileTl?7:undefined}},
        y:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10}}}},
      onClick:(evt,els)=>{
        if(!els.length)return;
        const idx=els[0].index;
        const key=tlKeys[idx];   // "YYYY-MM"
        const lbl=labels[idx];
        setMonthFilter(key, lbl);
      }}
  });
  tlChart.$responsive = m=>{
    const t=tlChart.config.options.scales.x.ticks;
    t.font.size=m?9:10; t.maxTicksLimit=m?7:undefined;
  };

  // En el orden del trámite (no por tamaño), para que la escala de color se lea como avance
  const entries=Object.entries(D.etapas).sort((a,b)=>ordenEtapa(a[0])-ordenEtapa(b[0]));
  const isMobileDonut=isMobile();
  const donutChart = new Chart(document.getElementById('c-donut'),{
    type:'doughnut',
    data:{labels:entries.map(e=>e[0]),datasets:[{data:entries.map(e=>e[1]),$etapas:true,
      backgroundColor:entries.map(e=>etapaColor(e[0])),borderWidth:2,borderColor:'#0e1623',hoverOffset:8}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'68%',
      plugins:{legend:{position:isMobileDonut?'bottom':'right',labels:{color:'#94a3b8',font:{family:'DM Mono',size:isMobileDonut?9:10},padding:isMobileDonut?5:8,boxWidth:10}},
        tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
          callbacks:{label:ctx=>` ${ctx.label}: ${ctx.raw} (${((ctx.raw/D.total_proyectos)*100).toFixed(1)}%)`}}}}
  });
  donutChart.$responsive = m=>{
    const l=donutChart.config.options.plugins.legend;
    l.position=m?'bottom':'right'; l.labels.font.size=m?9:10; l.labels.padding=m?5:8;
  };

  renderFunnel();

  try{ renderMap(); }catch(e){ console.error('Map:',e); }

  const top=[...D.diputados].sort((a,b)=>(b.proyectos||0)-(a.proyectos||0)).slice(0,20);
  new Chart(document.getElementById('c-bar'),{
    type:'bar',
    data:{labels:top.map(d=>d.nombre.split(' ').slice(-2).join(' ')),
      datasets:[
        {label:'Propuestos',data:top.map(d=>d.proyectos||0),backgroundColor:'rgba(59,130,246,.85)',borderRadius:4,borderSkipped:false},
        {label:'Co-patrocinios',data:top.map(d=>d.co_patrocinios||0),backgroundColor:'rgba(167,139,250,.5)',borderRadius:4,borderSkipped:false},
      ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#94a3b8',font:{family:'DM Mono',size:11}}},
        tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
          callbacks:{title:ctx=>top[ctx[0].dataIndex].nombre,label:ctx=>` ${ctx.dataset.label}: ${ctx.raw}`}}},
      scales:{x:{grid:{display:false},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:9},maxRotation:40,
        callback:function(val){const l=this.getLabelForValue(val);return isMobile()&&l&&l.length>9?l.slice(0,8)+'…':l}}},
        y:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10}}}}}
  });
}

// ── PARTIDOS ──────────────────────────────────────
function renderPartidos(){
  const pp=D&&D.por_partido;if(!pp||!Object.keys(pp).length){document.getElementById('partido-cards').innerHTML='<p style="font-family:var(--fm);color:var(--muted);padding:20px">Sin datos de partidos.</p>';return;}
  const entries=Object.entries(pp).sort((a,b)=>(b[1].proyectos||0)-(a[1].proyectos||0));
  const labels=entries.map(e=>e[0]);
  const dataProp=entries.map(e=>Number(e[1].proyectos)||0);
  const dataLeyes=entries.map(e=>Number(e[1].leyes)||0);

  // Todos los partidos en el mismo color: cada barra ya lleva el nombre del partido
  const mkChart=(id,data,cb,color,etapas=false)=>{
    new Chart(document.getElementById(id),{
      type:'bar',
      data:{labels,datasets:[{data,backgroundColor:color,$etapas:etapas,borderRadius:5,borderSkipped:false,barThickness:18}]},
      options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,callbacks:{label:ctx=>cb(ctx.raw)}}},
        scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},precision:0}},
          y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}
    });
  };
  mkChart('c-pp-prop',dataProp,v=>` ${v} proyectos`,'#3b82f6');
  mkChart('c-pp-leyes',dataLeyes,v=>` ${v} leyes`,etapaColor('Ley'),true);
  try{ renderHeatRed(); }catch(e){ console.error('Red de partidos:',e); }

  const maxProp=Math.max(...dataProp,1), maxLeyes=Math.max(...dataLeyes,1);
  document.getElementById('partido-cards').innerHTML=entries.map(([l,v])=>{
    const ef=v.proyectos>0?((v.leyes/v.proyectos)*100).toFixed(1):0;
    return`<div class="partido-card" style="--pc:var(--acc)">
      <div class="partido-name">${esc(l)}</div>
      <div class="p-stats-grid">
        <div class="p-stat"><div class="p-stat-v">${v.diputados}</div><div class="p-stat-l">Diputados</div></div>
        <div class="p-stat"><div class="p-stat-v">${v.proyectos}</div><div class="p-stat-l">Proyectos</div></div>
        <div class="p-stat"><div class="p-stat-v">${v.leyes}</div><div class="p-stat-l">Leyes</div></div>
      </div>
      <div class="p-dual">
        <div class="p-dual-row">
          <div class="p-dual-lbl">Proyectos</div>
          <div class="p-dual-wrap"><div class="p-dual-bar" style="width:${Math.round(v.proyectos/maxProp*100)}%;background:var(--acc)"></div></div>
          <div class="p-dual-val">${v.proyectos}</div>
        </div>
        <div class="p-dual-row">
          <div class="p-dual-lbl">Leyes</div>
          <div class="p-dual-wrap"><div class="p-dual-bar" style="width:${Math.round(v.leyes/maxLeyes*100)}%;background:var(--st-ley)"></div></div>
          <div class="p-dual-val">${v.leyes}</div>
        </div>
        ${v.participaciones!=null?`<div class="p-dual-row">
          <div class="p-dual-lbl">Participa en</div>
          <div style="font-family:var(--fm);font-size:.72rem;color:var(--text);margin-left:auto">${fmtNum(v.participaciones)} proyectos</div>
        </div>`:''}
        <div class="p-dual-row" style="margin-top:2px">
          <div class="p-dual-lbl" style="color:var(--st-ley)">Efectividad</div>
          <div style="font-family:var(--fm);font-size:.72rem;color:var(--st-ley);margin-left:auto">${ef}% → ley</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── OTROS PROPONENTES ─────────────────────────────
function renderProponentes(){
  const otros=(D&&D.otros_proponentes)||[];
  const ejecutivo=otros.filter(o=>o.tipo==='ejecutivo');
  const ciudadano=otros.filter(o=>o.tipo==='ciudadano');
  const totEjProy=ejecutivo.reduce((s,o)=>s+o.proyectos,0);
  const totEjLeyes=ejecutivo.reduce((s,o)=>s+o.leyes,0);
  const totCiProy=ciudadano.reduce((s,o)=>s+o.proyectos,0);
  const totCiLeyes=ciudadano.reduce((s,o)=>s+o.leyes,0);

  const sumCards=[
    {l:'Proyectos del Ejecutivo',v:totEjProy,s:`${ejecutivo.length} ministerios e instituciones`,c:'var(--st-ejec)'},
    {l:'Leyes del Ejecutivo',v:totEjLeyes,s:`${totEjProy>0?((totEjLeyes/totEjProy)*100).toFixed(0):0}% tasa de aprobación`,c:'var(--st-ley)'},
    {l:'Iniciativa ciudadana',v:totCiProy,s:`${ciudadano.length} proponentes individuales`,c:'var(--acc)'},
    {l:'Leyes ciudadanas',v:totCiLeyes,s:`${totCiProy>0?((totCiLeyes/totCiProy)*100).toFixed(0):0}% tasa de aprobación`,c:'var(--st-ley)'},
  ];
  document.getElementById('prop-summary').innerHTML=sumCards.map((c,i)=>`
    <div class="kpi fade-in" style="--kc:${c.c};animation-delay:${i*.08}s">
      <div class="kpi-label">${c.l}</div>
      <div class="kpi-value" id="pv${i}">0</div>
      <div class="kpi-sub">${c.s}</div>
    </div>`).join('');
  sumCards.forEach((c,i)=>countUp(document.getElementById(`pv${i}`),c.v,i*80));

  function renderList(id,items,color){
    const max=Math.max(...items.map(o=>o.proyectos),1);
    document.getElementById(id).innerHTML=items.length
      ?items.map((o,i)=>`
        <div class="prop-item">
          <div class="prop-rank">${i+1}</div>
          <div class="prop-info">
            <div class="prop-name" title="${esc(o.nombre)}">${esc(o.nombre)}</div>
            <div class="prop-bar-track"><div class="prop-bar-fill" style="width:${Math.round(o.proyectos/max*100)}%;background:${color}"></div></div>
          </div>
          <div class="prop-nums">
            <span class="prop-proy">${o.proyectos}</span>
            ${o.leyes>0?`<span class="badge etapa-ley prop-ley">${o.leyes} ley${o.leyes>1?'es':''}</span>`:''}
          </div>
        </div>`).join('')
      :'<div class="loader" style="height:80px;font-size:.75rem">Sin datos</div>';
  }
  renderList('prop-ejecutivo',ejecutivo,'var(--st-ejec)');
  renderList('prop-ciudadano',ciudadano,'var(--acc)');
  renderList('prop-comision',otros.filter(o=>o.tipo==='comision'),'var(--acc5)');
}

// ── MONTH FILTER (timeline click) ─────────────────
let selectedMonth = null;
function setMonthFilter(monthKey, label){
  selectedMonth = monthKey;
  const note = document.getElementById('map-tl-note');
  const txt  = document.getElementById('map-tl-text');
  if(note && txt){ txt.textContent = `Filtrando por: ${label}`; note.classList.add('show'); }
  const depNote = document.getElementById('dep-tl-note');
  const depTxt  = document.getElementById('dep-tl-text');
  if(depNote && depTxt){ depTxt.textContent = `Mostrando proyectos de: ${label}`; depNote.classList.add('show'); }
  buildFiltered(); page=1;
  showTab('diputados');
  viewMode==='grid' ? renderGrid() : renderTable();
}
function clearMonthFilter(){
  selectedMonth = null;
  const note = document.getElementById('map-tl-note');
  if(note) note.classList.remove('show');
  const depNote = document.getElementById('dep-tl-note');
  if(depNote) depNote.classList.remove('show');
  buildFiltered(); page=1;
  viewMode==='grid' ? renderGrid() : renderTable();
}

// ── PROVINCE MAP ───────────────────────────────────
const PROV_MAP = {
  'Bocas del Toro':'Bocas_del_Toro','Chiriquí':'Chiriqui','Chiriqui':'Chiriqui',
  'Comarca Ngäbe-Buglé':'Ngabe_Bugle','Ngäbe-Buglé':'Ngabe_Bugle','Ngöbe Buglé':'Ngabe_Bugle',
  'Veraguas':'Veraguas','Coclé':'Cocle','Cocle':'Cocle',
  'Herrera':'Herrera','Los Santos':'Los_Santos',
  'Colón':'Colon','Colon':'Colon','Panamá Oeste':'Panama_Oeste',
  'Panamá':'Panama','Panama':'Panama',
  'Comarca Guna Yala':'Guna_Yala','Guna Yala':'Guna_Yala',
  'Darién':'Darien','Darien':'Darien',
};
const MAP_ALL_IDS=['Bocas_del_Toro','Chiriqui','Ngabe_Bugle','Veraguas','Cocle','Herrera','Los_Santos','Colon','Panama_Oeste','Panama','Guna_Yala','Darien'];

function renderMap(){
  if(!document.getElementById('panama-map')) return;
  const tooltip = document.getElementById('map-tooltip');
  const mapWrap = document.getElementById('map-wrap');
  if(!mapWrap) return;

  const pp = D ? getMapData() : {};
  const vals = Object.values(pp).map(v=>v.proyectos||0);
  const maxV = Math.max(...vals, 1);
  const hasData = vals.some(v=>v>0);
  document.getElementById('map-legend-max').textContent = hasData ? maxV+' proy.' : '—';

  // Reset all circles to minimum state before applying filtered data
  MAP_ALL_IDS.forEach(id=>{
    const el=document.getElementById('pmap-'+id);
    if(el){el.style.fill='rgba(59,130,246,0.10)';el.setAttribute('r','13');}
    const vEl=document.getElementById('pmap-value-'+id);
    if(vEl) vEl.textContent='';
  });

  // Helper: mostrar tooltip en coordenadas absolutas
  const showTip=(el,cx,cy,offsetY=0)=>{
    const rect=mapWrap.getBoundingClientRect();
    tooltip.innerHTML=el.dataset.tipHtml||'';
    tooltip.style.left=(cx-rect.left+12)+'px';
    tooltip.style.top=(cy-rect.top-10+offsetY)+'px';
    tooltip.classList.add('show');
  };

  Object.entries(pp).forEach(([prov, data])=>{
    const id = PROV_MAP[prov];
    if(!id) return;
    const el = document.getElementById('pmap-'+id);
    if(!el) return;

    const intensity = (data.proyectos||0)/maxV;
    el.style.fill = `rgba(59,130,246,${(0.12+intensity*0.78).toFixed(2)})`;
    el.setAttribute('r', (13+intensity*18).toFixed(1));

    const vEl=document.getElementById('pmap-value-'+id);
    if(vEl) vEl.textContent=data.proyectos||0;

    // Guardar contenido en data-attribute para que handlers táctiles lo lean siempre actualizado
    const filtroLabel = mapEtapaFilter!=='all'?`<br><span style="color:var(--acc2);font-size:.65rem">${MAP_ETAPA_LABELS[mapEtapaFilter]||''}</span>`:'';
    const yearLabel   = mapYearFilter!=='all'?` · ${mapYearFilter}`:'';
    el.dataset.tipHtml = `<b style="color:var(--text)">${esc(prov)}</b>${esc(yearLabel)}<br>
      <span style="color:var(--acc)">${data.proyectos||0} proyectos</span> &nbsp;
      <span style="color:var(--acc3)">${data.leyes||0} leyes</span><br>
      <span style="color:var(--muted)">${data.diputados||0} diputados</span>${data.participaciones!=null&&mapEtapaFilter==='all'&&mapYearFilter==='all'?`<br><span style="color:var(--muted);font-size:.65rem">Autor principal · participa en ${data.participaciones}</span>`:''}${filtroLabel}`;
    el.dataset.mapProv = prov; // para navegación en touch

    // ── Mouse (inline → overwrite-safe en cada render) ──
    el.onmouseenter = ev=>showTip(el,ev.clientX,ev.clientY);
    el.onmousemove  = ev=>showTip(el,ev.clientX,ev.clientY);
    el.onmouseleave = ()=>tooltip.classList.remove('show');
    el.onclick = ()=>{
      showTab('diputados');
      if(!selectedProvinces.has(prov)) selectedProvinces.add(prov);
      buildChips(); buildFiltered(); page=1;
      viewMode==='grid' ? renderGrid() : renderTable();
    };

    // ── Touch (addEventListener, agregar solo una vez) ──
    if(!el.dataset.mapInited){
      el.dataset.mapInited='1';
      let touchTimer=null;
      el.addEventListener('touchstart',ev=>{
        if(ev.touches.length!==1) return;
        const t=ev.touches[0];
        showTip(el,t.clientX,t.clientY,-70); // mostrar encima del dedo
      },{passive:true});
      el.addEventListener('touchend',()=>{
        clearTimeout(touchTimer);
        touchTimer=setTimeout(()=>tooltip.classList.remove('show'),1800);
        const p=el.dataset.mapProv;
        if(p){
          showTab('diputados');
          if(!selectedProvinces.has(p)) selectedProvinces.add(p);
          buildChips(); buildFiltered(); page=1;
          viewMode==='grid' ? renderGrid() : renderTable();
        }
      },{passive:true});
      el.addEventListener('touchmove',()=>{
        clearTimeout(touchTimer);
        tooltip.classList.remove('show');
      },{passive:true});
    }
  });
}

