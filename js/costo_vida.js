// Observatorio Legislativo — Pestaña 🛒 Costo de vida: combustible, canasta básica, luz, agua y gas (data/costo_vida.json)
let cvInited=false;
const CV_COMB = [
  { id:'gasolina_95_gal', k:'g95',    nombre:'Gasolina 95',        color:'#3b82f6' },
  { id:'gasolina_91_gal', k:'g91',    nombre:'Gasolina 91',        color:'#10b981' },
  { id:'diesel_gal',      k:'diesel', nombre:'Diésel bajo azufre', color:'#f59e0b' },
];
const SEMANAS_POR_MES = 52/12;

// ▼ en verde (baja), ▲ en rojo (sube): para el bolsillo, bajar es bueno
function cvVariacion(v, {pref='$', dec=2, sufijo=''}={}){
  if(v==null) return '<span class="cv-var">s/d</span>';
  if(v===0) return `<span class="cv-var">= sin cambio${sufijo}</span>`;
  const baja=v<0;
  return `<span class="cv-var ${baja?'cv-baja':'cv-sube'}"><span aria-hidden="true">${baja?'▼':'▲'}</span><span class="sr-only">${baja?'Bajó':'Subió'}</span> ${pref}${fmtDec(Math.abs(v),dec)}${sufijo}</span>`;
}

