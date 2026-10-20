// Observatorio Legislativo — Carga diferida de datos.json y pestaña Costo Legislativo
// ── CARGA DIFERIDA DE DATOS.JSON ─────────────────
// datos.json (~500 KB) solo se descarga cuando alguien lo necesita: pestaña Costos,
// comparador o descargas CSV. Las llamadas simultáneas comparten la misma descarga.
let _datosRawPromise = null, COSTOS = null;
function ensureDatosRaw(){
  if(DATOS_RAW.length) return Promise.resolve(DATOS_RAW);
  if(!_datosRawPromise){
    _datosRawPromise = fetch('datos.json')
      .then(res=>{ if(!res.ok) throw new Error('HTTP '+res.status); return res.json(); })
      .then(json=>{ DATOS_RAW=json.datos||[]; return DATOS_RAW; })
      .catch(e=>{ _datosRawPromise=null; throw e; });
  }
  return _datosRawPromise;
}
async function ensureCostos(){
  await ensureDatosRaw();
  if(!COSTOS) COSTOS=calcCostos();
  return COSTOS;
}

async function loadDatosRawAndRender(){
  if(!DATOS_RAW.length){
    document.getElementById('costo-kpi-grid').innerHTML=
      '<div class="loader" style="grid-column:1/-1"><div class="spinner"></div> Cargando datos de proyectos…</div>';
    try{
      await ensureDatosRaw();
    }catch(e){
      document.getElementById('costo-kpi-grid').innerHTML=
        `<div class="loader" style="grid-column:1/-1">⚠️ Error cargando datos.json: ${esc(e.message)}</div>`;
      tabInited.costos=false;
      return;
    }
  }
  try{ renderCostos(); }catch(e){ console.error('Costos render:',e); }
}

// ── COSTOS ────────────────────────────────────────
const SALARIO_FIJO = 7000;
const PERIODO_INICIO = {year:2024, month:7};

// Fecha de corte = fecha de extracción de los datos (no la fecha de hoy), para que el
// costo no siga creciendo si el scraper deja de actualizar.
function getFechaCorte(){
  const m=((D&&D.fecha_extraccion)||'').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : new Date();
}

function getLastClosedMonth(){
  const now = getFechaCorte();
  const m = now.getMonth(); // 0-indexed; 0 = Jan
  return m === 0
    ? {year: now.getFullYear()-1, month:12}
    : {year: now.getFullYear(), month:m};
}

function getYearMonths(y){
  const last = getLastClosedMonth();
  const {year:sy, month:sm} = PERIODO_INICIO;
  if(y < sy || y > last.year) return 0;
  const from = (y===sy) ? sm : 1;
  const to   = (y===last.year) ? last.month : 12;
  return Math.max(0, to - from + 1);
}

function getTotalMonths(){
  const last = getLastClosedMonth();
  let tot = 0;
  for(let y=PERIODO_INICIO.year; y<=last.year; y++) tot += getYearMonths(y);
  return tot;
}

