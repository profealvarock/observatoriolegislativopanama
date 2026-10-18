// Observatorio Legislativo — Gráficos de evolución (historico.json)
// ── HISTORIAL (historico.json: una foto diaria que guarda el scraper) ──
let _histPromise=null, _modalChart=null;
function ensureHist(){
  if(!_histPromise){
    _histPromise=fetch('historico.json')
      .then(r=>r.ok?r.json():null)
      .then(h=>h&&Array.isArray(h.snapshots)?h:null)
      .catch(()=>null);
  }
  return _histPromise;
}
function histSerie(H, slug, campo){
  const i=H.campos.indexOf(campo);
  return H.snapshots.map(s=>{ const v=s.diputados?.[slug]?.[i]; return v==null?null:Number(v); });
}
const fmtFecha=f=>{ const [y,m,d]=String(f).split('-'); return `${d}/${m}/${y.slice(2)}`; };
const histAxis={grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10}}};
const histTooltip={backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1};

async function renderMonitorHist(){
  const note=document.getElementById('monitor-hist-note'), wrap=document.getElementById('monitor-hist-wrap');
  const H=await ensureHist();
  // Solo las fechas con métricas de Espacio Cívico (las fotos antiguas solo tienen totales)
  const iPl=H?H.campos.indexOf('planilla'):-1, iCal=H?H.campos.indexOf('calificacion'):-1, iPle=H?H.campos.indexOf('pleno'):-1;
  const snaps=(H?.snapshots||[]).filter(s=>Object.values(s.diputados||{}).some(v=>v[iPl]!=null));
  if(snaps.length<2){
    note.textContent=snaps.length
      ? `El historial empezó el ${fmtFecha(snaps[0].fecha)}. Las tendencias aparecerán cuando haya al menos dos mediciones.`
      : 'Todavía no hay historial disponible.';
    return;
  }
  const media=(s,i)=>{ const v=Object.values(s.diputados).map(x=>x[i]).filter(x=>x!=null); return v.length?v.reduce((a,b)=>a+Number(b),0)/v.length:null; };
  note.textContent=`${snaps.length} mediciones entre ${fmtFecha(snaps[0].fecha)} y ${fmtFecha(snaps[snaps.length-1].fecha)}: planilla total de la Cámara y promedios de calificación y asistencia (escala 1–5), cada uno en su propio gráfico.`;
  wrap.style.display='';
  const labels=snaps.map(s=>fmtFecha(s.fecha));
  lineaSimple(document.getElementById('c-monitor-hist'),labels,[
    {label:'Planilla total',data:snaps.map(s=>Object.values(s.diputados).reduce((a,v)=>a+(Number(v[iPl])||0),0)),borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,.18)',fill:true},
  ],{fmt:v=>'B/. '+fmtNum(v),eje:v=>'B/. '+fmtNum(v/1000)+'K'});
  lineaSimple(document.getElementById('c-monitor-hist2'),labels,[
    {label:'Prom. calificación',data:snaps.map(s=>media(s,iCal)),borderColor:'#a78bfa',backgroundColor:'#a78bfa'},
    {label:'Prom. asistencia al pleno',data:snaps.map(s=>media(s,iPle)),borderColor:'#3b82f6',backgroundColor:'#3b82f6'},
  ],{fmt:v=>v==null?'—':v.toFixed(2)+' / 5',max:5});
}

// Gráfico de líneas con una sola escala vertical (las series de distinta escala van en
// gráficos separados, nunca con dos ejes).
function lineaSimple(canvas, labels, datasets, {fmt, eje, max, escalonado=false, maxTicks=8}={}){
  if(!canvas) return null;
  return new Chart(canvas,{type:'line',
    data:{labels,datasets:datasets.map(d=>({pointRadius:0,tension:escalonado?0:.2,stepped:escalonado,spanGaps:true,...d}))},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:datasets.length>1,labels:{color:'#94a3b8',font:{family:'DM Mono',size:10},boxWidth:10}},
        tooltip:{...histTooltip,callbacks:{label:c=>` ${c.dataset.label}: ${fmt(c.raw)}`}}},
      scales:{x:{...histAxis,ticks:{...histAxis.ticks,maxTicksLimit:maxTicks,maxRotation:0}},
        y:{...histAxis,beginAtZero:true,max,ticks:{...histAxis.ticks,callback:v=>(eje||fmt)(v)}}}}});
}

