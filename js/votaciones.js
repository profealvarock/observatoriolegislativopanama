// Observatorio Legislativo — Pestaña Votaciones del pleno (votaciones.json, votos_diputado.json, votos_matriz.json y
// votaciones/{id}.json, generados por scraper_votaciones.py) y su sección en Diputados, Proyectos y Partidos
// ── DATOS ─────────────────────────────────────────
let VOT=null, VMET=null, VMAT=null, _votP=null, _vmetP=null, _vmatP=null, _votInit=null, votPendiente=null;
const _votDet={};
const ensureVotaciones=()=>_votP||(_votP=cargarJSON('votaciones.json').then(v=>VOT=v));
const ensureVotosDip=()=>_vmetP||(_vmetP=cargarJSON('votos_diputado.json').then(v=>VMET=v));
const ensureMatriz=()=>_vmatP||(_vmatP=cargarJSON('votos_matriz.json').then(v=>VMAT=v));
const ensureDetalleVot=id=>_votDet[id]||(_votDet[id]=cargarJSON(`votaciones/${id}.json`));

// Colores del voto [oscuro, claro], validados para daltonismo en cada modo. Nunca van solos: siempre con ✓ ✕ ○ y texto.
const VOTO_COLOR={favor:['#12a37a','#047857'], contra:['#ee4b4b','#db2727'], abstencion:['#9677f0','#7c3aed']};
ETAPA_PARES.push(...Object.values(VOTO_COLOR));   // los gráficos los traducen al cambiar de tema (themeChartConfig)
const VOTO_LBL={favor:'A favor', contra:'En contra', abstencion:'Abstención'};
const VOTO_ICO={favor:'✓', contra:'✕', abstencion:'○'};
const LETRA_VOTO={F:'favor', C:'contra', A:'abstencion'};
const RESPUESTA_VOTO=id=>id===2?'contra':id===3?'abstencion':id?'favor':null;   // 1 = a favor; >3 = "Modificado por…" (a favor)
const SEG_LBL={proyecto:'Proyectos de ley', nombramiento:'Nombramientos', informe_minoria:'Informes de minoría', otra:'Otras', todas:'Todas'};
const TIPO_LBL={proyecto:'Proyecto de ley', nombramiento:'Nombramiento / ratificación', informe_minoria:'Informe de minoría', otra:'Otra votación'};
const BANCADA_CORTO={VA:'Vamos', RM:'RM', PRD:'PRD', PN:'Panameñista', CD:'CD', SEG:'Seguimos', IND:'Independientes',
  PA:'Alianza', PP:'PP', MO:'Molirena'};
const bancada=c=>BANCADA_CORTO[c]||VOT?.partidos?.[c]?.nombre||c||'—';
const RES_CLASE={Aprobado:'etapa-ley', Rechazado:'etapa-neg', Mixto:'etapa-obj'};
const pct1=(n,d)=>d?Math.round(1000*n/d)/10:0;
const fmtPct=v=>v==null?'—':Number(v).toLocaleString('es-PA',{maximumFractionDigits:1})+'%';
const nombreDip=slug=>(D?.diputados||[]).find(d=>depSlug(d)===slug)?.nombre||VMET?.diputados?.[slug]?.nombre_api||slug;
let votSeg='proyecto', votFiltradas=[], votMostradas=0, _votT=null, _votCharts=[];
const VOT_PAGINA=20;

// Barra apilada a favor / en contra / abstención, con los números escritos
function barraVoto(f,c,a,{compacta=false}={}){
  const n=f+c+a;
  if(!n) return '<div class="vot-barra-vacia">Sin votos registrados</div>';
  const seg=(s,v)=>v?`<span class="vb-${s}" style="flex-grow:${v}" title="${VOTO_LBL[s]}: ${v}"></span>`:'';
  const txt=`${VOTO_ICO.favor} ${f} a favor · ${VOTO_ICO.contra} ${c} en contra · ${VOTO_ICO.abstencion} ${a} abstención`;
  return `<div class="vot-barra${compacta?' compacta':''}" role="img" aria-label="${txt}">${seg('favor',f)}${seg('contra',c)}${seg('abstencion',a)}</div>
    ${compacta?'':`<div class="vot-barra-txt">${txt}</div>`}`;
}
const chipVoto=s=>s?`<span class="vot-chip v-${s}">${VOTO_ICO[s]} ${VOTO_LBL[s]}</span>`:'<span class="vot-chip v-aus">Sin voto registrado</span>';

// ── PESTAÑA ───────────────────────────────────────
async function initVotaciones(){
  if(!D) return;
  if(!_votInit){
    _votInit=Promise.all([ensureVotaciones(), ensureVotosDip(), ensureMatriz()]).then(()=>{
      if(!VOT) throw new Error('votaciones.json no disponible');
      prepararFiltrosVot();
      renderVotPanel();
    }).catch(e=>{ _votInit=null; throw e; });
  }
  try{ await _votInit; }
  catch(e){ document.getElementById('vot-kpis').innerHTML=`<div class="loader" style="grid-column:1/-1">⚠️ No se pudieron cargar las votaciones: ${esc(e.message)}</div>`; return; }
  if(votPendiente){
    const p=votPendiente; votPendiente=null;
    ['vot-q','vot-desde','vot-hasta','vot-debate','vot-partido','vot-resultado'].forEach(id=>{ document.getElementById(id).value=''; });
    document.getElementById('vot-dip').value=p.dip||'';
    if(p.dip&&votSeg!=='todas') setVotSeg('todas', false);   // "ver todas sus votaciones": de todos los tipos
    if(p.id){
      const v=VOT.votaciones.find(x=>x.votacion_id===p.id);
      if(v && votSeg!=='todas' && v.tipo!==votSeg) setVotSeg(v.tipo, false);
      aplicarFiltroVot(p.id);
      return;
    }
  }
  aplicarFiltroVot();
}

function prepararFiltrosVot(){
  const seg=document.getElementById('vot-seg');
  seg.innerHTML=['proyecto','nombramiento','informe_minoria','otra','todas'].map(s=>{
    const n=s==='todas'?VOT.votaciones.length:VOT.votaciones.filter(v=>v.tipo===s).length;
    return `<button class="map-chip${s===votSeg?' active':''}" data-seg="${s}" aria-pressed="${s===votSeg}" onclick="setVotSeg(this.dataset.seg)">${SEG_LBL[s]} <span class="vot-n">${n}</span></button>`;
  }).join('');
  const codes=Object.keys(VOT.partidos||{}).sort((a,b)=>bancada(a).localeCompare(bancada(b),'es'));
  document.getElementById('vot-partido').insertAdjacentHTML('beforeend',codes.map(c=>`<option value="${esc(c)}">${esc(bancada(c))}</option>`).join(''));
  const slugs=Object.keys(VMAT?.diputados||{}).sort((a,b)=>nombreDip(a).localeCompare(nombreDip(b),'es'));
  document.getElementById('vot-dip').insertAdjacentHTML('beforeend',slugs.map(s=>`<option value="${esc(s)}">${esc(nombreDip(s))}</option>`).join(''));
  const fechas=VOT.votaciones.map(v=>v.fecha).sort();
  ['vot-desde','vot-hasta'].forEach(id=>{ const el=document.getElementById(id); el.min=fechas[0]; el.max=fechas[fechas.length-1]; });
}