function calcCostos(){
  if(!D || !DATOS_RAW.length) return null;

  const last = getLastClosedMonth();
  const years = [];
  for(let y=PERIODO_INICIO.year; y<=last.year; y++) years.push(y);

  const dips = D.diputados||[];
  const fichaYear = {};
  DATOS_RAW.forEach(r=>{ fichaYear[r.ficha]=parseInt((r.fecha_presentacion||'').split('-')[2])||0; });

  // Participación por diputado: {nombre: {año: Set<ficha>}}. La relación nombre ↔ diputado
  // (incluidos suplentes, asignados a su principal) la calcula scraper.py en `participaciones`.
  const partMap = {};
  const firmantes = {};   // ficha → nº de diputados principales que participaron
  dips.forEach(d=>{
    partMap[d.nombre] = {};
    (d.participaciones||[]).forEach(f=>{
      const y=fichaYear[f];
      if(!years.includes(y)) return;
      (partMap[d.nombre][y] ||= new Set()).add(f);
      firmantes[f]=(firmantes[f]||0)+1;
    });
  });

  // Calcular costos por diputado y asignar a proyectos
  const projectCosts = {};
  const dipCosts = [];
  let totalCost = 0;

  // Gasto acumulado = saldo de planilla publicado por Espacio Cívico + salario fijo × meses cerrados.
  // Para repartirlo por año, la planilla se prorratea según los meses de cada año.
  const totalMeses = getTotalMonths();
  dips.forEach(d=>{
    const planilla = Number(d.planilla_valor)||0;
    const salarioAcumulado = SALARIO_FIJO * totalMeses;
    const byYear = {};
    let costoAcumulado = 0;

    years.forEach(y=>{
      const meses = getYearMonths(y);
      if(!meses) return;
      const fichas = partMap[d.nombre]?.[y] || new Set();
      const proyCount = fichas.size;
      const costoAnual = planilla * meses / totalMeses + SALARIO_FIJO * meses;
      const costoPorProy = proyCount>0 ? costoAnual/proyCount : 0;
      costoAcumulado += costoAnual;
      byYear[y] = {meses, proyectos:proyCount, costoAnual, costoPorProy};
      fichas.forEach(ficha=>{
        projectCosts[ficha]=(projectCosts[ficha]||0)+costoPorProy;
      });
    });

    totalCost += costoAcumulado;
    const totalProy = Object.values(byYear).reduce((s,v)=>s+v.proyectos,0);
    dipCosts.push({
      nombre:d.nombre, slug:depSlug(d), partido:d.partido, foto:d.foto,
      planilla, salarioAcumulado, costoAcumulado,
      totalMeses, totalProy,
      costoPorProy: totalProy>0 ? costoAcumulado/totalProy : 0,
      byYear,
    });
  });
  dipCosts.sort((a,b)=>b.costoAcumulado-a.costoAcumulado);

  // Proyectos con costo
  const proyectos = DATOS_RAW
    .filter(r=>projectCosts[r.ficha]>0)
    .map(r=>({
      ficha:r.ficha,
      titulo:(r.titulo||r.anteproyecto||r.proyecto||'—'),
      year:parseInt((r.fecha_presentacion||'').split('-')[2])||0,
      etapa:r.etapa,
      diputados:firmantes[r.ficha]||0,
      costo:projectCosts[r.ficha],
    }));
  proyectos.sort((a,b)=>b.costo-a.costo);

  // Totales por año
  const byYearTotals={};
  years.forEach(y=>{
    const proyYear=new Set(DATOS_RAW.filter(r=>parseInt((r.fecha_presentacion||'').split('-')[2])===y).map(r=>r.ficha)).size;
    byYearTotals[y]={
      meses:getYearMonths(y),
      costoTotal:dipCosts.reduce((s,d)=>s+(d.byYear[y]?.costoAnual||0),0),
      proyectos:proyYear,
    };
  });

  // Costos por etapa
  const etapaCosts={};
  proyectos.forEach(p=>{
    etapaCosts[p.etapa]=(etapaCosts[p.etapa]||0)+p.costo;
  });

  const avgCosto = proyectos.length>0 ? proyectos.reduce((s,p)=>s+p.costo,0)/proyectos.length : 0;

  return {dipCosts, proyectos, byYearTotals, etapaCosts, totalCost, avgCosto, years};
}

// ── VALIDACIÓN CON LA CONTRALORÍA (planillas_cgr.json, scraper_planillas.py) ──
// El costo usa la planilla de Espacio Cívico (cubre a los 71). Aquí se contrasta con lo que la
// Contraloría registra como pagado, que hoy solo cubre parte del periodo y de los tipos.
let _cgrPromise=null, CGR=null;
const ensureCGR=()=>_cgrPromise||(_cgrPromise=fetch('planillas_cgr.json').then(r=>r.ok?r.json():null).catch(()=>null));
const NOMBRE_TIPO_CGR=t=>(CGR?.tipos?.[t]||t);

function filasValidacionCGR(){
  const porSlug=Object.fromEntries((D.diputados||[]).map(d=>[depSlug(d),d]));
  return (CGR?.diputados||[]).filter(c=>c.slug&&porSlug[c.slug]).map(c=>{
    const d=porSlug[c.slug], ec=Number(d.planilla_valor);
    return {d, c, ec:Number.isFinite(ec)?ec:null, cgr:c.total, dif:Number.isFinite(ec)?c.total-ec:null};
  }).sort((a,b)=>Math.abs(b.dif??0)-Math.abs(a.dif??0));
}

