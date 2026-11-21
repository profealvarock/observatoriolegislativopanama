// Observatorio Ciudadano — Pestaña 💵 Salarios y empleo: salario mínimo (decreto), medianas salariales del INEC
// por sector, ocupación, sexo y provincia, desempleo e informalidad (data/salarios.json).
let salInited=false, salSexo={sector:'Total', ocupacion:'Total', provincia:'Total'};
const SAL_SEXOS=[['Total','Total'],['Hombres','Hombres'],['Mujeres','Mujeres']];
// Nombres del INEC → círculos del mapa de provincias (js/general.js)
const SAL_PROV_ID={'Bocas del Toro':'Bocas_del_Toro','Coclé':'Cocle','Colón':'Colon','Chiriquí':'Chiriqui','Darién':'Darien','Herrera':'Herrera',
  'Los Santos':'Los_Santos','Panamá':'Panama','Panamá Oeste':'Panama_Oeste','Veraguas':'Veraguas','Comarca Guna Yala':'Guna_Yala','Comarca Ngäbe Buglé':'Ngabe_Bugle'};
const salMoneda=v=>v==null?'s/d':'$'+fmtDec(v,2);
const salUlt=(D,k)=>{ const s=D.series?.[k]||[]; return s[s.length-1]||null; };
// Etiquetas largas del INEC acortadas para las barras (el texto completo queda en el título)
const salCorto=t=>String(t).replace(/;.*$/,'').replace(/, (actividades de servicios conexas|reparación de vehículos.*|gestión de desechos.*)$/,'').replace(/^Actividades de los hogares.*/,'Trabajo en hogares (empleadores)').replace(/^Actividades de organizaciones.*/,'Organismos extraterritoriales y no declaradas');