async function initCostoVida(){
  if(cvInited) return;
  cvInited=true;
  const root=document.getElementById('cv-root');
  let D;
  try{ D=await cargarIndicador('costo_vida'); }
  catch(e){ cvInited=false; return errorIndicador(root,e); }
  const fh=D.fecha_corte, m=id=>metricaPorId(D,id);
  const cb=m('cbfa'), sub=m('subsidio_electrico');

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Costo de la vida',
      desc:'Precios regulados y referencias oficiales para la ciudad de Panamá. El corte es semanal; cada indicador conserva la cadencia de su fuente.'})}
    <div class="ind-kpis">
      ${CV_COMB.map(c=>{ const x=m(c.id); return kpiIndicador(x,{fechaHeader:fh,color:c.color,
        sub:`${cvVariacion(x?.variacion)} vs. quincena anterior${x?.valor_litro?` · B/.${esc(fmtDec(x.valor_litro,3))} por litro`:''}`}); }).join('')}
      ${kpiIndicador(cb,{fechaHeader:fh,color:'var(--costo)',
        sub:`${cvVariacion(cb?.variacion)} vs. mes anterior · Panamá y San Miguelito`})}
      ${kpiIndicador(sub,{fechaHeader:fh,color:'var(--acc5)',sub:`${esc(fmtPeriodo(sub?.periodo))} · consumos ≤300 kWh protegidos (FET)`})}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title" style="--ct:var(--acc)">Combustible por quincena</div>
        <p class="chart-sub">US$ por galón · precio máximo de venta en Panamá y Colón · inicio de cada quincena</p>
        <div class="ch tall"><canvas id="c-cv-comb"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--costo)">Canasta básica familiar de alimentos (CBFA)</div>
        <p class="chart-sub">US$ por mes · ${fuenteHTML(cb?.fuente,cb?.url)} · distritos de Panamá y San Miguelito</p>
        <div class="ch tall"><canvas id="c-cv-cbfa"></canvas></div>
        <p class="ind-nota">${esc(cb?.notas||'')}</p>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc3)">¿Cuánto gastas en combustible al mes?</div>
      <div class="cv-calc">
        <label>Combustible
          <select id="cv-calc-tipo">${CV_COMB.map(c=>`<option value="${c.k}">${esc(c.nombre)}</option>`).join('')}</select>
        </label>
        <label>Galones por semana: <output id="cv-calc-gal-out" for="cv-calc-gal">10</output>
          <input type="range" id="cv-calc-gal" min="1" max="40" step="1" value="10">
        </label>
        <div class="cv-calc-out" id="cv-calc-out" aria-live="polite"></div>
      </div>
      <p class="ind-nota">Gasto mensual = galones por semana × 52 ÷ 12 × precio vigente. Se compara con el precio de hace 3 quincenas.</p>
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title">Tablero de indicadores</div>
      <div class="tbl-scroll">
        <table class="cmp-tbl cv-tbl">
          <thead><tr><th scope="col">Indicador</th><th scope="col">Valor</th><th scope="col">Vigencia</th><th scope="col">Variación</th><th scope="col">Cadencia</th><th scope="col">Fuente</th></tr></thead>
          <tbody id="cv-tbl"></tbody>
        </table>
      </div>
      <p class="ind-nota">Las filas "pendiente" no tienen todavía una fuente verificada: se muestran así en lugar de estimar un valor. Detalles en <a href="#metodologia">Metodología</a>.</p>
    </div>
    ${descargasIndicadorHTML('costo_vida',[['combustible','Combustible por quincena'],['cbfa','CBFA mensual'],['fotos','Fotos semanales']])}`;

  cvGraficos(D);
  cvCalculadora(D);
  cvTabla(D);
}

function cvGraficos(D){
  const s=D.series?.combustible||[];
  const ch=new Chart(document.getElementById('c-cv-comb'),{
    type:'line',
    data:{labels:s.map(r=>fmtDia(r.periodo.split('/')[0],false)),
      datasets:CV_COMB.map(c=>({label:c.nombre,data:s.map(r=>r[c.k]??null),borderColor:c.color,backgroundColor:c.color,pointRadius:4,spanGaps:false,tension:.15}))},
    options:opcionesBase({sufijo:' US$/gal'}),
  });
  const u=s[s.length-1];
  if(u) ariaGrafico(ch,`Combustible por quincena. Vigente desde el ${fmtDia(u.periodo.split('/')[0])}: gasolina 95 a $${u.g95}, gasolina 91 a $${u.g91} y diésel a $${u.diesel} por galón.`);

  const c=D.series?.cbfa||[];
  const ch2=new Chart(document.getElementById('c-cv-cbfa'),{
    type:'line',
    data:{labels:c.map(r=>{const [y,mm]=r.periodo.split('-');return `${MES_CORTO[+mm-1]} ${y.slice(2)}`;}),
      datasets:[{label:'CBFA (US$/mes)',data:c.map(r=>r.valor??null),borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,.18)',fill:'origin',pointRadius:4,tension:.15}]},
    options:{...opcionesBase(),plugins:{...opcionesBase().plugins,legend:{display:false},
      tooltip:{...opcionesBase().plugins.tooltip,callbacks:{label:ctx=>{const r=c[ctx.dataIndex];
        return ` $${fmtDec(ctx.raw,2)}${r.valor_inicial!=null?` (revisado por el MEF; publicado primero: $${fmtDec(r.valor_inicial,2)})`:''}`;}}}},
      scales:{...opcionesBase().scales,y:{...opcionesBase().scales.y,grace:'5%'}}},
  });
  const uc=c[c.length-1];
  if(uc) ariaGrafico(ch2,`Canasta básica familiar de alimentos: $${fmtDec(uc.valor,2)} en ${fmtPeriodo(uc.periodo)}.`);
}

function cvCalculadora(D){
  const s=D.series?.combustible||[];
  const tipo=document.getElementById('cv-calc-tipo'), gal=document.getElementById('cv-calc-gal');
  const outGal=document.getElementById('cv-calc-gal-out'), out=document.getElementById('cv-calc-out');
  const calc=()=>{
    const k=tipo.value, g=Math.min(40,Math.max(1,+gal.value||1));
    outGal.textContent=g;
    const ult=s[s.length-1], ant=s.length>=4?s[s.length-4]:null;
    if(!ult || ult[k]==null){ out.innerHTML='<span class="ind-sd">s/d</span>'; return; }
    const mes=g*SEMANAS_POR_MES*ult[k];
    let comp='<span class="cv-calc-comp">Hace 3 quincenas: s/d (la serie aún no tiene ese período)</span>';
    if(ant && ant[k]!=null){
      const mesAnt=g*SEMANAS_POR_MES*ant[k], dif=mes-mesAnt;
      comp=`<span class="cv-calc-comp">Hace 3 quincenas (${esc(fmtPeriodo(ant.periodo))}, $${fmtDec(ant[k],2)}/gal): $${fmtDec(mesAnt,2)} al mes → ${cvVariacion(dif)} (${dif>=0?'+':'−'}${fmtDec(Math.abs(dif/mesAnt*100),1)}%)</span>`;
    }
    out.innerHTML=`<span class="cv-calc-total">$${fmtDec(mes,2)} <small>al mes</small></span>
      <span class="cv-calc-comp">${fmtDec(g*SEMANAS_POR_MES,1)} galones × $${fmtDec(ult[k],2)} (vigente ${esc(fmtPeriodo(ult.periodo))})</span>${comp}`;
  };
  tipo.addEventListener('change',calc); gal.addEventListener('input',calc);
  calc();
}

function cvTabla(D){
  const orden=['gasolina_95_gal','gasolina_91_gal','diesel_gal','cbfa','subsidio_electrico','electricidad_kwh','agua_idaan','gas_25lb'];
  const filas=orden.map(id=>metricaPorId(D,id)).filter(Boolean);
  document.getElementById('cv-tbl').innerHTML=filas.map(x=>{
    const pend=x.valor==null;
    const val=pend?`<span class="ind-pill">${x.estado==='pendiente'?'pendiente':'s/d'}</span>`
      :`${esc(fmtValor(x))}${x.unidad&&!['%'].includes(x.unidad)?` <small>${esc(x.unidad.replace('USD/','/').replace('USD millones','millones'))}</small>`:''}${x.valor_litro?`<br><small>B/.${esc(fmtDec(x.valor_litro,3))} /L</small>`:''}`;
    const variacion=x.variacion==null?'—':cvVariacion(x.variacion);
    return `<tr>
      <th scope="row">${esc(x.etiqueta)}</th>
      <td>${val}</td>
      <td>${esc(fmtPeriodo(x.periodo))}${x.fecha_corte?`<br>${frescuraHTML(x.fecha_corte)}`:''}</td>
      <td>${variacion}</td>
      <td>${esc(x.cadencia||'s/d')}</td>
      <td style="white-space:normal">${fuenteHTML(x.fuente,x.url)}${x.url_secundaria?` · <a href="${safeUrl(x.url_secundaria)}" target="_blank" rel="noopener">fuente 2</a>`:''} ${pillCalidad(x.calidad)}${pend&&x.notas?`<br><small>${esc(x.notas)}</small>`:''}</td>
    </tr>`;
  }).join('');
}

IND_APLANAR['costo_vida.fotos']=D=>(D.series?.fotos||[]).flatMap(f=>Object.entries(f.valores||{}).map(([id,v])=>({fecha:f.periodo,indicador:id,valor:v})));