async function renderValidacionCGR(){
  CGR=await ensureCGR();
  const res=document.getElementById('cgr-resumen'), tb=document.getElementById('cgr-tbody');
  if(!res) return;
  if(!CGR){ res.innerHTML='<p class="monitor-note">Todavía no hay datos de la Contraloría.</p>'; return; }
  const filas=filasValidacionCGR(), conAmbos=filas.filter(f=>f.ec!=null);
  const anios=[...new Set(CGR.diputados.flatMap(d=>Object.keys(d.por_anio||{})))].sort();
  const tipos=[...new Set(CGR.diputados.flatMap(d=>Object.keys(d.por_tipo||{})))];
  const totCGR=conAmbos.reduce((a,f)=>a+f.cgr,0), totEC=conAmbos.reduce((a,f)=>a+f.ec,0);
  const porSlug=Object.fromEntries((D.diputados||[]).map(d=>[depSlug(d),d]));
  const noPub=(CGR.no_publicados||[]).map(s=>porSlug[s]?.nombre).filter(Boolean);
  document.getElementById('cgr-col-periodo').textContent=`pagado ${anios.join('–')}`;
  res.innerHTML=`<p class="monitor-note" style="line-height:1.8">
    La Contraloría registra <b>B/. ${fmtNum(totCGR)}</b> pagados a la planilla de ${conAmbos.length} diputados
    (${tipos.map(t=>esc(NOMBRE_TIPO_CGR(t).toLowerCase())).join(', ')}, ${anios.join(', ')}); Espacio Cívico reporta <b>B/. ${fmtNum(totEC)}</b> acumulados para esos mismos diputados.
    <b>Las cifras no son comparables una a una</b>: la Contraloría publica sus datos con corte al <b>${esc(fmtFecha(CGR.corte))}</b> y desde abril de 2025 ya no indica en qué despacho trabaja cada funcionario, así que solo cubre parte del periodo; Espacio Cívico no publica la fuente ni el periodo exacto de su "planilla acumulada".
    El costo legislativo sigue usando Espacio Cívico porque cubre a los 71 diputados; esta tabla sirve para contrastar.
    ${noPub.length?`<br>La Contraloría no publica planilla para <b>${noPub.length}</b> diputados: ${esc(noPub.join(', '))}.`:''}
    <br><span style="font-size:.9em">Revisado por última vez el ${esc(fmtFecha(CGR.verificado))} · <a href="${esc(CGR.fuente)}" target="_blank" rel="noopener">consulta de la Contraloría</a></span></p>`;
  tb.innerHTML=filas.map(({d,c,ec,cgr,dif})=>`<tr>
    <td class="td-main"><div class="dep-name"><a href="#diputado=${esc(depSlug(d))}" style="color:inherit;text-decoration:none">${esc(d.nombre)}</a></div>
      <div class="dep-sub">${esc(c.nombre_cgr)}${c.coincidencia==='probable'?' · <span title="Nombre de casada en la Contraloría; única diputada con ese nombre de pila">coincidencia probable</span>':''}</div></td>
    <td class="money-sm" data-label="Espacio Cívico" style="text-align:right">${ec!=null?'B/. '+fmtNum(ec):'—'}</td>
    <td class="money-sm" data-label="Contraloría" style="text-align:right">B/. ${fmtNum(cgr)}</td>
    <td class="costo-col-sm" data-label="Personas" style="text-align:center;font-family:var(--fm)">${c.personas}</td>
    <td class="money-sm" data-label="Diferencia" style="text-align:right;color:${dif==null?'var(--muted)':dif>0?'var(--costo)':'var(--muted)'}">${dif==null?'—':(dif>0?'+':'−')+'B/. '+fmtNum(Math.abs(dif))}</td>
  </tr>`).join('');
}

function exportValidacionCGR(btn){
  withBtn(btn, async ()=>{
    CGR=await ensureCGR();
    if(!CGR) throw new Error('no hay datos de la Contraloría');
    downloadCSV('planilla_contraloria_vs_espacio_civico', [
      ['Diputado',f=>f.d.nombre], ['Nombre en la Contraloría',f=>f.c.nombre_cgr], ['Coincidencia',f=>f.c.coincidencia],
      ['Planilla Espacio Cívico (B/.)',f=>f.ec], ['Pagado según Contraloría (B/.)',f=>f.cgr], ['Diferencia (B/.)',f=>f.dif!=null?Math.round(f.dif*100)/100:''],
      ['Personas en planilla',f=>f.c.personas], ['Pagos',f=>f.c.pagos],
      ...Object.keys(CGR.tipos||{}).map(t=>[`Tipo ${t} ${CGR.tipos[t]} (B/.)`,f=>f.c.por_tipo?.[t]??'']),
      ['Corte de la Contraloría',()=>CGR.corte],
    ], filasValidacionCGR());
  });
}