async function initSalarios(){
  if(salInited) return;
  salInited=true;
  const root=document.getElementById('sal-root');
  let D;
  try{ D=await cargarIndicador('salarios'); }
  catch(e){ salInited=false; return errorIndicador(root,e); }
  const fh=D.fecha_corte, m=id=>metricaPorId(D,id), F=D.fuentes||{}, SM=D.salario_minimo||{};
  const sec=salUlt(D,'sector'), des=salUlt(D,'desempleo');
  const med=m('mediana_salario');
  const H=sec?.grupos?.Hombres?.mediana, M=sec?.grupos?.Mujeres?.mediana;
  const horas=(SM.tasas||[]).filter(t=>t.unidad==='hora').flatMap(t=>[t.region1,t.region2,t.nacional]).filter(v=>v!=null);
  const minimo={etiqueta:'Salario mínimo por hora', valor:horas.length?`$${fmtDec(Math.min(...horas),2)} – $${fmtDec(Math.max(...horas),2)}`:null,
    unidad:'', fecha_corte:SM.fecha_corte, periodo:SM.vigencia, fuente:F.decreto?.nombre?.split(' (')[0], url:F.decreto?.url, calidad:F.decreto?.calidad};
  const brecha={etiqueta:'Mujeres frente a hombres (mediana)', valor:H&&M?`${M>=H?'+':'−'}${fmtDec(Math.abs((M-H)/H*100),1)}%`:null, unidad:'',
    fecha_corte:med?.fecha_corte, periodo:sec?.periodo, fuente:'INEC — Encuesta de Mercado Laboral', url:sec?.url, calidad:'alta'};
  const signoPts=v=>v==null?'':`${v<0?'▼ ':'▲ '}${fmtDec(Math.abs(v),1)} pts vs. medición anterior`;

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Salarios y empleo',
      desc:'Cuánto se gana en Panamá según el sector, la ocupación, el sexo y la provincia, frente al salario mínimo vigente. Medianas oficiales del INEC: la mitad de los empleados gana menos que esa cifra y la otra mitad, más.'})}
    <div class="ind-kpis ind-kpis-3">
      ${kpiIndicador(med,{fechaHeader:fh,color:'var(--acc3)',sub:`${med?.variacion!=null?`${med.variacion>=0?'▲':'▼'} $${esc(fmtDec(Math.abs(med.variacion),2))} vs. medición anterior · `:''}Hombres <b>${esc(salMoneda(H))}</b> · Mujeres <b>${esc(salMoneda(M))}</b>`})}
      ${kpiIndicador(minimo,{fechaHeader:fh,color:'var(--acc)',clase:'ind-kpi-texto',sub:'Según actividad, tamaño de empresa y región. Trabajo doméstico: <b>$350</b> (Región 1) y <b>$320</b> (Región 2) al mes.'})}
      ${kpiIndicador(m('desempleo'),{fechaHeader:fh,color:'var(--acc4)',sub:`${esc(signoPts(m('desempleo')?.variacion))}${des?.jovenes_20_24!=null?` · de 20 a 24 años: <b>${esc(fmtDec(des.jovenes_20_24,1))}%</b>`:''}`})}
      ${kpiIndicador(m('informalidad'),{fechaHeader:fh,color:'var(--acc2)',sub:`${esc(signoPts(m('informalidad')?.variacion))} · casi la mitad de quienes trabajan fuera del agro`})}
      ${kpiIndicador(brecha,{fechaHeader:fh,color:'var(--acc5)',sub:H&&M?`Mediana de las mujeres ${M>=H?'por encima':'por debajo'} de la de los hombres. Cambia mucho según el sector y la provincia: ver abajo.`:''})}
      ${kpiIndicador(m('mediana_educacion'),{fechaHeader:fh,color:'var(--muted)',sub:esc(m('mediana_educacion')?.notas||'')})}
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc3)">¿Cómo se compara tu salario?</div>
      <div class="cv-calc sal-calc">
        <label>Tu salario mensual (US$)<input type="number" id="sal-calc-monto" min="0" max="100000" step="10" inputmode="decimal" placeholder="Ej.: 800"></label>
        <label>Sector<select id="sal-calc-sector"><option value="">Todos los sectores</option></select></label>
        <label>Provincia<select id="sal-calc-prov"><option value="">Todo el país</option></select></label>
        <div class="cv-calc-out" id="sal-calc-out" aria-live="polite"></div>
      </div>
      <p class="ind-nota">Se calcula en tu navegador y no se guarda. Compara con la mediana: si ganas más, estás en la mitad que más gana de ese grupo.</p>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title" style="--ct:var(--acc3)">Mediana del salario mensual en el tiempo</div>
        <p class="chart-sub">US$ · ${fuenteHTML(F.inec_eml?.nombre,F.inec_eml?.url)}</p>
        <div class="ch"><canvas id="c-sal-hist"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--acc2)">Empleo informal</div>
        <p class="chart-sub">% de la población ocupada no agrícola · INEC</p>
        <div class="ch"><canvas id="c-sal-inf"></canvas></div>
        <p class="ind-nota">2020 corresponde a la encuesta telefónica de la pandemia.</p>
      </div>
    </div>

    <div class="grid2">
      <div class="card" id="sal-sector"></div>
      <div class="card" id="sal-ocupacion"></div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)" id="sal-provincia"></div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc)">Salario mínimo 2026-2027</div>
      <p class="chart-sub">${fuenteHTML(F.decreto?.nombre,F.decreto?.url)} · ${esc(F.decreto?.detalle||'')}</p>
      <div class="tbl-scroll"><table class="cmp-tbl sal-tbl">
        <thead><tr><th scope="col">Actividad</th><th scope="col">Región 1</th><th scope="col">Región 2</th><th scope="col">Equivalente mensual (Región 1 o nacional)</th></tr></thead>
        <tbody>${(SM.tasas||[]).map(t=>{
          const r1=t.region1??t.nacional, r2=t.region2??(t.nacional!=null?t.nacional:null);
          const mes=t.unidad==='hora'&&r1!=null?r1*(SM.horas_mes||208):(t.unidad==='mes'?r1:null);
          const u=t.unidad==='hora'?'/h':'/mes';
          return `<tr><th scope="row" style="white-space:normal">${esc(t.actividad)}${t.nacional!=null?' <small>(tasa nacional)</small>':''}</th>
            <td>${r1!=null?esc(salMoneda(r1))+u:'—'}</td><td>${r2!=null?esc(salMoneda(r2))+u:'—'}</td>
            <td>${mes!=null?`${esc(salMoneda(mes))} <small>${med?.valor?`(${fmtDec(mes/med.valor*100,0)}% de la mediana)`:''}</small>`:'—'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <p class="ind-nota"><b>Región 1:</b> ${esc(SM.region_1||'s/d')}. <b>Región 2:</b> ${esc(SM.region_2||'s/d')}. ${esc(SM.notas||'')}</p>
    </div>

    <div class="card ind-fuentes" style="margin-bottom:var(--gap)">
      <div class="card-title">Fuentes</div>
      <ul>
        ${Object.values(F).map(f=>`<li>${fuenteHTML(f.nombre,f.url)}${f.detalle?` — ${esc(f.detalle)}`:''}</li>`).join('')}
        ${['sector','ocupacion','provincia'].map(k=>{const r=salUlt(D,k); return r?`<li>${esc({sector:'Por sector y sexo',ocupacion:'Por ocupación y sexo',provincia:'Por provincia y sexo'}[k])}: <a href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(r.fuente)}</a> · <a href="${safeUrl(r.cuadro)}" target="_blank" rel="noopener">cuadro en Excel</a></li>`:''}).join('')}
      </ul>
    </div>
    ${descargasIndicadorHTML('salarios',[['sector','Salario por sector'],['ocupacion','Salario por ocupación'],['provincia','Salario por provincia'],['salario_minimo','Salario mínimo'],['informalidad','Informalidad']])}`;

  salGraficos(D);
  salBarras(D,'sector');
  salBarras(D,'ocupacion');
  salProvincias(D);
  salCalculadora(D);
}

function salGraficos(D){
  const h=D.series?.mediana_historica||[];
  const ch=new Chart(document.getElementById('c-sal-hist'),{type:'line',
    data:{labels:h.map(r=>fmtPeriodo(r.periodo)),datasets:[{label:'Mediana (US$)',data:h.map(r=>r.valor),borderColor:'#10b981',backgroundColor:'rgba(16,185,129,.15)',fill:'origin',pointRadius:4,tension:.2}]},
    options:{...opcionesBase({sufijo:' US$'}),plugins:{...opcionesBase().plugins,legend:{display:false}},scales:{...opcionesBase().scales,y:{...opcionesBase().scales.y,grace:'10%'}}}});
  const u=h[h.length-1]; if(u) ariaGrafico(ch,`Mediana del salario mensual: $${fmtDec(u.valor,2)} en ${fmtPeriodo(u.periodo)}${h[0]?`, frente a $${fmtDec(h[0].valor,2)} en ${fmtPeriodo(h[0].periodo)}`:''}.`);
  const inf=D.series?.informalidad||[];
  const ch2=new Chart(document.getElementById('c-sal-inf'),{type:'line',
    data:{labels:inf.map(r=>r.periodo),datasets:[{label:'Empleo informal (%)',data:inf.map(r=>r.valor),borderColor:'#f59e0b',backgroundColor:'#f59e0b',pointRadius:3,tension:.2}]},
    options:{...opcionesBase({sufijo:'%'}),plugins:{...opcionesBase().plugins,legend:{display:false}},scales:{...opcionesBase().scales,y:{...opcionesBase().scales.y,suggestedMin:35,suggestedMax:55}}}});
  const ui=inf[inf.length-1]; if(ui) ariaGrafico(ch2,`Empleo informal: ${fmtDec(ui.valor,1)}% en ${ui.periodo}.`);
}

// Selector Total / Hombres / Mujeres para cada bloque de barras
function salSegHTML(dim){
  return `<div class="ind-seg" role="group" aria-label="Sexo">${SAL_SEXOS.map(([k,t])=>`<button type="button" class="map-chip${salSexo[dim]===k?' active':''}" aria-pressed="${salSexo[dim]===k}" data-sal-dim="${dim}" data-sal-sexo="${k}">${t}</button>`).join('')}</div>`;
}
function salEnlazarSeg(D, dim, fn){
  document.querySelectorAll(`[data-sal-dim="${dim}"]`).forEach(b=>b.addEventListener('click',()=>{ salSexo[dim]=b.dataset.salSexo; fn(D,dim); }));
}

function salBarras(D, dim){
  const el=document.getElementById('sal-'+dim), r=salUlt(D,dim);
  const titulo={sector:'Salario por sector económico',ocupacion:'Salario por ocupación'}[dim];
  if(!r){ el.innerHTML=`<div class="card-title">${titulo}</div><p class="ind-sd">s/d</p>`; return; }
  const g=r.grupos?.[salSexo[dim]]||{filas:[]}, nac=g.mediana;
  const filas=(g.filas||[]).filter(f=>f.empleados).slice().sort((a,b)=>b.mediana-a.mediana);
  const max=Math.max(...filas.map(f=>f.mediana),1);
  const top=filas[0], bot=filas[filas.length-1];
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc3)">${titulo}</div>
    ${salSegHTML(dim)}
    <p class="chart-sub">Mediana mensual en US$ · ${esc(fmtPeriodo(r.periodo))} · la línea marca la mediana ${salSexo[dim]==='Total'?'nacional':'de '+salSexo[dim].toLowerCase()} (${esc(salMoneda(nac))})</p>
    <ol class="ind-bars sal-bars" aria-label="${esc(top?`${titulo} (${salSexo[dim]}): la más alta es ${top.etiqueta}, ${salMoneda(top.mediana)}; la más baja, ${bot.etiqueta}, ${salMoneda(bot.mediana)}.`:'s/d')}">
      ${filas.map(f=>`<li class="ind-bar" title="${esc(f.etiqueta)} · ${fmtNum(f.empleados)} empleados">
        <span class="ind-bar-lbl"><b>${esc(salCorto(f.etiqueta))}</b> <span>${fmtNum(f.empleados)} empleados</span></span>
        <span class="ind-bar-track sal-track" aria-hidden="true" style="--ref:${(nac/max*100).toFixed(1)}%"><span class="ind-bar-fill" style="--bc:${f.mediana>=nac?'var(--acc3)':'var(--acc2)'};width:${(f.mediana/max*100).toFixed(1)}%"></span></span>
        <span class="ind-bar-val">${esc(salMoneda(f.mediana))}</span>
      </li>`).join('')}
    </ol>
    ${dim==='ocupacion'?'<p class="ind-nota">El INEC no publica salarios por nivel educativo; la ocupación es la referencia más cercana (los profesionales suelen tener estudios universitarios).</p>':'<p class="ind-nota">Los sectores con pocos empleados en la muestra (minería, organismos extraterritoriales) tienen medianas menos precisas.</p>'}`;
  salEnlazarSeg(D, dim, salBarras);
}

function salProvincias(D){
  const el=document.getElementById('sal-provincia'), r=salUlt(D,'provincia');
  if(!r){ el.innerHTML='<div class="card-title">Salario por provincia</div><p class="ind-sd">s/d</p>'; return; }
  const sx=salSexo.provincia, nac=r.nacional?.[sx]?.mediana;
  const filas=(r.provincias||[]).map(p=>({prov:p.provincia, v:p[sx]?.mediana, emp:p[sx]?.empleados, h:p.Hombres?.mediana, m:p.Mujeres?.mediana})).filter(x=>x.v!=null).sort((a,b)=>b.v-a.v);
  const max=Math.max(...filas.map(f=>f.v),1);
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc)">Salario por provincia y comarca</div>
    ${salSegHTML('provincia')}
    <p class="chart-sub">Mediana mensual en US$ · ${esc(fmtPeriodo(r.periodo))} (último boletín del INEC con datos por provincia) · ${frescuraHTML(r.periodo+'-28')}</p>
    <div class="sal-prov-grid">
      <div class="map-wrap sis-map" id="sal-map-wrap"><img class="panama-map-base" src="panama-map.svg" alt="" aria-hidden="true"></div>
      <ol class="ind-bars sal-bars" aria-label="${esc(filas.length?`Salario por provincia (${sx}): más alto en ${filas[0].prov} (${salMoneda(filas[0].v)}), más bajo en ${filas[filas.length-1].prov} (${salMoneda(filas[filas.length-1].v)}).`:'s/d')}">
        ${filas.map(f=>`<li class="ind-bar" title="Hombres ${salMoneda(f.h)} · Mujeres ${salMoneda(f.m)}">
          <span class="ind-bar-lbl"><b>${esc(f.prov)}</b> <span>H ${esc(salMoneda(f.h))} · M ${esc(salMoneda(f.m))}</span></span>
          <span class="ind-bar-track sal-track" aria-hidden="true" style="--ref:${((nac||0)/max*100).toFixed(1)}%"><span class="ind-bar-fill" style="--bc:${f.v>=(nac||0)?'var(--acc3)':'var(--acc2)'};width:${(f.v/max*100).toFixed(1)}%"></span></span>
          <span class="ind-bar-val">${esc(salMoneda(f.v))}</span>
        </li>`).join('')}
      </ol>
    </div>
    <p class="ind-nota">Las comarcas tienen pocos empleados asalariados en la muestra; sus medianas son menos precisas. La Comarca Emberá no tiene círculo propio en el mapa.</p>`;
  salEnlazarSeg(D,'provincia',(Dx)=>salProvincias(Dx));
  // Mapa: el mismo de la pestaña General, con los círculos coloreados por la mediana
  const wrap=document.getElementById('sal-map-wrap'), base=document.getElementById('panama-map');
  if(!wrap||!base) return;
  const svg=base.cloneNode(true); svg.id='sal-map';
  svg.querySelectorAll('[id]').forEach(n=>{ n.id='sal-'+n.id; });
  svg.querySelectorAll('text:not(.map-label)').forEach(t=>t.remove());
  svg.setAttribute('role','img'); svg.removeAttribute('aria-hidden');
  const vals=Object.fromEntries(filas.map(f=>[SAL_PROV_ID[f.prov],f]));
  const vs=filas.map(f=>f.v), lo=Math.min(...vs), hi=Math.max(...vs);
  MAP_ALL_IDS.forEach(id=>{
    const c=svg.querySelector('#sal-pmap-'+id); if(!c) return;
    const f=vals[id]; c.classList.add('sis-prov');
    if(!f){ c.style.fill='rgba(148,163,184,.12)'; c.setAttribute('r',11); return; }
    const t=(f.v-lo)/((hi-lo)||1);
    c.style.fill=`rgba(16,185,129,${(0.15+0.75*t).toFixed(2)})`; c.setAttribute('r',(12+t*14).toFixed(1));
    const ti=document.createElementNS('http://www.w3.org/2000/svg','title'); ti.textContent=`${f.prov}: ${salMoneda(f.v)}`; c.appendChild(ti);
  });
  svg.setAttribute('aria-label',`Mapa de la mediana salarial por provincia (${sx}). Más alta: ${filas[0]?.prov} con ${salMoneda(filas[0]?.v)}.`);
  wrap.appendChild(svg);
}