function setVotSeg(s, render=true){
  votSeg=s;
  document.querySelectorAll('#vot-seg .map-chip').forEach(b=>{ const on=b.dataset.seg===s; b.classList.toggle('active',on); b.setAttribute('aria-pressed',on); });
  renderVotPanel();
  if(render) aplicarFiltroVot();
}

const votDelSeg=()=>VOT.votaciones.filter(v=>votSeg==='todas'||v.tipo===votSeg);

function destruirVotCharts(){ _votCharts.forEach(c=>c.destroy()); _votCharts=[]; }

function renderVotPanel(){
  destruirVotCharts();
  const vs=votDelSeg(), g=votSeg==='todas'
    ? Object.values(VOT.resumen_segmentos||{}).reduce((a,x)=>({decisiones:a.decisiones+x.decisiones,unanimes:a.unanimes+x.unanimes}),{decisiones:0,unanimes:0})
    : (VOT.resumen_segmentos||{})[votSeg]||{decisiones:0,unanimes:0};
  const porPregunta=(VMET?.unidad_por_pregunta||[]).includes(votSeg);
  const rech=vs.filter(v=>v.resultado==='Rechazado').length;
  const votantes=vs.map(v=>v.total_favor+v.total_contra+v.total_abst);
  const promVot=votantes.length?Math.round(votantes.reduce((a,b)=>a+b,0)/votantes.length):0;
  document.getElementById('vot-kpis').innerHTML=[
    {l:'Votaciones',v:fmtNum(vs.length),s:porPregunta?`${fmtNum(g.decisiones)} decisiones (una por persona o informe)`:`desde el ${fmtFecha(VOT.desde)}`,c:'var(--acc)'},
    {l:'Unánimes',v:fmtPct(pct1(g.unanimes,g.decisiones)),s:`${fmtNum(g.unanimes)} sin votos en contra ni abstenciones`,c:'var(--v-fav)'},
    {l:'Rechazadas',v:fmtNum(rech),s:`${fmtPct(pct1(rech,vs.length))} de las votaciones`,c:'var(--v-con)'},
    {l:'Diputados que votan',v:fmtNum(promVot),s:'promedio por votación, de 71 curules',c:'var(--acc5)'},
  ].map(k=>`<div class="kpi" style="--kc:${k.c}"><div class="kpi-label">${k.l}</div><div class="kpi-value">${k.v}</div><div class="kpi-sub">${esc(k.s)}</div></div>`).join('');
  document.getElementById('vot-seg-nota').innerHTML=porPregunta
    ? 'En este tipo de votación se decide <b>persona por persona</b> (o informe por informe): cada pregunta cuenta como una decisión.'
    : votSeg==='todas' ? 'Incluye proyectos de ley, nombramientos, informes de minoría y otras votaciones.'
    : 'Cada votación es un debate (segundo o tercero) de un proyecto. El voto de cada diputado es su <a href="#metodologia">voto global</a>.';
  const esProy=votSeg==='proyecto'||votSeg==='todas';
  document.getElementById('vot-card-embudo').hidden=!esProy;
  document.getElementById('vot-card-dias').hidden=!esProy;
  document.getElementById('vot-card-divididos').hidden=!esProy;
  try{ renderHemiDestacado(vs); }catch(e){ console.error('Hemiciclo:',e); }
  try{ chartVotMes(vs); }catch(e){ console.error('Votaciones por mes:',e); }
  try{ chartVotMargen(vs); }catch(e){ console.error('Margen:',e); }
  if(esProy){
    try{ renderEmbudoPleno(); }catch(e){ console.error('Embudo:',e); }
    try{ chartDiasDebate(); }catch(e){ console.error('Días entre debates:',e); }
    try{ renderMasDivididos(); }catch(e){ console.error('Más divididos:',e); }
  }
  try{ chartCohesion('c-vot-cohesion', votSeg, _votCharts); }catch(e){ console.error('Cohesión:',e); }
  try{ initCohesionMensual(); }catch(e){ console.error('Cohesión mensual:',e); }
  try{ renderAcuerdo(); }catch(e){ console.error('Acuerdo:',e); }
  try{ chartDisidencia(); }catch(e){ console.error('Disidencia:',e); }
}

// Hemiciclo de una votación elegida (por defecto, la más reciente del tipo seleccionado)
const etiquetaVot=v=>`${fmtFecha(v.fecha)} · ${v.proyecto?`Proyecto ${v.proyecto}${v.debate?' · '+v.debate+' debate':''}`:TIPO_LBL[v.tipo]} · ${v.resultado}`;
function renderHemiDestacado(vs){
  const sel=document.getElementById('vot-hemi-sel');
  sel.innerHTML=vs.map(v=>`<option value="${v.votacion_id}">${esc(etiquetaVot(v))}</option>`).join('');
  elegirHemiDestacado();
}
function elegirHemiDestacado(){
  const id=+document.getElementById('vot-hemi-sel').value, v=VOT.votaciones.find(x=>x.votacion_id===id);
  const cont=document.getElementById('vot-hemi');
  if(!v){ cont.innerHTML='<div class="gs-empty">No hay votaciones de este tipo.</div>'; return; }
  document.getElementById('vot-hemi-tit').innerHTML=`${esc(v.descripcion||v.titulo)} <a href="#votacion=${id}">Ver en la lista →</a>`;
  delete cont.dataset.listo;
  mostrarDetalleVot(id,'vot-hemi');
}

const OPC_EJES={grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},precision:0}};
const OPC_TOOLTIP={backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1};
const MESES_CORTOS=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const fmtMes=m=>{ const [y,mm]=m.split('-'); return `${MESES_CORTOS[+mm-1]} ${y.slice(2)}`; };
function mesesEntre(a,b){
  const out=[]; let [y,m]=a.split('-').map(Number); const [yb,mb]=b.split('-').map(Number);
  while(y<yb||(y===yb&&m<=mb)){ out.push(`${y}-${String(m).padStart(2,'0')}`); m++; if(m>12){m=1;y++;} }
  return out;
}

