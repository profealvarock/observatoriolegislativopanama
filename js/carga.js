// Observatorio Legislativo — Carga de resumen.json, aviso de datos desactualizados, metodología dinámica e indicadores principales
// ── LOAD ──────────────────────────────────────────
async function loadData(){
  let raw;
  try{
    const res=await fetch('resumen.json');
    if(!res.ok)throw new Error('HTTP '+res.status);
    raw=await res.json();
  }catch(e){
    console.error('Fetch error:',e);
    document.getElementById('kpi-totals').innerHTML=`<div class="loader" style="grid-column:1/-1">⚠️ Error cargando datos: ${esc(e.message)}</div>`;
    return;
  }

  D = raw.datos ? processRaw(raw) : raw;
  const ts = D.fecha_extraccion||'';
  document.getElementById('last-update').textContent = ts
    ? ts.replace(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/,'$3/$2/$1 $4:$5') : '—';
  renderAvisoDatos();

  // Botones de año del mapa según los años presentes en los datos
  const yearBox=document.getElementById('map-year-chips');
  Object.keys(Object.values(D.por_provincia_filtros||{})[0]||{}).filter(y=>y!=='all').sort().forEach(y=>{
    yearBox.insertAdjacentHTML('beforeend',
      `<button class="map-chip" data-mftype="year" data-mfval="${esc(y)}" onclick="setMapFilter('year',this.dataset.mfval)">${esc(y)}</button>`);
  });

  try{ renderKPI(); }catch(e){ console.error('KPI error:',e); }
  try{ renderGeneral(); tabInited.general=true; }catch(e){ console.error('General error:',e); }
  try{ initTable(); }catch(e){ console.error('Table error:',e); }
  try{ initComparar(); }catch(e){ console.error('Comparar error:',e); }
  routeFromHash();
}

// Aviso si los datos tienen más de 3 días o alguna fuente usó datos de respaldo
const NOMBRES_RESPALDO={proyectos:'proyectos (Asamblea)',diputados:'perfiles de diputados',metricas:'monitoreo de Espacio Cívico'};
// La extracción corre a diario: 2+ días sin datos nuevos ya indica que algo falló.
const DIAS_AVISO=2, DIAS_GRAVE=7;
function diasSinActualizar(){
  return Math.floor((Date.now()-getFechaCorte().getTime())/86400000);
}
function fmtFechaCorte(){
  return getFechaCorte().toLocaleDateString('es-PA',{day:'numeric',month:'long',year:'numeric'});
}
function renderAvisoDatos(){
  const el=document.getElementById('data-banner');
  const avisos=[];
  const dias=diasSinActualizar();
  if(dias>=DIAS_AVISO) avisos.push(`Los datos tienen <strong>${dias} días</strong> sin actualizarse (última extracción: ${esc(fmtFechaCorte())}). Las cifras pueden no reflejar cambios recientes.`);
  const resp=(D.respaldos||[]).map(r=>NOMBRES_RESPALDO[r]||r);
  if(resp.length) avisos.push(`En la última actualización no se pudo obtener información nueva de <strong>${esc(resp.join(', '))}</strong>; se muestran los últimos datos disponibles.`);
  el.hidden=!avisos.length;
  el.classList.toggle('grave', dias>=DIAS_GRAVE);
  el.innerHTML=avisos.length
    ? `<span class="data-banner-ico" aria-hidden="true">⚠️</span><div>${avisos.join('<br>')} <a href="#metodologia">Más información</a></div>`
    : '';
}