function renderCostos(){
  const C = COSTOS || (COSTOS = calcCostos());
  if(!C){
    document.getElementById('costo-kpi-grid').innerHTML='<div class="loader" style="grid-column:1/-1">Sin datos disponibles. Asegúrate de que datos.json esté generado.</div>';
    return;
  }
  const {dipCosts, proyectos, byYearTotals, etapaCosts, totalCost, avgCosto, years} = C;

  const fmtUSD  = v=>'B/. '+fmtNum(v);
  const fmtUSDk = v=>'B/. '+Math.round(v/1000)+'K';
  const last = getLastClosedMonth();
  const meses_es=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const topDip = dipCosts[0];
  const topProy = proyectos[0];

  // KPI cards
  document.getElementById('costo-kpi-grid').innerHTML=[
    {l:'Costo legislativo total',v:fmtUSD(totalCost),s:`Jul 2024 — ${meses_es[last.month-1]} ${last.year}`,c:'var(--costo)'},
    {l:'Costo promedio por proyecto',v:fmtUSD(avgCosto),s:`${proyectos.length} proyectos con participación`,c:'var(--costo)'},
    {l:'Diputado mayor costo',v:topDip?.nombre||'—',s:topDip?fmtUSD(topDip.costoAcumulado):'',c:'var(--text)',txt:true},
    {l:'Proyecto mayor costo',v:topProy?(topProy.titulo.length>52?topProy.titulo.slice(0,50)+'…':topProy.titulo):'—',s:topProy?fmtUSD(topProy.costo):'',c:'var(--text)',txt:true},
  ].map((k,i)=>`
    <div class="kpi fade-in" style="--kc:${k.c};animation-delay:${i*.08}s">
      <div class="kpi-label">${k.l}</div>
      <div class="kpi-value" style="${k.txt?`font-size:1rem;line-height:1.3;color:${k.c}`:'font-family:var(--fm);color:var(--text);font-size:clamp(1.2rem,1.9vw,1.8rem);letter-spacing:-.03em;white-space:nowrap'}">${esc(k.v)}</div>
      <div class="kpi-sub" style="font-family:var(--fm)">${k.s}</div>
    </div>`).join('');

  // Tarjetas por año
  document.getElementById('costo-year-grid').innerHTML=years.map(y=>{
    const {meses,costoTotal,proyectos:proy}=byYearTotals[y]||{meses:0,costoTotal:0,proyectos:0};
    const prom=proy>0?costoTotal/proy:0;
    const label=y===2024?'Jul – Dic 2024':y===last.year?`Ene – ${meses_es[last.month-1]} ${y}`:`Ene – Dic ${y}`;
    return`<div class="costo-year-card">
      <div class="costo-year-title">${label} · ${meses} meses activos</div>
      <div class="costo-year-total">${fmtUSD(costoTotal)}</div>
      <div class="costo-year-stats">
        <div><div class="costo-year-stat-val">${meses}</div><div class="costo-year-stat-lbl">Meses</div></div>
        <div><div class="costo-year-stat-val">${proy}</div><div class="costo-year-stat-lbl">Proyectos</div></div>
        <div><div class="costo-year-stat-val money">${fmtUSDk(prom)}</div><div class="costo-year-stat-lbl">Prom / proy.</div></div>
      </div>
    </div>`;
  }).join('');

  // Tabla proyectos
  const maxCosto=proyectos[0]?.costo||1;
  document.getElementById('costo-proy-tbody').innerHTML=proyectos.slice(0,30).map((p,i)=>{
    const pct=Math.round(p.costo/maxCosto*100);
    const vsAvg=avgCosto>0?((p.costo/avgCosto-1)*100).toFixed(0):0;
    const vsCol=p.costo>=avgCosto?'var(--costo)':'var(--muted)';
    const dipCount=p.diputados;
    return`<tr>
      <td class="costo-rank td-hide-card">${i+1}</td>
      <td class="td-main" style="max-width:300px">
        <div style="font-size:.78rem;font-weight:600;line-height:1.4"><span class="costo-rank-inline" style="color:var(--muted)">${i+1}. </span>${esc(p.titulo)}</div>
        <div style="font-family:var(--fm);font-size:.62rem;color:var(--muted);margin-top:2px">Ficha ${esc(p.ficha)}</div>
      </td>
      <td class="costo-col-sm" data-label="Año" style="font-family:var(--fm);font-size:.72rem">${p.year}</td>
      <td data-label="Etapa"><span class="badge ${etapaClass(p.etapa||'')}" style="font-size:.6rem">${esc(p.etapa)}</span></td>
      <td class="costo-col-sm" data-label="Diputados" style="font-family:var(--fm);font-size:.75rem;text-align:center">${dipCount}</td>
      <td class="money" data-label="Costo estimado" style="font-size:.82rem;font-weight:700;text-align:right;white-space:nowrap">${fmtUSD(p.costo)}</td>
      <td class="costo-col-sm" data-label="Vs promedio">
        <div class="costo-bar-wrap"><div class="costo-bar-fill" style="width:${pct}%"></div></div>
        <div style="font-family:var(--fm);font-size:.6rem;color:${vsCol};margin-top:3px">${vsAvg>0?'+':''}${vsAvg}% vs prom.</div>
      </td>
    </tr>`;
  }).join('');

  // Tabla diputados
  const maxDipCosto=dipCosts[0]?.costoAcumulado||1;
  document.getElementById('costo-dip-tbody').innerHTML=dipCosts.map((d,i)=>{
    const pc='var(--muted)';  // partido en tinta neutra (sin color por partido)
    const fotoEl=d.foto
      ?`<img class="dep-avatar" loading="lazy" decoding="async" src="${safeUrl(d.foto)}" alt="${esc(d.nombre)}" onerror="this.style.display='none'">`
      :`<div class="dep-avatar"></div>`;
    const pct=Math.round(d.costoAcumulado/maxDipCosto*100);
    return`<tr>
      <td class="costo-rank td-hide-card">${i+1}</td>
      <td class="td-main"><div class="dep-cell">${fotoEl}<div>
        <div class="dep-name">${esc(d.nombre)}</div>
        <div class="dep-sub" style="color:${pc}">${esc(d.partido||'—')}</div>
      </div></div></td>
      <td class="money-sm" data-label="Planilla" style="text-align:right">${d.planilla>0?fmtUSD(d.planilla):'—'}</td>
      <td class="costo-col-sm td-hide-card" style="font-family:var(--fm);font-size:.72rem;text-align:right;color:var(--muted)">B/. ${fmtNum(SALARIO_FIJO)}</td>
      <td class="money" data-label="Salario acumulado" style="font-size:.78rem;font-weight:700;text-align:right;white-space:nowrap">${fmtUSD(d.salarioAcumulado)}</td>
      <td class="costo-col-sm" data-label="Meses" style="font-family:var(--fm);font-size:.75rem;text-align:center">${d.totalMeses}</td>
      <td data-label="Costo acumulado">
        <div class="money" style="font-size:.8rem;font-weight:700;white-space:nowrap">${fmtUSD(d.costoAcumulado)}</div>
        <div class="costo-bar-wrap" style="margin-top:4px"><div class="costo-bar-fill" style="width:${pct}%"></div></div>
      </td>
      <td class="costo-col-sm" data-label="Participaciones" style="font-family:var(--fm);font-size:.78rem;text-align:center">${d.totalProy}</td>
      <td class="money-sm" data-label="Costo / proyecto" style="text-align:right;white-space:nowrap">${d.totalProy>0?fmtUSD(d.costoPorProy):'—'}</td>
    </tr>`;
  }).join('');

  renderValidacionCGR();

  // Gráfico por etapa
  const etapaEntries=Object.entries(etapaCosts).sort((a,b)=>b[1]-a[1]);
  const ctx=document.getElementById('c-costo-etapa');
  if(ctx){
    new Chart(ctx,{
      type:'bar',
      data:{
        labels:etapaEntries.map(e=>e[0]),
        datasets:[{data:etapaEntries.map(e=>e[1]),
          backgroundColor:etapaEntries.map(e=>etapaColor(e[0])),$etapas:true,
          borderRadius:5,borderSkipped:false}],
      },
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},
          tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
            callbacks:{label:ctx=>` B/. ${fmtNum(ctx.raw)}`}}},
        scales:{
          x:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},maxRotation:35,
            callback:function(val){const l=this.getLabelForValue(val);return isMobile()&&l&&l.length>11?l.slice(0,10)+'…':l}}},
          y:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},
            callback:v=>'B/. '+Math.round(v/1000)+'K'}}}},
    });
  }
}

