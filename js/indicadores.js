// Observatorio Ciudadano — Piezas comunes de Inicio, Aprobación, Sismo, Costo de vida y Minería:
// carga de data/*.json, indicador de frescura, tarjetas KPI con fuente y fecha, avisos y descargas.
// Ninguna cifra vive en el código: todo sale de los JSON que actualiza scripts/actualizar_indicadores.py.

const IND_RUTAS = { aprobacion:'data/aprobacion.json', sismo:'data/sismo.json', costo_vida:'data/costo_vida.json', mineria:'data/mineria.json' };
const IND_CACHE = {};

async function cargarIndicador(p){
  if(IND_CACHE[p]) return IND_CACHE[p];
  const r = await fetch(IND_RUTAS[p]);
  if(!r.ok) throw new Error('HTTP '+r.status+' al leer '+IND_RUTAS[p]);
  return (IND_CACHE[p] = await r.json());
}

// ── FRESCURA ──────────────────────────────────────
// Días entre la fecha de corte y hoy, contados en fechas de Panamá (sin horas), para que el
// color no cambie según la zona horaria de quien visita.
function hoyPanama(ahora=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Panama',year:'numeric',month:'2-digit',day:'2-digit'}).format(ahora);
}
function indDiasEntre(desde, hasta){
  const a=Date.UTC(+desde.slice(0,4), +desde.slice(5,7)-1, +desde.slice(8,10));
  const b=Date.UTC(+hasta.slice(0,4), +hasta.slice(5,7)-1, +hasta.slice(8,10));
  return Math.round((b-a)/864e5);
}
// ≤7 días: verde · 8–30: ámbar · >30: rojo. Sin fecha: "sd".
function frescura(fechaCorte, hoy=hoyPanama()){
  if(!fechaCorte || !/^\d{4}-\d{2}-\d{2}/.test(fechaCorte)) return { nivel:'sd', dias:null };
  const dias = indDiasEntre(String(fechaCorte).slice(0,10), hoy);
  return { nivel: dias<=7 ? 'verde' : dias<=30 ? 'ambar' : 'rojo', dias };
}

// ── FORMATOS ──────────────────────────────────────
const MES_CORTO = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
function fmtDia(f, conAnio=true){
  if(!f) return 's/d';
  const [y,m,d] = String(f).slice(0,10).split('-');
  if(!m) return y;                                   // solo el año: '2026'
  if(!d) return `${MES_CORTO[+m-1]} ${y}`;
  return `${+d} ${MES_CORTO[+m-1]}${conAnio?' '+y:''}`;
}
// '2026-11-13/2026-11-27' → '13 – 27 nov 2026' · '2026-06' → 'jun 2026'
function fmtPeriodo(p){
  if(!p) return 's/d';
  const [a,b] = String(p).split('/');
  if(!b) return fmtDia(a);
  const mismoAnio=a.slice(0,4)===b.slice(0,4), mismoMes=mismoAnio&&a.slice(5,7)===b.slice(5,7);
  if(mismoMes && a.length>7) return `${+a.slice(8,10)} – ${fmtDia(b)}`;
  return `${fmtDia(a, !mismoAnio)} – ${fmtDia(b)}`;
}
function fmtDec(v, dec=1){
  return Number(v).toLocaleString('es-PA',{minimumFractionDigits:dec,maximumFractionDigits:dec});
}
// Valor con su unidad. null/undefined → 's/d' (o 'pendiente' si la métrica lo dice).
function fmtValor(m, opts={}){
  if(m==null || m.valor==null || m.valor==='') return m && m.estado==='pendiente' ? 'pendiente' : 's/d';
  const v=m.valor, u=m.unidad||'';
  if(typeof v==='string') return v;
  if(u==='%') return fmtDec(v, opts.dec??1)+'%';
  if(u.startsWith('USD/')) return '$'+fmtDec(v, opts.dec??2);
  if(u==='USD millones') return '$'+(Number.isInteger(v)?fmtNum(v):fmtDec(v,1))+' M';
  if(u==='M') return 'M'+fmtDec(v,1);
  if(Number.isInteger(v)) return fmtNum(v)+(opts.conUnidad&&u?` ${u}`:'');
  return fmtDec(v, opts.dec??1)+(opts.conUnidad&&u?` ${u}`:'');
}