function renderMetodologia(){
  if(!D) return;
  const dias=diasSinActualizar(), resp=(D.respaldos||[]).map(r=>NOMBRES_RESPALDO[r]||r);
  const last=getLastClosedMonth(), meses=getTotalMonths();
  const mesesEs=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const sinMatch=D.proponentes_sin_match||[];
  document.getElementById('met-estado').innerHTML=[
    `<span class="met-chip${dias>=DIAS_AVISO?' warn':''}">Última extracción: <b>${esc(fmtFechaCorte())}</b></span>`,
    `<span class="met-chip">Proyectos: <b>${fmtNum(D.total_proyectos)}</b></span>`,
    `<span class="met-chip">Diputados: <b>${fmtNum(D.total_diputados)}</b></span>`,
    `<span class="met-chip${resp.length?' warn':''}">Fuentes: <b>${resp.length?'respaldo en '+esc(resp.join(', ')):'todas al día'}</b></span>`,
  ].join('');
  document.getElementById('met-formula').innerHTML=
    `Costo acumulado = planilla publicada + B/. ${fmtNum(SALARIO_FIJO)} × ${meses} meses<br>`+
    `<span style="font-weight:400;color:var(--muted)">julio 2024 – ${mesesEs[last.month-1]} ${last.year} (meses cerrados a la fecha de extracción)</span>`;
  const em=D.efectividad_meta;
  if(em){
    ['met-ief-k','met-ief-k2','met-ief-k3'].forEach(id=>{ document.getElementById(id).textContent=String(em.suavizado_leyes); });
    const sems=Object.keys(em.tasa_base.autor||{}).sort();
    const fmtSem=s=>{ const [y,h]=s.split('-'); return (h==='S1'?'ene–jun ':'jul–dic ')+y; };
    document.getElementById('met-ief-tasas').innerHTML=sems.length?`
      <p style="margin-top:10px"><strong>Tasa base de la Cámara</strong> (proyectos de ese semestre que ya son ley):</p>
      <table class="cmp-tbl" style="margin-top:6px"><thead><tr><th>Semestre</th><th>Como autor</th><th>Como co-patrocinador</th></tr></thead>
      <tbody>${sems.map(s=>`<tr><td>${esc(fmtSem(s))}</td><td>${em.tasa_base.autor[s]}%</td><td>${em.tasa_base.copat?.[s]??'—'}%</td></tr>`).join('')}</tbody></table>`:'';
  }
  const lim=document.getElementById('met-limites');
  lim.querySelectorAll('[data-dinamico]').forEach(li=>li.remove());
  if(sinMatch.length){
    const total=sinMatch.reduce((s,x)=>s+x.firmas,0);
    lim.insertAdjacentHTML('afterbegin',`<li data-dinamico><strong>${total} firma${total===1?'':'s'} de diputados no se asignaron</strong> porque el nombre no coincide con certeza con ningún diputado o suplente publicado: ${sinMatch.map(x=>esc(x.nombre.replace(/^H\.D\.?S?\s+/i,''))).join(', ')}.</li>`);
  }
  ensureHist().then(H=>{
    if(!H) return;
    const iPl=H.campos.indexOf('planilla');
    const conMet=H.snapshots.filter(s=>Object.values(s.diputados||{}).some(v=>v[iPl]!=null));
    if(conMet.length) document.getElementById('met-hist').innerHTML=
      `Cada día se guarda una foto de las métricas de cada diputado en <code>historico.json</code>. Hay <strong>${conMet.length} mediciones</strong> desde el ${esc(fmtFecha(conMet[0].fecha))}; se usan para las tendencias de Monitoreo y la pestaña "Evolución" de cada ficha. Si un día Espacio Cívico no responde, esa foto queda sin métricas para no repetir datos viejos como nuevos.`;
  });
}

function processRaw(raw){
  const datos=raw.datos, prod={}, meses={}, etapas={};
  const limpiar=n=>n.replace(/^H\.D\.?S?\s+/i,'').trim();
  datos.forEach(r=>{
    const parts=r.fecha_presentacion.split('-');
    if(parts.length===3){const k=`${parts[2]}-${parts[1]}`;meses[k]=(meses[k]||0)+1}
    etapas[r.etapa]=(etapas[r.etapa]||0)+1;
    const props=r.proponente.split(',').map(p=>p.trim()).filter(Boolean);
    props.forEach((p,i)=>{
      const n=limpiar(p);if(!n)return;
      if(!prod[n])prod[n]={nombre:n,proyectos:0,co_patrocinios:0,leyes:0,etapas:{},foto:'',partido:'',provincia:'',circuito:'',perfil:''};
      if(i===0){prod[n].proyectos++;if(r.etapa==='Ley')prod[n].leyes++;}
      else prod[n].co_patrocinios++;
      prod[n].etapas[r.etapa]=(prod[n].etapas[r.etapa]||0)+1;
    });
  });
  return{total_proyectos:datos.length,total_leyes:datos.filter(r=>r.etapa==='Ley').length,
    total_diputados:Object.keys(prod).length,fecha_extraccion:raw.fecha_extraccion,
    etapas,timeline:Object.fromEntries(Object.entries(meses).sort()),
    diputados:Object.values(prod).sort((a,b)=>b.proyectos-a.proyectos),
    otros_proponentes:[],por_partido:{},por_provincia:{}};
}