function salCalculadora(D){
  const monto=document.getElementById('sal-calc-monto'), selS=document.getElementById('sal-calc-sector'), selP=document.getElementById('sal-calc-prov'), out=document.getElementById('sal-calc-out');
  const sec=salUlt(D,'sector'), prov=salUlt(D,'provincia');
  (sec?.grupos?.Total?.filas||[]).forEach((f,i)=>selS.insertAdjacentHTML('beforeend',`<option value="${i}">${esc(salCorto(f.etiqueta))}</option>`));
  (prov?.provincias||[]).forEach((p,i)=>selP.insertAdjacentHTML('beforeend',`<option value="${i}">${esc(p.provincia)}</option>`));
  const linea=(nombre,ref,v,per)=>{
    if(ref==null) return `<span class="cv-calc-comp">${esc(nombre)}: s/d</span>`;
    const d=v-ref, pct=d/ref*100;
    return `<span class="cv-calc-comp">${esc(nombre)} (${esc(salMoneda(ref))}, ${esc(fmtPeriodo(per))}): ${d>=0?'<b class="cv-baja">por encima</b>':'<b class="cv-sube">por debajo</b>'} por ${esc(salMoneda(Math.abs(d)))} (${d>=0?'+':'−'}${fmtDec(Math.abs(pct),1)}%)</span>`;
  };
  const calc=()=>{
    const v=parseFloat(monto.value);
    if(!(v>0)){ out.innerHTML='<span class="cv-calc-comp">Escribe tu salario mensual para compararlo.</span>'; return; }
    const s=selS.value!==''?sec.grupos.Total.filas[+selS.value]:null, p=selP.value!==''?prov.provincias[+selP.value]:null;
    out.innerHTML=`<span class="cv-calc-total">${esc(salMoneda(v))} <small>al mes</small></span>`
      +linea('Mediana nacional',sec?.grupos?.Total?.mediana,v,sec?.periodo)
      +(s?linea(salCorto(s.etiqueta),s.mediana,v,sec.periodo):'')
      +(p?linea(p.provincia,p.Total?.mediana,v,prov.periodo):'');
  };
  [monto,selS,selP].forEach(x=>x.addEventListener('input',calc));
  calc();
}

