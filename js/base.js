// Observatorio Legislativo — Tema claro/oscuro, envoltorio de Chart.js (colores por tema, tabla de datos accesible), utilidades y estado global
// ── TEMA CLARO / OSCURO ───────────────────────────
// Los gráficos usan colores fijos en sus opciones; al cambiar de tema se traducen con este
// mapa [oscuro, claro]. Solo se tocan las opciones (y el borde de los datasets), no los
// colores de datos, para que partidos y etapas conserven su color.
const THEME_COLORS = [
  ['#0e1623','#ffffff'], ['#1a2940','#d8e0ea'], ['#7a8fb0','#5b6e88'], ['#94a3b8','#334155'],
  ['rgba(255,255,255,.03)','rgba(15,23,42,.07)'],
];
const ChartBase = Chart;

// Colores de etapa legislativa [modo oscuro, modo claro]. Las etapas en trámite usan una escala
// de un solo tono (validada como rampa ordinal en cada modo); en oscuro se invierte para que lo
// más avanzado sea lo más luminoso. El desenlace usa colores de estado: ley = verde,
// negado = rojo, objetado = naranja, sin avance = grises.
const ETAPA_COLOR = {
  'Preliminar':                          ['#184f95','#86b6ef'],
  'Prohijado':                           ['#256abf','#5598e7'],
  'Enviado a subcomisión para analisis': ['#256abf','#5598e7'],
  'Primer Debate':                       ['#3987e5','#2a78d6'],
  'Segundo Debate':                      ['#6da7ec','#1c5cab'],
  'Tercer Debate':                       ['#9ec5f4','#104281'],
  'Enviado al Ejecutivo':                ['#a5b4fc','#4f46e5'],
  'Objetado por Ejecutivo':              ['#fdba74','#ea580c'],
  'Segundo Debate(Objetado)':            ['#fb923c','#c2410c'],
  'Tercer Debate(Objetado)':             ['#f97316','#9a3412'],
  'Ley':                                 ['#10b981','#059669'],
  'Negado':                              ['#ef4444','#dc2626'],
  'Archivado':                           ['#94a3b8','#64748b'],
  'Retirado por proponente':             ['#64748b','#94a3b8'],
  'Suspendido':                          ['#cbd5e1','#475569'],
};
const ETAPA_OTRA = ['#a1a1aa','#71717a'];
// Los gráficos se construyen con el color oscuro; themeChartConfig lo traduce al tema activo.
const etapaColor = (e, theme='dark') => (ETAPA_COLOR[e]||ETAPA_OTRA)[theme==='light'?1:0];
const ETAPA_PARES = [...Object.values(ETAPA_COLOR), ETAPA_OTRA];

function currentTheme(){
  return document.documentElement.getAttribute('data-theme')==='light' ? 'light' : 'dark';
}

function remapColors(obj, from, to, seen=new Set()){
  if(!obj || typeof obj!=='object' || seen.has(obj)) return;
  seen.add(obj);
  for(const k of Object.keys(obj)){
    const v=obj[k];
    if(typeof v==='string'){ const i=from.indexOf(v); if(i>=0) obj[k]=to[i]; }
    else if(v && typeof v==='object' && !Array.isArray(v)) remapColors(v, from, to, seen);
  }
}

// inicial = el gráfico se está creando: sus datos vienen en colores oscuros (canónicos).
function themeChartConfig(cfg, theme, inicial=false){
  const dark=THEME_COLORS.map(c=>c[0]), light=THEME_COLORS.map(c=>c[1]);
  const [from,to] = theme==='light' ? [dark,light] : [light,dark];
  remapColors(cfg.options, from, to);
  const [eFrom,eTo] = theme==='light' ? [ETAPA_PARES.map(p=>p[0]),ETAPA_PARES.map(p=>p[1])]
                                      : [ETAPA_PARES.map(p=>p[1]),ETAPA_PARES.map(p=>p[0])];
  const etapa=v=>{ const i=eFrom.indexOf(v); return i>=0?eTo[i]:v; };
  (cfg.data?.datasets||[]).forEach(ds=>{
    const i=from.indexOf(ds.borderColor);
    if(i>=0) ds.borderColor=to[i];
    // Colores de etapa en los datos (cada valor se traduce una sola vez)
    if(ds.$etapas && !(inicial && theme==='dark')){
      ds.backgroundColor = Array.isArray(ds.backgroundColor) ? ds.backgroundColor.map(etapa) : etapa(ds.backgroundColor);
    }
  });
}