function destroyModalChart(){ [].concat(_modalChart||[]).forEach(c=>c&&c.destroy()); _modalChart=null; }
async function renderModalHist(dep){
  const body=document.getElementById('modal-body');
  body.innerHTML='<div class="gs-empty">Cargando historial…</div>';
  const H=await ensureHist();
  if(_modalDep!==dep || !document.getElementById('mtab-hist').classList.contains('active')) return;
  const slug=depSlug(dep);
  const idx=H?H.snapshots.map((s,i)=>s.diputados?.[slug]?i:-1).filter(i=>i>=0):[];
  if(idx.length<2){
    body.innerHTML='<div class="gs-empty">Aún no hay suficientes mediciones para mostrar la evolución de este diputado.</div>';
    return;
  }
  // Solo métricas de Espacio Cívico: el conteo histórico de proyectos por diputado no es
  // comparable entre fechas porque la asociación proponente ↔ diputado cambió en el scraper.
  const iPl=H.campos.indexOf('planilla');
  const idxM=idx.filter(i=>H.snapshots[i].diputados[slug][iPl]!=null);
  if(idxM.length<2){
    body.innerHTML='<div class="gs-empty">Aún no hay suficientes mediciones de Espacio Cívico para este diputado.</div>';
    return;
  }
  const pick=arr=>idxM.map(i=>arr[i]);
  const plan=pick(histSerie(H,slug,'planilla')), cal=pick(histSerie(H,slug,'calificacion')), ple=pick(histSerie(H,slug,'pleno'));
  const first=v=>v.find(x=>x!=null), last=v=>[...v].reverse().find(x=>x!=null);
  const delta=(v,fmt)=>{ const a=first(v), b=last(v); if(a==null||b==null) return '—'; const d=b-a; return d===0?'sin cambios':(d>0?'+':'−')+fmt(Math.abs(d)); };
  body.innerHTML=`<p class="hist-note" style="margin-top:12px">${idxM.length} mediciones · ${fmtFecha(H.snapshots[idxM[0]].fecha)} – ${fmtFecha(H.snapshots[idxM[idxM.length-1]].fecha)}<br>
    Planilla: <b style="color:var(--acc2)">${delta(plan,v=>'B/. '+fmtNum(v))}</b> · Calificación: <b style="color:var(--acc5)">${delta(cal,v=>v.toFixed(1))}</b> · Pleno: <b style="color:var(--acc)">${delta(ple,v=>v.toFixed(1))}</b></p>
    <p class="chart-sub">Planilla acumulada (B/.)</p>
    <div class="hist-wrap hist-wrap-sm"><canvas id="c-modal-hist"></canvas></div>
    <p class="chart-sub">Calificación y asistencia al pleno (escala 1–5)</p>
    <div class="hist-wrap hist-wrap-sm"><canvas id="c-modal-hist2"></canvas></div>`;
  const labels=pick(H.snapshots.map(s=>fmtFecha(s.fecha)));
  _modalChart=[
    lineaSimple(document.getElementById('c-modal-hist'),labels,
      [{label:'Planilla',data:plan,borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,.15)',fill:true}],
      {fmt:v=>'B/. '+fmtNum(v),eje:v=>fmtNum(v/1000)+'K',maxTicks:6}),
    lineaSimple(document.getElementById('c-modal-hist2'),labels,[
      {label:'Calificación',data:cal,borderColor:'#a78bfa',backgroundColor:'#a78bfa'},
      {label:'Asistencia al pleno',data:ple,borderColor:'#3b82f6',backgroundColor:'#3b82f6'},
    ],{fmt:v=>v==null?'—':v+' / 5',max:5,escalonado:true,maxTicks:6}),
  ];
}

