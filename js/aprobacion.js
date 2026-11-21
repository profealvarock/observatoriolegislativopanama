// Observatorio Legislativo — Pestaña ⭐ Aprobación: presidente, gabinete e instituciones (data/aprobacion.json)
let aprInited=false, aprChartInst=null, aprFuenteInst=null;

const normInst = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const mesCorto = p => { const [y,m]=String(p).split('-'); return `${MES_CORTO[+m-1]} ${y.slice(2)}`; };
const signo = v => v==null ? '' : (v>0?'▲ +':v<0?'▼ −':'= ')+fmtDec(Math.abs(v),1);

// Medición más reciente de cada fuente de confianza institucional
function aprUltimaInst(D, fuente){
  return (D.series?.instituciones||[]).filter(r=>r.fuente===fuente).sort((a,b)=>String(a.periodo).localeCompare(b.periodo)).pop()||null;
}

async function initAprobacion(){
  if(aprInited) return;
  aprInited=true;
  const root=document.getElementById('apr-root');
  let D;
  try{ D=await cargarIndicador('aprobacion'); }
  catch(e){ aprInited=false; return errorIndicador(root,e); }
  const F=D.fuentes||{};
  const fh=D.fecha_corte;
  const m=id=>metricaPorId(D,id);

  // KPI derivado: la institución más creíble sale de la última medición de Vea Panamá
  const vea=aprUltimaInst(D,'vea');
  let creible=null;
  if(vea){
    const [nombre,pct]=Object.entries(vea.valores||{}).sort((a,b)=>b[1]-a[1])[0]||[];
    creible={etiqueta:'Institución más creíble', valor:nombre||null, fecha_corte:vea.fecha_corte, periodo:vea.periodo,
      fuente:F.vea?.nombre, url:vea.url||F.vea?.url, calidad:F.vea?.calidad, $pct:pct, $ninguna:vea.ninguna};
  }
  const varTxt=x=>x?.variacion!=null?`${signo(x.variacion)} pts vs. medición anterior`:'';
  const gob=m('confianza_gobierno_baja');

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Aprobación y confianza institucional',
      desc:'Presidente, gabinete e instituciones públicas según las encuestas publicadas. Cada cifra indica su encuestadora, su fecha de campo y el enlace a la fuente.'})}
    <div class="ind-kpis">
      ${kpiIndicador(m('gestion_buena'),{fechaHeader:fh,color:'var(--acc3)',sub:esc(varTxt(m('gestion_buena')))})}
      ${kpiIndicador(m('gestion_mala'),{fechaHeader:fh,color:'var(--acc4)',sub:esc(varTxt(m('gestion_mala')))})}
      ${kpiIndicador(m('confianza_presidente'),{fechaHeader:fh,color:'var(--acc5)',sub:esc(m('confianza_presidente')?.notas||'')})}
      ${kpiIndicador(m('mal_camino'),{fechaHeader:fh,color:'var(--acc4)',sub:gob?`Confianza baja o muy baja en el Gobierno: <b>${esc(fmtValor(gob))}</b>`:''})}
      ${creible?kpiIndicador(creible,{fechaHeader:fh,color:'var(--acc2)',clase:'ind-kpi-texto',
          sub:creible.$pct!=null?`${esc(fmtDec(creible.$pct,1))}% la elige${creible.$ninguna!=null?` · "ninguna": ${esc(fmtDec(creible.$ninguna,0))}%`:''}`:''}):''}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title" style="--ct:var(--acc4)">Evaluación de la gestión presidencial</div>
        <p class="chart-sub">% de encuestados · ${fuenteHTML(F.vea?.nombre, F.vea?.url)}</p>
        <div class="ch tall"><canvas id="c-apr-gestion"></canvas></div>
        <p class="ind-nota" id="apr-gestion-nota"></p>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--acc5)">Confianza en instituciones</div>
        <div class="ind-seg" role="group" aria-label="Fuente de la medición">
          <button type="button" class="map-chip" data-apr-inst="latinobarometro" aria-pressed="false">Latinobarómetro</button>
          <button type="button" class="map-chip" data-apr-inst="vea" aria-pressed="false">Vea Panamá</button>
        </div>
        <p class="chart-sub" id="apr-inst-hint"></p>
        <div class="ch tall"><canvas id="c-apr-inst"></canvas></div>
        <p class="ind-nota" id="apr-inst-nota"></p>
        <div class="ind-sinmed">
          <p class="chart-sub">Sin medición pública (sale de la lista cuando aparece un dato con fuente):</p>
          <div class="ind-pills" id="apr-sinmed"></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)" id="apr-gabinete"></div>
    <div class="card ind-fuentes" style="margin-bottom:var(--gap)">
      <div class="card-title">Fuentes</div>
      <ul>${Object.values(F).map(f=>`<li>${fuenteHTML(f.nombre,f.url)}${f.detalle?` — ${esc(f.detalle)}`:''}${pillCalidad(f.calidad)}${(f.urls||[]).slice(1).map((u,i)=>` · <a href="${safeUrl(u)}" target="_blank" rel="noopener">nota ${i+2}</a>`).join('')}</li>`).join('')}</ul>
    </div>
    ${descargasIndicadorHTML('aprobacion',[['gestion','Serie de gestión presidencial'],['instituciones','Confianza en instituciones'],['gabinete','Gabinete']])}`;

  aprGraficoGestion(D);
  root.querySelectorAll('[data-apr-inst]').forEach(b=>b.addEventListener('click',()=>aprGraficoInst(D,b.dataset.aprInst)));
  aprGraficoInst(D, aprUltimaInst(D,'latinobarometro') ? 'latinobarometro' : 'vea');
  aprSinMedicion(D);
  aprGabinete(D);
}

function aprGraficoGestion(D){
  const serie=D.series?.gestion||[];
  const buena=serie.map(r=>r.buena??null), mala=serie.map(r=>r.mala??null);
  const ch=new Chart(document.getElementById('c-apr-gestion'),{
    type:'line',
    data:{labels:serie.map(r=>mesCorto(r.periodo)),datasets:[
      {label:'Mala o muy mala',data:mala,borderColor:'#ef4444',backgroundColor:'#ef4444',pointRadius:4,pointHoverRadius:6,spanGaps:false,tension:.2},
      {label:'Buena o muy buena',data:buena,borderColor:'#10b981',backgroundColor:'#10b981',pointRadius:4,pointHoverRadius:6,spanGaps:false,tension:.2},
    ]},
    options:opcionesBase({min:0,max:100,sufijo:'%'}),
  });
  const ult=serie[serie.length-1];
  if(ult) ariaGrafico(ch,`Evaluación de la gestión presidencial. Última medición, ${fmtPeriodo(ult.periodo)}: ${ult.mala??'s/d'}% mala o muy mala y ${ult.buena??'s/d'}% buena o muy buena.`);
  const vacios=serie.filter(r=>r.buena==null||r.mala==null).map(r=>`${mesCorto(r.periodo)} (${r.buena==null?'buena':''}${r.buena==null&&r.mala==null?' y ':''}${r.mala==null?'mala':''})`);
  document.getElementById('apr-gestion-nota').textContent = vacios.length
    ? `Sin dato publicado en ${vacios.join(', ')}: el punto queda vacío y la línea se corta, no se interpola.` : '';
}

function aprGraficoInst(D, fuente){
  const med=aprUltimaInst(D,fuente), F=D.fuentes?.[fuente]||{};
  aprFuenteInst=fuente;
  document.querySelectorAll('[data-apr-inst]').forEach(b=>{
    const on=b.dataset.aprInst===fuente;
    b.classList.toggle('active',on); b.setAttribute('aria-pressed',on?'true':'false');
    b.disabled=!aprUltimaInst(D,b.dataset.aprInst);
  });
  const hint=document.getElementById('apr-inst-hint'), nota=document.getElementById('apr-inst-nota');
  if(aprChartInst){ aprChartInst.destroy(); aprChartInst=null; }
  if(!med){ hint.textContent='s/d'; nota.textContent=''; return; }
  hint.innerHTML=`${esc(med.medida||'')} · ${fuenteHTML(F.nombre, med.url||F.url)} · campo ${esc(fmtPeriodo(med.periodo))}`;
  const filas=Object.entries(med.valores||{}).sort((a,b)=>b[1]-a[1]);
  const color=fuente==='vea'?'#f59e0b':'#a78bfa';
  aprChartInst=new Chart(document.getElementById('c-apr-inst'),{
    type:'bar',
    data:{labels:filas.map(f=>f[0]),datasets:[{label:fuente==='vea'?'La más creíble (%)':'Confía mucho o algo (%)',data:filas.map(f=>f[1]),backgroundColor:color,borderRadius:4,borderSkipped:false}]},
    options:{...opcionesBase({sufijo:'%'}),indexAxis:'y',plugins:{...opcionesBase({sufijo:'%'}).plugins,legend:{display:false}},
      scales:{x:{...opcionesBase().scales.x,min:0},y:{...opcionesBase().scales.y,ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10},autoSkip:false}}}},
  });
  const [n1,v1]=filas[0]||[];
  ariaGrafico(aprChartInst,`Confianza en instituciones según ${F.nombre||fuente}, ${fmtPeriodo(med.periodo)}. Primera: ${n1} con ${v1}%.`);
  nota.textContent = med.ninguna!=null ? `${fmtDec(med.ninguna,0)}% respondió que ninguna institución es creíble.` : '';
}

function aprSinMedicion(D){
  const medidas=new Set();
  (D.series?.instituciones||[]).forEach(r=>Object.keys(r.valores||{}).forEach(k=>medidas.add(normInst(k))));
  const tieneDato=item=>[item.nombre,...(item.alias||[])].map(normInst).some(a=>[...medidas].some(k=>k===a||(` ${k} `).includes(` ${a} `)));
  const pendientes=(D.sin_medicion||[]).filter(i=>!tieneDato(i));
  document.getElementById('apr-sinmed').innerHTML = pendientes.length
    ? pendientes.map(i=>`<span class="ind-pill">${esc(i.nombre)}</span>`).join('')
    : '<span class="ind-pill">Todas tienen al menos una medición con fuente</span>';
}

function aprGabinete(D){
  const med=(D.series?.gabinete||[]).slice().sort((a,b)=>String(a.periodo).localeCompare(b.periodo)).pop();
  const el=document.getElementById('apr-gabinete');
  if(!med){ el.innerHTML='<div class="card-title">Gabinete</div><p class="chart-sub">s/d</p>'; return; }
  const F=D.fuentes?.[med.fuente]||{};
  const lista=(med.ministros||[]).slice().sort((a,b)=>(b.valor??-1)-(a.valor??-1));
  const max=Math.max(...lista.map(x=>x.valor||0),1);
  const conDato=lista.filter(x=>x.valor!=null);
  const lectura=conDato.length?`Aprobación por ministro, ${fmtPeriodo(med.periodo)}: la más alta es ${conDato[0].nombre} (${conDato[0].cartera}) con ${conDato[0].valor}% y la más baja, ${conDato[conDato.length-1].nombre} (${conDato[conDato.length-1].cartera}) con ${conDato[conDato.length-1].valor}%.`:'';
  el.innerHTML=`
    <div class="ind-card-head">
      <div class="card-title" style="--ct:var(--acc2);margin-bottom:6px">Gabinete: aprobación por ministro</div>
      ${pillCalidad(med.calidad||F.calidad)}
    </div>
    <p class="chart-sub">% de aprobación · ${fuenteHTML(F.nombre,F.url)} · ${F.detalle?esc(F.detalle):`campo ${esc(fmtPeriodo(med.periodo))}`}</p>
    <ol class="ind-bars" aria-label="${esc(lectura)}">
      ${lista.map(x=>`<li class="ind-bar">
        <span class="ind-bar-lbl"><b>${esc(x.nombre)}</b> <span>${esc(x.cartera)}</span></span>
        <span class="ind-bar-track" aria-hidden="true"><span class="ind-bar-fill" style="width:${x.valor==null?0:(x.valor/max*100).toFixed(1)}%"></span></span>
        <span class="ind-bar-val${x.valor==null?' ind-sd':''}">${x.valor==null?'s/d':fmtDec(x.valor,1)+'%'}</span>
      </li>`).join('')}
    </ol>
    ${F.notas?`<p class="ind-nota ind-nota-warn">⚠ ${esc(F.notas)} Úsese como referencia, no como medición rigurosa.</p>`:''}`;
}

IND_APLANAR['aprobacion.instituciones']=D=>(D.series?.instituciones||[]).flatMap(r=>[
  ...Object.entries(r.valores||{}).map(([inst,v])=>({periodo:r.periodo,fuente:D.fuentes?.[r.fuente]?.nombre||r.fuente,medida:r.medida,institucion:inst,valor:v,url:r.url||D.fuentes?.[r.fuente]?.url})),
  ...(r.ninguna!=null?[{periodo:r.periodo,fuente:D.fuentes?.[r.fuente]?.nombre||r.fuente,medida:r.medida,institucion:'Ninguna',valor:r.ninguna,url:r.url||D.fuentes?.[r.fuente]?.url}]:[]),
]);
IND_APLANAR['aprobacion.gabinete']=D=>(D.series?.gabinete||[]).flatMap(r=>(r.ministros||[]).map(x=>({periodo:r.periodo,fuente:D.fuentes?.[r.fuente]?.nombre||r.fuente,calidad:r.calidad,ministro:x.nombre,cartera:x.cartera,valor:x.valor,url:D.fuentes?.[r.fuente]?.url})));
IND_APLANAR['aprobacion.gestion']=D=>(D.series?.gestion||[]).map(r=>({...r,fuente:D.fuentes?.[r.fuente]?.nombre||r.fuente,url:r.url||D.fuentes?.[r.fuente]?.url}));