IND_APLANAR['salarios.sector']=D=>(D.series?.sector||[]).flatMap(r=>Object.entries(r.grupos||{}).flatMap(([sx,g])=>[{periodo:r.periodo,sexo:sx,sector:'TOTAL',mediana:g.mediana,empleados:g.empleados,fuente:r.fuente,url:r.cuadro},...(g.filas||[]).map(f=>({periodo:r.periodo,sexo:sx,sector:f.etiqueta,mediana:f.mediana,empleados:f.empleados,fuente:r.fuente,url:r.cuadro}))]));
IND_APLANAR['salarios.ocupacion']=D=>(D.series?.ocupacion||[]).flatMap(r=>Object.entries(r.grupos||{}).flatMap(([sx,g])=>[{periodo:r.periodo,sexo:sx,ocupacion:'TOTAL',mediana:g.mediana,empleados:g.empleados,fuente:r.fuente,url:r.cuadro},...(g.filas||[]).map(f=>({periodo:r.periodo,sexo:sx,ocupacion:f.etiqueta,mediana:f.mediana,empleados:f.empleados,fuente:r.fuente,url:r.cuadro}))]));
IND_APLANAR['salarios.provincia']=D=>(D.series?.provincia||[]).flatMap(r=>(r.provincias||[]).flatMap(p=>SAL_SEXOS.map(([sx])=>({periodo:r.periodo,provincia:p.provincia,sexo:sx,mediana:p[sx]?.mediana,empleados:p[sx]?.empleados,fuente:r.fuente,url:r.cuadro}))));
IND_APLANAR['salarios.salario_minimo']=D=>(D.salario_minimo?.tasas||[]).map(t=>({actividad:t.actividad,region1:t.region1,region2:t.region2,nacional:t.nacional,unidad:t.unidad,vigencia:D.salario_minimo.vigencia,fuente:D.fuentes?.decreto?.url}));