// ── PIEZAS DE INTERFAZ ────────────────────────────
function frescuraHTML(fechaCorte, {etiqueta='Corte'}={}){
  const f=frescura(fechaCorte);
  const txt = f.nivel==='sd' ? 's/d'
    : f.dias<=0 ? `${etiqueta} de hoy` : f.dias===1 ? `${etiqueta}: ayer` : `hace ${f.dias} días`;
  const titulo = f.nivel==='sd' ? 'Sin fecha de corte' : `Fecha de corte: ${fmtDia(fechaCorte)} (${f.nivel==='verde'?'al día':f.nivel==='ambar'?'de 8 a 30 días':'más de 30 días'})`;
  return `<span class="fresh fresh-${f.nivel}" title="${esc(titulo)}"><span class="fresh-dot" aria-hidden="true"></span><span class="sr-only">Frescura: </span>${esc(txt)}${f.nivel!=='sd'?` <span class="fresh-fecha">· ${esc(fmtDia(fechaCorte))}</span>`:''}</span>`;
}
function pillCalidad(c){
  if(c!=='baja') return '';
  return `<span class="pill-calidad" role="note">Calidad de fuente: baja</span>`;
}
function fuenteHTML(nombre, url){
  if(!nombre && !url) return '<span class="ind-sinfuente">fuente pendiente</span>';
  return url ? `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${esc(nombre||'Fuente')}</a>`
             : `${esc(nombre)} <span class="ind-sinfuente">(sin enlace)</span>`;
}

// Tarjeta KPI: valor, subtítulo, fuente y fecha. Muestra su propia frescura cuando su fecha difiere
// de la del encabezado de la pestaña.
function kpiIndicador(m, {fechaHeader, sub='', color='var(--acc)', valor, clase='', unidad=''}={}){
  if(!m) return '';
  const val = valor ?? fmtValor(m);
  const sinDato = val==='s/d' || val==='pendiente';
  const fecha = m.fecha_corte;
  const fresh = fecha && fecha!==fechaHeader ? frescuraHTML(fecha) : '';
  return `<div class="kpi ind-kpi ${clase}" style="--kc:${sinDato?'var(--muted)':color}">
    <div class="kpi-label">${esc(m.etiqueta)}</div>
    <div class="kpi-value ind-kpi-value${sinDato?' ind-sd':''}">${esc(val)}${unidad&&!sinDato?` <span class="ind-unidad">${esc(unidad)}</span>`:''}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
    <div class="ind-fuente">${fuenteHTML(m.fuente, m.url)} · ${fecha?esc(fmtPeriodo(m.periodo||fecha)):'s/d'}</div>
    ${fresh||pillCalidad(m.calidad)?`<div class="ind-badges">${fresh}${pillCalidad(m.calidad)}</div>`:''}
  </div>`;
}