function applyChartDefaults(theme){
  const light = theme==='light';
  ChartBase.defaults.color = light ? '#334155' : '#94a3b8';
  ChartBase.defaults.borderColor = light ? 'rgba(15,23,42,.08)' : 'rgba(255,255,255,.08)';
  ChartBase.defaults.plugins.tooltip.titleColor = light ? '#0f172a' : '#ffffff';
  ChartBase.defaults.plugins.tooltip.bodyColor = light ? '#334155' : '#ffffff';
}

// Todo gráfico nuevo nace con los colores del tema activo.
Chart = class extends ChartBase {
  constructor(item, cfg){
    if(cfg) themeChartConfig(cfg, currentTheme(), true);
    super(item, cfg);
    try{ agregarTablaDatos(this); }catch(e){ console.error('Tabla del gráfico:', e); }
  }
};

// Cada gráfico lleva una descripción para lectores de pantalla y, debajo, una tabla plegable con
// sus datos: así la información nunca depende solo de ver el gráfico.
function agregarTablaDatos(chart){
  const canvas=chart.canvas;
  if(!canvas || canvas.dataset.sinTabla!==undefined) return;
  const cont=canvas.closest('.ch, .hist-wrap')||canvas.parentElement;
  const sub=cont.previousElementSibling?.classList?.contains('chart-sub') ? cont.previousElementSibling.textContent : '';
  const titulo=(sub || cont.closest('.card')?.querySelector('.card-title')?.textContent || 'Gráfico').trim();
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',`${titulo}. Los datos están en la tabla "Ver datos del gráfico", debajo.`);
  const labels=chart.data.labels||[], ds=chart.data.datasets||[];
  const fmt=v=>v==null||Number.isNaN(v) ? '—' : Number.isInteger(v) ? fmtNum(v) : Number(v).toLocaleString('es-PA',{maximumFractionDigits:2});
  const cab=ds.length===1 ? [ds[0].label||'Valor'] : ds.map(d=>d.label||'');
  const filas=labels.map((l,i)=>`<tr><th scope="row">${esc(Array.isArray(l)?l.join(' '):l)}</th>${ds.map(d=>`<td>${fmt(d.data[i])}</td>`).join('')}</tr>`).join('');
  let det=cont.nextElementSibling;
  if(!det || !det.classList.contains('chart-tabla')){ det=document.createElement('details'); det.className='chart-tabla'; cont.after(det); }
  det.innerHTML=`<summary>Ver datos del gráfico</summary><div class="chart-tabla-scroll"><table>
    <caption class="sr-only">${esc(titulo)}</caption>
    <thead><tr><th scope="col">Categoría</th>${cab.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${filas}</tbody></table></div>`;
}

function setTheme(theme, persist=true){
  const prev=currentTheme();
  document.documentElement.setAttribute('data-theme', theme);
  if(persist){ try{ localStorage.setItem('theme', theme); }catch(e){} }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme==='light' ? '#f4f6fa' : '#080c14');
  const btn=document.getElementById('theme-toggle');
  if(btn) btn.setAttribute('aria-label', theme==='light' ? 'Cambiar a modo oscuro' : 'Cambiar a modo claro');
  applyChartDefaults(theme);
  if(prev!==theme){
    Object.values(ChartBase.instances).forEach(c=>{ themeChartConfig(c.config, theme); c.update('none'); });
    if(typeof D!=='undefined' && D && document.getElementById('funnel')?.childElementCount) renderFunnel();
  }
}

function toggleTheme(){ setTheme(currentTheme()==='light' ? 'dark' : 'light'); }

setTheme(currentTheme(), false);
// Si el usuario nunca eligió tema, seguir los cambios del sistema.
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', e=>{
  let saved=null; try{ saved=localStorage.getItem('theme'); }catch(_){}
  if(!saved) setTheme(e.matches ? 'light' : 'dark', false);
});

// ── UTILIDADES ────────────────────────────────────
// Todo texto que viene de las fuentes externas (títulos, nombres, URLs) se escapa antes de
// insertarlo como HTML, para que un carácter raro no rompa la página ni ejecute código.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
// Un solo formato numérico para todo el sitio (1,234,567), sin depender del idioma del navegador.
const fmtNum = v => Math.round(Number(v) || 0).toLocaleString('es-PA');
const slugify = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const depSlug = d => d.slug || slugify(d.nombre);