// Ritmo del pleno: votaciones por mes, unánimes vs. divididas
function chartVotMes(vs){
  const meses=vs.length?mesesEntre(VOT.desde.slice(0,7), vs.map(v=>v.fecha.slice(0,7)).sort().pop()):[];
  const cuenta=(m,u)=>vs.filter(v=>v.fecha.startsWith(m)&&v.unanime===u).length;
  _votCharts.push(new Chart(document.getElementById('c-vot-mes'),{type:'bar',
    data:{labels:meses.map(fmtMes),datasets:[
      {label:'Unánimes',data:meses.map(m=>cuenta(m,true)),backgroundColor:'#3b82f6',borderRadius:4,borderSkipped:false},
      {label:'Divididas',data:meses.map(m=>cuenta(m,false)),backgroundColor:'#f59e0b',borderRadius:4,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'top',align:'end',labels:{boxWidth:10,font:{family:'DM Mono',size:10}}},tooltip:{...OPC_TOOLTIP,mode:'index',
        callbacks:{footer:items=>`Total: ${items.reduce((a,i)=>a+i.raw,0)} votaciones`}}},
      scales:{x:{stacked:true,grid:{display:false},ticks:{...OPC_EJES.ticks,maxRotation:0,autoSkip:true,maxTicksLimit:isMobile()?6:14}},
        y:{stacked:true,beginAtZero:true,...OPC_EJES}}}}));
}

// ¿Qué tan dividido vota el pleno? Votaciones según el porcentaje a favor
const MARGENES=[
  ['Unánime',v=>v.unanime],
  ['Consenso amplio (90 % o más a favor)',(v,p)=>p>=90],
  ['Mayoría clara (75–90 %)',(v,p)=>p>=75],
  ['Dividida (menos de 75 % a favor)',()=>true],
];
function chartVotMargen(vs){
  const cuenta=MARGENES.map(()=>0); let rech=0;
  vs.forEach(v=>{
    if(v.resultado==='Rechazado'){ rech++; return; }
    const n=v.total_favor+v.total_contra+v.total_abst, p=n?100*v.total_favor/n:0;
    cuenta[MARGENES.findIndex(([,f])=>f(v,p))]++;
  });
  const labels=[...MARGENES.map(m=>m[0]),'Rechazada'], data=[...cuenta,rech];
  _votCharts.push(new Chart(document.getElementById('c-vot-margen'),{type:'bar',
    data:{labels,datasets:[{label:'Votaciones',data,backgroundColor:'#3b82f6',borderRadius:4,borderSkipped:false,barThickness:18}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...OPC_TOOLTIP,callbacks:{label:c=>` ${c.raw} votaciones (${fmtPct(pct1(c.raw,vs.length))})`}}},
      scales:{x:{beginAtZero:true,...OPC_EJES},y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}}));
}

// Del pleno a la ley: proyectos aprobados en 2.º y 3.er debate y su etapa actual
function renderEmbudoPleno(){
  const proy=VOT.votaciones.filter(v=>v.tipo==='proyecto');
  const conAprob=d=>new Set(proy.filter(v=>v.debate===d&&v.resultado!=='Rechazado').map(v=>v.proyecto));
  const seg=conAprob('Segundo'), ter=conAprob('Tercer');
  const etapa={};
  proy.forEach(v=>{ if(v.ficha&&v.etapa_actual) etapa[v.proyecto]=v.etapa_actual; });
  const de3=[...ter].map(p=>etapa[p]||'');
  const filas=[
    ['Aprobados en segundo debate',seg.size,'Segundo Debate'],
    ['Aprobados en tercer debate',ter.size,'Tercer Debate'],
    ['… ya son ley',de3.filter(e=>e==='Ley').length,'Ley'],
    ['… objetados por el Ejecutivo',de3.filter(e=>e.includes('Objetado')).length,'Objetado por Ejecutivo'],
    ['… esperan sanción del Ejecutivo',de3.filter(e=>e==='Enviado al Ejecutivo').length,'Enviado al Ejecutivo'],
  ];
  const max=Math.max(...filas.map(f=>f[1]),1), theme=currentTheme();
  document.getElementById('vot-embudo').innerHTML=filas.map(([l,n,e])=>{
    const col=etapaColor(e,theme);
    return `<div class="f-row"><div class="f-lbl" title="${esc(l)}">${esc(l)}</div><div class="f-wrap"><div class="f-bar" style="width:${Math.max(Math.round(100*n/max),3)}%;background:${col};color:${tintaSobre(col)}">${n}</div></div></div>`;
  }).join('')+`<p class="monitor-note" style="margin-top:10px">Proyectos distintos con al menos una votación aprobatoria en el pleno desde el ${esc(fmtFecha(VOT.desde))}. La etapa actual sale del Seguimiento Legislativo.</p>`;
}

// Días entre el segundo y el tercer debate de un mismo proyecto
const DIAS_BINS=[['Mismo día',0,0],['1 a 7 días',1,7],['8 a 30 días',8,30],['31 a 90 días',31,90],['Más de 90 días',91,1e9]];
function chartDiasDebate(){
  const fechas={};
  VOT.votaciones.filter(v=>v.tipo==='proyecto'&&v.resultado!=='Rechazado').forEach(v=>{
    const f=fechas[v.proyecto]||(fechas[v.proyecto]={});
    if(v.debate==='Segundo') f.s=f.s&&f.s<v.fecha?f.s:v.fecha;
    if(v.debate==='Tercer') f.t=f.t&&f.t>v.fecha?f.t:v.fecha;
  });
  const dias=Object.values(fechas).filter(f=>f.s&&f.t&&f.t>=f.s).map(f=>diasEntre(f.s,f.t)).sort((a,b)=>a-b);
  const med=dias.length?dias[Math.floor((dias.length-1)/2)]:null;
  document.getElementById('vot-dias-nota').innerHTML=dias.length
    ? `Mediana: <b>${fmtNum(med)} días</b> entre ambos debates, en ${fmtNum(dias.length)} proyectos con los dos votados en esta legislatura.`
    : 'Aún no hay proyectos con ambos debates registrados.';
  _votCharts.push(new Chart(document.getElementById('c-vot-dias'),{type:'bar',
    data:{labels:DIAS_BINS.map(b=>b[0]),datasets:[{label:'Proyectos',data:DIAS_BINS.map(([,a,b])=>dias.filter(d=>d>=a&&d<=b).length),backgroundColor:'#a78bfa',borderRadius:4,borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...OPC_TOOLTIP,callbacks:{label:c=>` ${c.raw} proyectos`}}},
      scales:{x:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}},y:{beginAtZero:true,...OPC_EJES}}}}));
}