// Encabezado de pestaña: título, descripción, cadencia, frescura, generado y avisos del job.
function encabezadoIndicador(D, {titulo, desc, cadencia}){
  const avisos = D.advertencias||[];
  const gen = D.generado ? new Date(D.generado).toLocaleString('es-PA',{timeZone:'America/Panama',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 's/d';
  return `<div class="ind-head">
    <div class="ind-head-txt">
      <h2>${esc(titulo)}</h2>
      <p>${desc}</p>
    </div>
    <div class="ind-head-meta">
      ${frescuraHTML(D.fecha_corte, {etiqueta:'Corte'})}
      <span class="ind-chip">${esc(cadencia||D.cadencia||'')}</span>
      <span class="ind-gen">Revisado: ${esc(gen)}</span>
    </div>
  </div>
  ${avisos.length?`<details class="ind-avisos"><summary>⚠ ${avisos.length} aviso${avisos.length===1?'':'s'} de la última actualización</summary>
    <ul>${avisos.map(a=>`<li><b>${esc(a.modulo)}</b> · ${esc(a.mensaje)}</li>`).join('')}</ul></details>`:''}`;
}

function metricaPorId(D, id){ return (D.metricas||[]).find(m=>m.id===id) || null; }

function errorIndicador(el, e){
  el.innerHTML=`<div class="loader">⚠️ No se pudieron cargar los datos: ${esc(e.message)}</div>`;
}

// Gráficos: el lector de pantalla recibe la lectura del dato principal, no solo el título.
function ariaGrafico(chart, texto){
  chart?.canvas?.setAttribute('aria-label', texto+' Los datos están en la tabla "Ver datos del gráfico", debajo.');
}
const prefiereMenosMovimiento = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Opciones comunes (colores oscuros canónicos: base.js los traduce al tema claro)
function opcionesBase({ejeY='', min, max, sufijo=''}={}){
  return {
    responsive:true, maintainAspectRatio:false,
    animation: prefiereMenosMovimiento() ? false : undefined,
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{color:'#94a3b8',font:{family:'DM Mono',size:10},boxWidth:10}},
      tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
        callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.raw==null?'s/d':Number(ctx.raw).toLocaleString('es-PA')}${sufijo}`}}},
    scales:{
      x:{grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},maxRotation:0,autoSkip:true}},
      y:{min,max,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10}},
        title:{display:!!ejeY,text:ejeY,color:'#7a8fb0',font:{family:'DM Mono',size:10}}},
    },
  };
}

// ── DESCARGAS ─────────────────────────────────────
// CSV de las métricas vigentes y de cada serie, y el JSON original.
function exportIndicadorMetricas(p){
  const D=IND_CACHE[p]; if(!D) return;
  downloadCSV(`${p}_indicadores`, [
    ['ID',m=>m.id], ['Indicador',m=>m.etiqueta], ['Valor',m=>m.valor==null?(m.estado||'s/d'):m.valor], ['Unidad',m=>m.unidad],
    ['Fecha de corte',m=>m.fecha_corte], ['Período',m=>m.periodo], ['Variación',m=>m.variacion],
    ['Fuente',m=>m.fuente], ['URL',m=>m.url], ['Calidad',m=>m.calidad], ['Notas',m=>m.notas],
  ], D.metricas||[], fechaIndicador(D));
}
// El nombre del archivo lleva la fecha de corte de la pestaña, no la de resumen.json
const fechaIndicador = D => String(D.fecha_corte||D.generado||hoyPanama()).slice(0,10);
// Series anidadas (p. ej. una medición con varias instituciones) se aplanan a una fila por dato.
const IND_APLANAR = {};
function exportIndicadorSerie(p, nombre){
  const D=IND_CACHE[p]; if(!D) return;
  const aplanar=IND_APLANAR[p+'.'+nombre];
  const filas=(aplanar ? aplanar(D) : (D.series?.[nombre]||[]));
  const claves=[...new Set(filas.flatMap(f=>Object.keys(f)))];
  downloadCSV(`${p}_${nombre}`, claves.map(k=>[k, f=>{ const v=f[k]; return v!=null&&typeof v==='object'?JSON.stringify(v):v; }]), filas, fechaIndicador(D));
}
function descargasIndicadorHTML(p, series){
  return `<div class="card ind-descargas">
    <div class="card-title" style="--ct:var(--acc3)">Datos abiertos</div>
    <div class="datos-abiertos">
      <button class="dl-btn" onclick="exportIndicadorMetricas('${p}')">⬇ Indicadores vigentes (CSV)</button>
      ${series.map(([n,et])=>`<button class="dl-btn" onclick="exportIndicadorSerie('${p}','${n}')">⬇ ${esc(et)} (CSV)</button>`).join('')}
      <a class="dl-btn" href="${IND_RUTAS[p]}" download style="text-decoration:none">⬇ JSON completo</a>
    </div>
    <p class="datos-abiertos-note">Cada fila trae su fuente, fecha de corte y enlace. Detalles en <a href="#metodologia">Metodología</a>.</p>
  </div>`;
}

if(typeof module!=='undefined' && module.exports) module.exports = { frescura, indDiasEntre, fmtPeriodo, hoyPanama };