// ── KPI ───────────────────────────────────────────
function renderKPI(){
  const total = D.total_proyectos;
  const tasa = ((D.total_leyes/total)*100).toFixed(1);

  // Fila superior: totales globales (no son subconjuntos entre sí)
  const totals=[
    {l:'Total proyectos',v:total,s:'Desde jul 2024',c:'var(--acc)'},
    {l:'Diputados activos',v:D.total_diputados,s:'Asamblea Nacional',c:'var(--acc5)'},
  ];
  document.getElementById('kpi-totals').innerHTML=totals.map((c,i)=>`
    <div class="kpi fade-in" style="--kc:${c.c};animation-delay:${i*.08}s">
      <div class="kpi-label">${c.l}</div>
      <div class="kpi-value" id="kt${i}">0</div>
      <div class="kpi-sub">${c.s}</div>
    </div>`).join('');
  totals.forEach((c,i)=>countUp(document.getElementById(`kt${i}`),c.v,i*80));

  // Partición exhaustiva: 5 grupos que suman exactamente total
  const ETAPAS_CONOCIDAS=['Preliminar','Prohijado','Enviado a subcomisión para analisis','Primer Debate','Segundo Debate','Tercer Debate','Enviado al Ejecutivo','Objetado por Ejecutivo','Segundo Debate(Objetado)','Tercer Debate(Objetado)','Ley','Archivado','Negado','Retirado por proponente','Suspendido'];
  const enAnalisis=(D.etapas['Preliminar']||0)+(D.etapas['Prohijado']||0)+(D.etapas['Enviado a subcomisión para analisis']||0);
  const enDebate=(D.etapas['Primer Debate']||0)+(D.etapas['Segundo Debate']||0)+(D.etapas['Tercer Debate']||0);
  const anteEjec=(D.etapas['Enviado al Ejecutivo']||0)+(D.etapas['Objetado por Ejecutivo']||0)+(D.etapas['Segundo Debate(Objetado)']||0)+(D.etapas['Tercer Debate(Objetado)']||0);
  const sinAvance=(D.etapas['Archivado']||0)+(D.etapas['Negado']||0)+(D.etapas['Retirado por proponente']||0)+(D.etapas['Suspendido']||0);
  const otrosV=Object.entries(D.etapas||{}).filter(([k])=>!ETAPAS_CONOCIDAS.includes(k)).reduce((s,[,v])=>s+(v||0),0);
  const sumaGrupos=enAnalisis+enDebate+anteEjec+D.total_leyes+sinAvance+otrosV;

  const hdr=document.getElementById('kpi-breakdown-hdr');
  const sumEl=document.getElementById('kpi-breakdown-sum');
  if(hdr){hdr.style.display='flex';}
  if(sumEl){sumEl.textContent=`${sumaGrupos} de ${total} proyectos`;}

  const cards=[
    {l:'En análisis',v:enAnalisis,s:'Preliminar · subcomisión',c:'var(--st-analisis)'},
    {l:'En debate',v:enDebate,s:'1°, 2° y 3er debate',c:'var(--st-debate)'},
    {l:'Ante el Ejecutivo',v:anteEjec,s:'Enviado · objetado',c:'var(--st-ejec)'},
    {l:'Leyes aprobadas',v:D.total_leyes,s:`${tasa}% tasa de aprobación`,c:'var(--st-ley)'},
    {l:'Sin avance',v:sinAvance,s:'Arch. · negados · retirados',c:'var(--st-sin)'},
    ...(otrosV>0?[{l:'Otros estados',v:otrosV,s:'Etapas no clasificadas',c:'var(--muted)'}]:[]),
  ];
  document.getElementById('kpi-grid').innerHTML=cards.map((c,i)=>{
    const pct=total>0?(c.v/total*100).toFixed(1):0;
    return`<div class="kpi fade-in" style="--kc:${c.c};animation-delay:${i*.08}s">
      <div class="kpi-label">${c.l}</div>
      <div class="kpi-value" id="kv${i}">0</div>
      <div class="kpi-sub">${c.s}</div>
      <div class="kpi-pct">
        <div class="kpi-pct-track"><div class="kpi-pct-fill" style="width:${pct}%"></div></div>
        <div class="kpi-pct-lbl">${pct}%</div>
      </div>
    </div>`;
  }).join('');
  cards.forEach((c,i)=>countUp(document.getElementById(`kv${i}`),c.v,i*80));
}