// Cohesión de bancada: % de votos fuera de la línea mayoritaria del partido (más largo = menos cohesión)
function chartCohesion(id, seg, lista){
  const canvas=document.getElementById(id);
  if(!canvas||!VMET) return;
  const ps=Object.entries(VMET.partidos||{}).filter(([,p])=>p.segmentos?.[seg]?.votos>=20)
    .sort((a,b)=>a[1].segmentos[seg].cohesion-b[1].segmentos[seg].cohesion);
  const ch=new Chart(canvas,{type:'bar',
    data:{labels:ps.map(([c])=>bancada(c)),datasets:[{label:'Votos fuera de la línea de su bancada (%)',
      data:ps.map(([,p])=>Math.round(10*(100-p.segmentos[seg].cohesion))/10),backgroundColor:'#f59e0b',borderRadius:4,borderSkipped:false,barThickness:16}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{...OPC_TOOLTIP,callbacks:{label:c=>{
        const s=ps[c.dataIndex][1].segmentos[seg];
        return [` Cohesión: ${fmtPct(s.cohesion)} de sus votos con la mayoría de la bancada`,` ${fmtNum(s.disidencias)} votos disidentes en ${fmtNum(s.decisiones)} decisiones`];
      }}}},
      scales:{x:{beginAtZero:true,...OPC_EJES,ticks:{...OPC_EJES.ticks,callback:v=>v+'%'}},y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});
  lista?.push(ch);
  return ch;
}

// Evolución mensual de la cohesión de una bancada frente al promedio de las bancadas
let _cohMesChart=null;
function initCohesionMensual(){
  const sel=document.getElementById('vot-cohmes-p'), seg=votSeg;
  const ps=Object.entries(VMET?.partidos||{}).filter(([,p])=>p.segmentos?.[seg]?.votos>=20).sort((a,b)=>b[1].diputados-a[1].diputados);
  const previo=sel.value;
  sel.innerHTML=ps.map(([c])=>`<option value="${esc(c)}">${esc(bancada(c))}</option>`).join('');
  if(ps.some(([c])=>c===previo)) sel.value=previo;
  renderCohesionMensual();
}
function renderCohesionMensual(){
  _cohMesChart?.destroy();
  const seg=votSeg, code=document.getElementById('vot-cohmes-p').value, partidos=VMET?.partidos||{};
  const serie=partidos[code]?.segmentos?.[seg]?.mensual||{};
  const meses=[...new Set(Object.values(partidos).flatMap(p=>Object.keys(p.segmentos?.[seg]?.mensual||{})))].sort();
  const prom=meses.map(m=>{ const v=Object.values(partidos).map(p=>p.segmentos?.[seg]?.mensual?.[m]).filter(x=>x!=null); return v.length?Math.round(10*v.reduce((a,b)=>a+b,0)/v.length)/10:null; });
  _cohMesChart=new Chart(document.getElementById('c-vot-cohmes'),{type:'line',
    data:{labels:meses.map(fmtMes),datasets:[
      {label:bancada(code),data:meses.map(m=>serie[m]??null),borderColor:'#3b82f6',backgroundColor:'#3b82f6',borderWidth:2,pointRadius:4,spanGaps:true,tension:.2},
      {label:'Promedio de las bancadas',data:prom,borderColor:'#7a8fb0',backgroundColor:'#7a8fb0',borderWidth:2,borderDash:[5,4],pointRadius:0,spanGaps:true,tension:.2}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{position:'top',align:'end',labels:{boxWidth:10,font:{family:'DM Mono',size:10}}},
        tooltip:{...OPC_TOOLTIP,callbacks:{label:c=>` ${c.dataset.label}: ${fmtPct(c.raw)}`}}},
      scales:{x:{grid:{display:false},ticks:{...OPC_EJES.ticks,maxRotation:0,autoSkip:true,maxTicksLimit:isMobile()?6:12}},
        y:{...OPC_EJES,suggestedMax:100,ticks:{...OPC_EJES.ticks,callback:v=>v+'%'}}}}});
  _votCharts.push(_cohMesChart);
}

// ¿Cuánto coinciden las bancadas? Matriz de acuerdo (color = desacuerdo, número = coincidencia)
function renderAcuerdo(){
  const cont=document.getElementById('vot-acuerdo'), seg=votSeg;
  const ac=VMET?.acuerdo_partidos?.[seg]||{};
  const codes=Object.entries(VMET?.partidos||{}).filter(([c,p])=>p.segmentos?.[seg]?.votos>=20).sort((a,b)=>b[1].diputados-a[1].diputados).map(([c])=>c);
  if(codes.length<2){ cont.innerHTML='<div class="gs-empty">No hay suficientes votaciones de este tipo para comparar bancadas.</div>'; return; }
  const celda=(a,b)=>ac[[a,b].sort().join('|')];
  const max=Math.max(...codes.flatMap(a=>codes.map(b=>{ const x=a!==b&&celda(a,b); return x&&x.decisiones>=5?100-x.pct:0; })),1);
  cont.innerHTML=`<table class="heat"><thead><tr><th scope="col"></th>${codes.map(c=>`<th scope="col">${esc(bancada(c))}</th>`).join('')}</tr></thead>
    <tbody>${codes.map(a=>`<tr><th scope="row">${esc(bancada(a))}</th>${codes.map(b=>{
      if(a===b) return '<td class="vacio propio">—</td>';
      const x=celda(a,b);
      if(!x||x.decisiones<5) return `<td class="vacio" title="Pocas decisiones en común">·</td>`;
      const p=Math.round(8+82*(100-x.pct)/max);
      return `<td title="${esc(`${bancada(a)} y ${bancada(b)}: misma postura mayoritaria en ${x.coinciden} de ${x.decisiones} decisiones (${fmtPct(x.pct)})`)}" style="background:color-mix(in srgb,var(--acc2) ${p}%,transparent);color:${p>55?'#fff':'var(--text)'}">${Math.round(x.pct)}%</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`
    +`<div class="heat-leyenda"><span>coinciden</span><span class="barra" style="background:linear-gradient(90deg,transparent,var(--acc2))"></span><span>discrepan</span><span>· el número es el % de decisiones en que la mayoría de ambas bancadas votó igual</span></div>`;
}

// Diputados que más se apartan de su bancada
function chartDisidencia(){
  const seg=votSeg, base=seg==='proyecto'||seg==='todas'?30:10;
  const rows=Object.entries(VMET?.diputados||{}).map(([slug,d])=>({slug,s:d.segmentos?.[seg],p:d.partido_api}))
    .filter(r=>r.s&&r.s.base_disidencia>=base&&r.s.tasa_disidencia>0).sort((a,b)=>b.s.tasa_disidencia-a.s.tasa_disidencia).slice(0,15);
  document.getElementById('vot-disid-nota').textContent=rows.length
    ? `Porcentaje de sus votos distintos a la mayoría de su bancada (diputados con al menos ${base} votos comparables). Toca una barra para ver su ficha.`
    : 'Ningún diputado votó distinto a su bancada en este tipo de votación.';
  _votCharts.push(new Chart(document.getElementById('c-vot-disid'),{type:'bar',
    data:{labels:rows.map(r=>`${nombreDip(r.slug)} (${bancada(r.p)})`),datasets:[{label:'Se aparta de su bancada (%)',data:rows.map(r=>r.s.tasa_disidencia),backgroundColor:'#f59e0b',borderRadius:4,borderSkipped:false,barThickness:14}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      onClick:(e,els)=>{ if(els.length) location.hash='diputado='+rows[els[0].index].slug; },
      onHover:(e,els)=>{ e.native.target.style.cursor=els.length?'pointer':'default'; },
      plugins:{legend:{display:false},tooltip:{...OPC_TOOLTIP,callbacks:{label:c=>{ const s=rows[c.dataIndex].s; return ` ${fmtPct(s.tasa_disidencia)}: ${s.disidencias} de ${s.base_disidencia} votos`; }}}},
      scales:{x:{beginAtZero:true,...OPC_EJES,ticks:{...OPC_EJES.ticks,callback:v=>v+'%'}},y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}}));
}

function renderMasDivididos(){
  const l=VMET?.mas_divididos||[];
  document.getElementById('vot-divididos').innerHTML=l.length?l.slice(0,8).map(x=>`<div class="vot-div-item">
      <div class="vot-div-top"><a href="#votacion=${x.votacion_id}">Proyecto ${esc(x.proyecto)}</a> · ${esc(x.debate?x.debate+' debate':'')} · ${esc(fmtFecha(x.fecha))}
        <span class="badge ${RES_CLASE[x.resultado]||''}">${esc(x.resultado)}</span></div>
      <div class="vot-div-tit">${esc(x.descripcion)}</div>${barraVoto(x.favor,x.contra,x.abst)}</div>`).join('')
    :'<div class="gs-empty">Sin votaciones divididas.</div>';
}

// ── LISTA ─────────────────────────────────────────
function filtrarVotaciones(){ clearTimeout(_votT); _votT=setTimeout(()=>aplicarFiltroVot(),120); }

function aplicarFiltroVot(soloId){
  if(!VOT) return;
  const val=id=>document.getElementById(id).value;
  const palabras=sinTildes(val('vot-q').trim()).split(/\s+/).filter(Boolean);
  const desde=val('vot-desde'), hasta=val('vot-hasta'), debate=val('vot-debate'), par=val('vot-partido'), res=val('vot-resultado'), dip=val('vot-dip');
  const idx=VMAT?Object.fromEntries(VMAT.votaciones.map((id,i)=>[id,i])):{};
  const fila=dip&&VMAT?.diputados?.[dip];
  votFiltradas=votDelSeg().filter(v=>{
    if(soloId) return v.votacion_id===soloId;
    if(desde&&v.fecha<desde||hasta&&v.fecha>hasta) return false;
    if(debate&&(debate==='sin'?v.debate:v.debate!==debate)) return false;
    if(par&&!v.por_partido?.[par]) return false;
    if(res==='unanime'&&!v.unanime||res==='dividida'&&v.unanime||['Aprobado','Rechazado','Mixto'].includes(res)&&v.resultado!==res) return false;
    if(res==='contra'&&par){ const [f,c,a]=v.por_partido[par]; if(f>=c+a) return false; }
    if(fila&&fila[idx[v.votacion_id]]==='.') return false;
    if(palabras.length){ const t=sinTildes(`${v.titulo} ${v.descripcion} ${v.proyecto||''}`); if(!palabras.every(w=>t.includes(w))) return false; }
    return true;
  });
  const n=votFiltradas.length, apr=votFiltradas.filter(v=>v.resultado==='Aprobado').length, un=votFiltradas.filter(v=>v.unanime).length;
  document.getElementById('vot-resumen').innerHTML = n
    ? `<b>${fmtNum(n)}</b> votacion${n===1?'':'es'} · <b>${fmtNum(apr)}</b> aprobada${apr===1?'':'s'} · <b>${fmtNum(un)}</b> unánime${un===1?'':'s'}`
      +(soloId?' · <button class="dl-btn" onclick="setHash(\'votaciones\');aplicarFiltroVot()">Ver todas</button>':'')
    : 'Ninguna votación coincide con los filtros.';
  votMostradas=0;
  document.getElementById('vot-lista').innerHTML='';
  masVotaciones();
  if(soloId){ const b=document.querySelector(`#vot-${soloId} .vot-ver`); if(b){ toggleDetalleVot(soloId,b); setTimeout(()=>document.getElementById('vot-'+soloId)?.scrollIntoView({behavior:'smooth',block:'start'}),120); } }
}

function masVotaciones(){
  const par=document.getElementById('vot-partido').value, dip=document.getElementById('vot-dip').value;
  const idx=VMAT?Object.fromEntries(VMAT.votaciones.map((id,i)=>[id,i])):{};
  const lote=votFiltradas.slice(votMostradas, votMostradas+VOT_PAGINA);
  document.getElementById('vot-lista').insertAdjacentHTML('beforeend', lote.map(v=>{
    const pp=par&&v.por_partido?.[par];
    const c=dip&&VMAT?.diputados?.[dip]?.[idx[v.votacion_id]];
    const votoDip=c&&c!=='.'?`<span>${esc(nombreDip(dip))}: ${chipVoto(LETRA_VOTO[c.toUpperCase()])}${c===c.toLowerCase()&&c!=='-'?' <small>(votó su suplente)</small>':''}</span>`:'';
    return `<article class="proy-item vot-item" id="vot-${v.votacion_id}">
      <div class="proy-top"><span>📅 ${esc(fmtFecha(v.fecha))}</span><span class="badge vot-tipo">${esc(TIPO_LBL[v.tipo]||v.tipo)}</span>
        ${v.debate?`<span class="badge etapa-deb">${esc(v.debate)} debate${v.debate_inferido?'*':''}</span>`:''}
        ${v.proyecto?`<span>Proyecto ${esc(v.proyecto)}</span>`:''}${v.objetado?'<span class="badge etapa-obj">Objetado</span>':''}
        <span class="badge ${RES_CLASE[v.resultado]||''}">${esc(v.resultado)}</span>${v.unanime?'<span class="badge vot-unan">Unánime</span>':''}
        <a href="#votacion=${v.votacion_id}" title="Enlace directo a esta votación" style="color:var(--muted);text-decoration:none">🔗</a></div>
      <div class="proy-titulo">${esc(v.descripcion||v.titulo)}</div>
      ${barraVoto(v.total_favor,v.total_contra,v.total_abst)}
      <div class="proy-meta">${v.ficha?`<a href="#proyecto=${esc(v.ficha)}">Ver el proyecto (ficha ${esc(v.ficha)})</a>`:''}
        ${v.etapa_actual?`<span>Hoy: <span class="badge ${etapaClass(v.etapa_actual)}">${esc(v.etapa_actual)}</span></span>`:''}
        ${pp?`<span>${esc(bancada(par))}: ${VOTO_ICO.favor} ${pp[0]} · ${VOTO_ICO.contra} ${pp[1]} · ${VOTO_ICO.abstencion} ${pp[2]}</span>`:''}${votoDip}
        <button type="button" class="dl-btn vot-ver" aria-expanded="false" aria-controls="vot-det-${v.votacion_id}" onclick="toggleDetalleVot(${v.votacion_id},this)">Ver voto por diputado</button></div>
      <div class="vot-det" id="vot-det-${v.votacion_id}" hidden></div>
    </article>`;
  }).join(''));
  votMostradas+=lote.length;
  const btn=document.getElementById('vot-mas');
  btn.style.display=votMostradas<votFiltradas.length?'':'none';
  btn.textContent=`Mostrar más (${fmtNum(votFiltradas.length-votMostradas)} restantes)`;
}

// ── DETALLE DE UNA VOTACIÓN ───────────────────────
const _votSel={};   // contenedor → votación, pregunta elegida ('g' = voto global) y modo de color
async function toggleDetalleVot(id, btn){
  const cont=document.getElementById('vot-det-'+id);
  const abrir=cont.hidden;
  cont.hidden=!abrir; btn.setAttribute('aria-expanded',abrir); btn.textContent=abrir?'Ocultar detalle':'Ver voto por diputado';
  if(abrir&&!cont.dataset.listo) mostrarDetalleVot(id, cont.id);
}
async function mostrarDetalleVot(id, cid){
  const cont=document.getElementById(cid);
  cont.innerHTML='<div class="loader"><div class="spinner"></div> Cargando votos…</div>';
  const det=await ensureDetalleVot(id);
  if(!det){ cont.innerHTML='<div class="gs-empty">No se pudo cargar el detalle de esta votación.</div>'; delete _votDet[id]; return; }
  const v=VOT.votaciones.find(x=>x.votacion_id===id);
  _votSel[cid]={id, q:(VMET?.unidad_por_pregunta||[]).includes(v?.tipo)||det.preguntas.length===1?0:'g', color:_votSel[cid]?.color||'voto'};
  cont.dataset.listo='1';
  renderDetalleVot(cid);
}

function asientosVot(det, q){
  // Una curul por diputado principal; vota él o su suplente
  const principales=Object.entries(VMET?.diputados||{}).map(([slug,d])=>({slug,partido:d.partido_api}));
  const voto=f=>RESPUESTA_VOTO(q==='g'?{F:1,C:2,A:3}[f.g]:f.v[q]);
  const porSlug={};
  det.votos.forEach(f=>{
    const s=voto(f); if(!s) return;
    const k=f.s||('id'+f.d);
    if(!porSlug[k]||!f.su) porSlug[k]={voto:s,suplente:f.su?f.n:null,nombre:f.su?f.su:f.n,partido:f.p};
  });
  const seats=principales.map(p=>({slug:p.slug,nombre:nombreDip(p.slug),partido:p.partido,...(porSlug[p.slug]||{voto:null})}));
  Object.entries(porSlug).filter(([k])=>k.startsWith('id')).forEach(([,x])=>seats.push({slug:null,...x}));
  const tam={}; seats.forEach(s=>{ tam[s.partido]=(tam[s.partido]||0)+1; });
  const ordenVoto={favor:0,abstencion:1,contra:2,null:3};
  seats.sort((a,b)=>(a.partido==='IND')-(b.partido==='IND')||tam[b.partido]-tam[a.partido]||String(a.partido).localeCompare(b.partido)
    ||ordenVoto[a.voto]-ordenVoto[b.voto]||a.nombre.localeCompare(b.nombre,'es'));
  return seats;
}
// Separa la curul de quien preside la sesión (si se conoce) para dibujarla aparte
function separarPreside(seats, slug){
  const i=slug?seats.findIndex(s=>s.slug===slug):-1;
  if(i<0) return {seats, preside:null};
  return {seats:seats.filter((_,j)=>j!==i), preside:seats[i]};
}

// Hemiciclo en dos alas con pasillo central (como los diagramas de la Asamblea). Las curules se llenan por
// ángulo, de izquierda a derecha, así cada bancada ocupa un sector; quien preside va abajo, al centro, con anillo.
function hemicicloSVG(seats, color, preside){
  const N=seats.length, filas=5, rIn=44, rOut=100, cx=110, cy=104, pasillo=.13;   // pasillo en radianes a cada lado
  const radios=Array.from({length:filas},(_,i)=>rIn+(rOut-rIn)*i/(filas-1));
  const pos=[];
  [[Math.PI, Math.PI/2+pasillo, Math.ceil(N/2)], [Math.PI/2-pasillo, 0, Math.floor(N/2)]].forEach(([t0,t1,n])=>{
    const sum=radios.reduce((a,b)=>a+b,0);
    const porFila=radios.map(r=>Math.round(n*r/sum));
    porFila[filas-1]+=n-porFila.reduce((a,b)=>a+b,0);
    const ala=[];
    radios.forEach((r,i)=>{ const k=porFila[i]; for(let j=0;j<k;j++){ const t=t0+(t1-t0)*(k===1?.5:j/(k-1)); ala.push({x:cx+r*Math.cos(t),y:cy-r*Math.sin(t),t}); } });
    ala.sort((a,b)=>b.t-a.t||a.y-b.y);
    pos.push(...ala);
  });
  const colorP=c=>VOT.partidos?.[c]?.color||'#7a8fb0';
  const curul=(s,x,y,extra='')=>{
    const tit=`${s.nombre}${s.suplente?` (votó su suplente ${s.suplente})`:''} · ${bancada(s.partido)} · ${s.voto?VOTO_LBL[s.voto]:'sin voto registrado'}${extra}`;
    const fill=color==='partido'?`style="fill:${esc(colorP(s.partido))}"`:'';
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5.2" class="${color==='partido'?'h-par'+(s.voto?'':' h-aus'):'v-'+(s.voto||'aus')}" ${fill}><title>${esc(tit)}</title></circle>`;
  };
  const total=N+(preside?1:0);
  return `<svg class="hemiciclo" viewBox="0 0 220 ${preside?132:112}" role="img" aria-label="Hemiciclo de ${total} curules: una por diputado. Los mismos datos están en la tabla de abajo.">
    ${seats.map((s,i)=>curul(s,pos[i].x,pos[i].y)).join('')}
    <text x="${cx}" y="${cy-2}" text-anchor="middle" class="h-total">${total}</text>
    ${preside?`<circle cx="${cx}" cy="${cy+18}" r="7.6" class="h-anillo"/>${curul(preside,cx,cy+18,' · preside la sesión')}`:''}
  </svg>`;
}

function renderDetalleVot(cid){
  const sel=_votSel[cid], id=sel.id;
  ensureDetalleVot(id).then(det=>{
    const cont=document.getElementById(cid), v=VOT.votaciones.find(x=>x.votacion_id===id);
    const q=sel.q, preg=q==='g'?null:det.preguntas[q];
    const seats=asientosVot(det,q);
    const cuenta=s=>seats.filter(x=>x.voto===s).length, sinVoto=seats.filter(x=>!x.voto).length;
    const opciones=(v&&!(VMET?.unidad_por_pregunta||[]).includes(v.tipo)&&det.preguntas.length>1?[`<option value="g">Voto global (ver metodología)</option>`]:[])
      .concat(det.preguntas.map((p,i)=>`<option value="${i}">${esc(p.t.slice(0,80))} — ${p.r===1?'Aprobado':'Rechazado'}</option>`));
    const partidos=[...new Set(seats.map(s=>s.partido))];
    cont.innerHTML=`<div class="vot-det-ctrl">
        ${det.preguntas.length>1||opciones.length>1?`<select class="cmp-select" aria-label="Pregunta votada" onchange="_votSel['${cid}'].q=this.value==='g'?'g':+this.value;renderDetalleVot('${cid}')">${opciones.join('')}</select>`:''}
        <div class="map-filter-group"><span class="map-filter-lbl">Colorear por</span>
          ${['voto','partido'].map(c=>`<button class="map-chip${sel.color===c?' active':''}" aria-pressed="${sel.color===c}" onclick="_votSel['${cid}'].color='${c}';renderDetalleVot('${cid}')">${c==='voto'?'Voto':'Bancada'}</button>`).join('')}</div>
      </div>
      ${preg?`<div class="vot-preg">${esc(preg.t)} · se necesitaban ${preg.n} votos · <span class="badge ${preg.r===1?'etapa-ley':'etapa-neg'}">${preg.r===1?'Aprobado':'Rechazado'}</span>
        ${preg.o.filter(o=>o[0]>3).length?`<div class="vot-modif">Opciones de modificación (cuentan como a favor): ${preg.o.filter(o=>o[0]>3).map(o=>`${esc(o[1])} (${o[2]})`).join(' · ')}</div>`:''}</div>`:''}
      <div class="vot-hemi-wrap">${(({seats:alas,preside})=>hemicicloSVG(alas, sel.color, preside))(separarPreside(seats, det.preside))}
        ${det.preside?`<div class="vot-barra-txt" style="text-align:center">Curul con anillo: ${esc(nombreDip(det.preside))}, quien presidía la sesión.</div>`:''}
        <div class="vot-hemi-centro">${barraVoto(cuenta('favor'),cuenta('contra'),cuenta('abstencion'))}<div class="vot-barra-txt">· ${sinVoto} curules sin voto registrado</div></div></div>
      <div class="vot-leyenda">${sel.color==='voto'
        ? ['favor','contra','abstencion'].map(s=>`<span><i class="v-${s}"></i>${VOTO_ICO[s]} ${VOTO_LBL[s]}</span>`).join('')+'<span><i class="v-aus"></i>Sin voto registrado</span>'
        : partidos.map(c=>`<span><i style="background:${esc(VOT.partidos?.[c]?.color||'#7a8fb0')}"></i>${esc(bancada(c))}</span>`).join('')+'<span><i class="v-aus"></i>Contorno = sin voto</span>'}</div>
      ${det.preguntas.length>1?`<details class="proy-firmas"><summary>Resultado por artículo (${det.preguntas.length})</summary><div class="tbl-scroll"><table class="cmp-tbl vot-arts">
        <thead><tr><th>Pregunta</th><th>Resultado</th><th>Votos</th></tr></thead><tbody>${det.preguntas.map((p,i)=>{
          const t=k=>p.o.filter(o=>k==='favor'?(o[0]===1||o[0]>3):o[0]===(k==='contra'?2:3)).reduce((a,o)=>a+o[2],0);
          return `<tr><th><button type="button" class="vot-art-btn" onclick="_votSel['${cid}'].q=${i};renderDetalleVot('${cid}')">${esc(p.t)}</button></th>
            <td><span class="badge ${p.r===1?'etapa-ley':'etapa-neg'}">${p.r===1?'Aprobado':'Rechazado'}</span></td><td style="min-width:150px">${barraVoto(t('favor'),t('contra'),t('abstencion'),{compacta:true})}<span class="ief-sub">${t('favor')} · ${t('contra')} · ${t('abstencion')}</span></td></tr>`;
        }).join('')}</tbody></table></div></details>`:''}
      <details class="proy-firmas"><summary>Voto de cada diputado (${seats.length})</summary><div class="tbl-scroll"><table class="cmp-tbl vot-tabla">
        <thead><tr><th>Diputado</th><th>Bancada</th><th>Voto</th></tr></thead><tbody>${seats.map(s=>`<tr>
          <th>${s.slug?`<a href="#diputado=${esc(s.slug)}">${esc(s.nombre)}</a>`:esc(s.nombre)}${s.suplente?`<div class="ief-sub">votó su suplente: ${esc(s.suplente)}</div>`:''}</th>
          <td>${esc(bancada(s.partido))}</td><td>${chipVoto(s.voto)}</td></tr>`).join('')}</tbody></table></div></details>`;
    const s=cont.querySelector('select'); if(s) s.value=String(q);
  });
}

// ── EN OTRAS PESTAÑAS ─────────────────────────────
// Proyectos: "Cómo se votó" (segundo y tercer debate)
function votacionesDeFicha(ficha){
  if(!VOT) return [];
  if(!votacionesDeFicha.m){
    const m={}; VOT.votaciones.forEach(v=>{ if(v.ficha) (m[v.ficha]=m[v.ficha]||[]).push(v); });
    Object.values(m).forEach(l=>l.sort((a,b)=>a.fecha.localeCompare(b.fecha)||a.votacion_id-b.votacion_id));
    votacionesDeFicha.m=m;
  }
  return votacionesDeFicha.m[ficha]||[];
}
function comoSeVotoHTML(ficha){
  const l=votacionesDeFicha(ficha);
  if(!l.length) return '';
  return `<details class="proy-firmas vot-proy"><summary>🗳 Cómo se votó (${l.length})</summary>${l.map(v=>`<div class="vot-proy-item">
      <div class="vot-div-top"><b>${esc(v.tipo==='informe_minoria'?'Informe de minoría':(v.debate||'')+' debate')}</b> · ${esc(fmtFecha(v.fecha))}
        <span class="badge ${RES_CLASE[v.resultado]||''}">${esc(v.resultado)}</span>${v.unanime?'<span class="badge vot-unan">Unánime</span>':''}
        <a href="#votacion=${v.votacion_id}">Detalle nominal →</a></div>
      ${barraVoto(v.total_favor,v.total_contra,v.total_abst)}</div>`).join('')}</details>`;
}

// Diputados: pestaña "Votaciones" de la ficha
let _modalVotSeg='proyecto';
async function renderModalVotaciones(dep){
  const body=document.getElementById('modal-body');
  body.innerHTML='<div class="loader"><div class="spinner"></div> Cargando votaciones…</div>';
  await Promise.all([ensureVotaciones(), ensureVotosDip(), ensureMatriz()]);
  if(_modalDep!==dep||!document.getElementById('mtab-vot').classList.contains('active')) return;
  const slug=depSlug(dep), m=VMET?.diputados?.[slug];
  if(!m){ body.innerHTML='<div class="gs-empty">No hay votaciones registradas para este diputado (o su nombre no se pudo relacionar con certeza).</div>'; return; }
  const segs=['proyecto','nombramiento','informe_minoria','todas'].filter(s=>m.segmentos[s]);
  if(!segs.includes(_modalVotSeg)) _modalVotSeg=segs[0];
  const seg=_modalVotSeg, s=m.segmentos[seg], sup=m.como_suplente?.[seg]||0;
  const fila=VMAT?.diputados?.[slug]||'', ids=VMAT?.votaciones||[], porId=Object.fromEntries(VOT.votaciones.map(v=>[v.votacion_id,v]));
  const celdas=ids.map((id,i)=>({v:porId[id],c:fila[i]})).filter(x=>x.v&&(seg==='todas'||x.v.tipo===seg));
  body.innerHTML=`<div class="map-filter-group" style="margin:12px 0">${segs.map(x=>`<button class="map-chip${x===seg?' active':''}" aria-pressed="${x===seg}" onclick="_modalVotSeg='${x}';renderModalVotaciones(_modalDep)">${SEG_LBL[x]}</button>`).join('')}</div>
    <div class="vot-tiles">
      <div><b>${fmtNum(s.participo)}</b><span>votó en persona, de ${fmtNum(s.decisiones)} decisiones</span></div>
      <div><b>${fmtNum(sup)}</b><span>votó su suplente</span></div>
      <div><b>${fmtPct(s.pct_favor)}</b><span>a favor</span></div>
      <div><b>${fmtPct(s.tasa_disidencia)}</b><span>se apartó de su bancada (${s.disidencias} de ${s.base_disidencia})</span></div>
    </div>
    ${barraVoto(s.favor,s.contra,s.abstencion)}
    <p class="hist-note" style="margin-top:14px">Registro de votos, de la más antigua a la más reciente (cada cuadro es una votación):</p>
    <div class="vot-registro" role="img" aria-label="Registro de ${celdas.length} votaciones. El detalle está en la lista de votaciones.">${celdas.map(({v,c})=>{
      const sv=LETRA_VOTO[(c||'.').toUpperCase()], supl=c&&c!=='.'&&c!=='-'&&c===c.toLowerCase();
      return `<a href="#votacion=${v.votacion_id}" class="${sv?'v-'+sv:'v-aus'}${supl?' supl':''}" title="${esc(`${fmtFecha(v.fecha)} · ${v.proyecto?'Proyecto '+v.proyecto+' · ':''}${(v.descripcion||v.titulo).slice(0,90)} · ${sv?VOTO_LBL[sv]+(supl?' (su suplente)':''):'sin voto'}`)}"></a>`;
    }).join('')}</div>
    <div class="vot-leyenda">${['favor','contra','abstencion'].map(x=>`<span><i class="v-${x}"></i>${VOTO_ICO[x]} ${VOTO_LBL[x]}</span>`).join('')}<span><i class="v-favor supl"></i>Más tenue = votó su suplente</span><span><i class="v-aus"></i>Sin voto</span></div>
    <p class="hist-note" style="margin-top:14px">Votaciones más recientes:</p>
    <div class="ali-list">${m.recientes.filter(r=>seg==='todas'||r.tipo===seg).slice(0,8).map(r=>`<div class="vot-rec">
      <div><a href="#votacion=${r.votacion_id}">${esc(r.proyecto?`Proyecto ${r.proyecto} · ${r.debate||''} debate`:TIPO_LBL[r.tipo])}</a><small>${esc(fmtFecha(r.fecha))} · ${esc(r.titulo)}</small></div>
      <div>${chipVoto(r.voto)}${r.disidente?' <span class="badge etapa-obj" title="Votó distinto a la mayoría de su bancada">disidente</span>':''}</div></div>`).join('')||'<div class="gs-empty">Sin votaciones de este tipo.</div>'}</div>
    <p style="margin-top:14px"><a class="dl-btn" style="text-decoration:none" href="#votaciones=${esc(slug)}">Ver todas sus votaciones →</a></p>`;
}

// Diputados: coincidencia de voto entre dos diputados (proyectos de ley, votos propios)
function coincidenciaVoto(a,b){
  if(!VMAT||!VOT) return null;
  const fa=VMAT.diputados[a], fb=VMAT.diputados[b];
  if(!fa||!fb) return null;
  const tipo=Object.fromEntries(VOT.votaciones.map(v=>[v.votacion_id,v.tipo]));
  let n=0, iguales=0;
  VMAT.votaciones.forEach((id,i)=>{
    const x=fa[i], y=fb[i];
    if(tipo[id]!=='proyecto'||!'FCA'.includes(x)||!'FCA'.includes(y)) return;
    n++; if(x===y) iguales++;
  });
  return n?{n,iguales,pct:pct1(iguales,n)}:null;
}

// Partidos: cohesión de las bancadas en la pestaña Partidos
async function renderVotosPartidos(){
  await Promise.all([ensureVotaciones(), ensureVotosDip()]);
  const card=document.getElementById('partido-votos');
  if(!VMET||!card) return;
  card.hidden=false;
  chartCohesion('c-pp-cohesion','proyecto');
  document.querySelectorAll('#partido-cards .partido-card[data-partido]').forEach(el=>{
    const nombre=el.dataset.partido;
    const codes=Object.entries(VMET.partidos).filter(([,p])=>p.partido_sitio===nombre&&p.segmentos?.proyecto);
    if(!codes.length) return;
    const html=codes.map(([c,p])=>{ const s=p.segmentos.proyecto; return `<div class="p-dual-row" style="margin-top:2px">
        <div class="p-dual-lbl">Al votar${codes.length>1?' ('+esc(bancada(c))+')':''}</div>
        <div style="font-family:var(--fm);font-size:.72rem;color:var(--text);margin-left:auto" title="Votos alineados con la mayoría de la bancada en proyectos de ley">${fmtPct(s.cohesion)} cohesión · ${fmtNum(s.disidencias)} disidentes</div></div>`; }).join('');
    el.querySelector('.p-dual')?.insertAdjacentHTML('beforeend',html);
  });
}