const MOBILE_BP = 640;
const isMobile = () => window.innerWidth <= MOBILE_BP;
// Un gráfico puede definir chart.$responsive(mobile) para ajustar leyenda o fuentes; se vuelve
// a aplicar cuando la pantalla cruza el breakpoint (p. ej. al girar el teléfono).
let _wasMobile = isMobile(), _resizeT = null;
window.addEventListener('resize', ()=>{
  clearTimeout(_resizeT);
  _resizeT = setTimeout(()=>{
    const m = isMobile();
    if(m === _wasMobile) return;
    _wasMobile = m;
    Object.values(ChartBase.instances).forEach(c=>{ c.$responsive?.(m); c.update('none'); });
  }, 150);
});

let D = null, DATOS_RAW = [], filtered = [], sortedDeps = [], monitorSorted = [], sortCol = 'proyectos', sortDir = 'desc', page = 1, metrica = 'proyectos';
let viewMode = 'table', selectedParties = new Set(), selectedProvinces = new Set();
let monitorSortCol = 'planilla_valor', monitorSortDir = 'desc', monitorInited = false;
const PAGE = 15;
let tabInited = { general: false, diputados: false, monitoreo: false, partidos: false, proponentes: false, costos: false };
let gsTimeout = null;
let tableInited = false;
let mapEtapaFilter = 'all', mapYearFilter = 'all', mapTipoFilter = 'diputados';

const MAP_ETAPA_LABELS = {
  'Ley':'Leyes aprobadas','debate':'En debate (1°/2°/3er)','analisis':'En análisis','sinAvance':'Sin avance'
};

function getMapData(){
  if(mapTipoFilter!=='diputados') return {};
  const pf=D&&D.por_provincia_filtros, pp=D&&D.por_provincia||{};
  if(pf){
    const yKey=mapYearFilter==='all'?'all':mapYearFilter;
    const eKey=mapEtapaFilter==='all'?'all':mapEtapaFilter;
    const result={};
    Object.entries(pf).forEach(([prov,yrs])=>{
      const cnt=(yrs[yKey]||{})[eKey]||0;
      const leyes=(mapEtapaFilter==='all'||mapEtapaFilter==='Ley')?(yrs[yKey]||{})['Ley']||0:0;
      result[prov]={proyectos:cnt,leyes:leyes,diputados:(pp[prov]||{}).diputados||0,participaciones:(pp[prov]||{}).participaciones};
    });
    Object.entries(pp).forEach(([prov,v])=>{if(!result[prov])result[prov]={proyectos:0,leyes:0,diputados:v.diputados||0};});
    return result;
  }
  return pp;
}

function getMapTotals(){
  const otros=D&&D.otros_proponentes||[];
  if(mapTipoFilter==='ejecutivo') return otros.filter(o=>o.tipo==='ejecutivo').reduce((s,o)=>s+(o.proyectos||0),0);
  if(mapTipoFilter==='ciudadana') return otros.filter(o=>o.tipo==='ciudadano').reduce((s,o)=>s+(o.proyectos||0),0);
  return 0;
}

function setMapFilter(type,val){
  if(type==='etapa') mapEtapaFilter=val;
  else if(type==='year') mapYearFilter=val;
  else if(type==='tipo') mapTipoFilter=val;
  // Actualizar chips activos del tipo modificado
  document.querySelectorAll(`.map-chip[data-mftype="${type}"]`).forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.mfval===val);
  });
  // Mostrar aviso para ejecutivo/ciudadana
  const noProv=document.getElementById('map-no-prov');
  if(noProv){
    const isNonProv=mapTipoFilter!=='diputados';
    noProv.classList.toggle('show',isNonProv);
    if(isNonProv){
      const total=getMapTotals();
      const label=mapTipoFilter==='ejecutivo'?'Ejecutivo':'Ciudadana';
      noProv.innerHTML=`Los proyectos de <strong>${label}</strong> no tienen circunscripción provincial — se presentan a nivel nacional. <span style="color:var(--acc2);font-family:var(--fm)">Total: ${total} proyecto${total!==1?'s':''}</span>`;
    }
  }
  renderMap();
}

