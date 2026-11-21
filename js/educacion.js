// Observatorio Ciudadano — Pestaña 🎓 Educación: analfabetismo y nivel educativo (Censo 2023), carreras universitarias
// (INEC), deserción escolar por nivel (MEDUCA) y gasto por alumno (data/educacion.json).
let eduInited=false, eduSexo={analf:'Total', instr:'Total', deser:'Total'}, eduNivel='media', eduUni='matricula';
const EDU_NIVELES=[['primaria','Primaria'],['premedia','Premedia'],['media','Media']];
const EDU_TRAMOS=[['sin_grado','Sin grado','#94a3b8'],['primaria','Primaria','#f59e0b'],['secundaria','Secundaria','#3b82f6'],['tecnica','Técnica o vocacional','#a78bfa'],['universitaria','Universitaria','#10b981']];
const eduPct=(v,d=1)=>v==null?'s/d':fmtDec(v,d)+'%';

async function initEducacion(){
  if(eduInited) return;
  eduInited=true;
  const root=document.getElementById('edu-root');
  let D;
  try{ D=await cargarIndicador('educacion'); }
  catch(e){ eduInited=false; return errorIndicador(root,e); }
  const fh=D.fecha_corte, m=id=>metricaPorId(D,id), C=D.censo||{}, F=D.fuentes||{};
  const nac=C.analfabetismo?.nacional||{}, rep=C.instruccion?.['República']||{};
  const des=n=>(D.series?.['desercion_'+n]||[]).slice(-1)[0];
  const hm=(h,mu,f)=>h!=null&&mu!=null?`Hombres <b>${esc(f(h))}</b> · Mujeres <b>${esc(f(mu))}</b>`:'';
  const varTxt=(v,txt)=>v==null?'':`${v<0?'▼':'▲'} ${fmtDec(Math.abs(v),2)} pts ${txt}`;
  const uni=(D.series?.universidad||[]).slice(-1)[0];
  const ca=uni?.costo_alumno;

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Educación',
      desc:'Cuántas personas saben leer y escribir, hasta dónde estudió la población, qué carreras se estudian y cuántos estudiantes abandonan la escuela en cada nivel. Censo 2023, MEDUCA e INEC.'})}
    <div class="ind-kpis ind-kpis-3">
      ${kpiIndicador(m('analfabetismo'),{fechaHeader:fh,color:'var(--acc4)',valor:eduPct(m('analfabetismo')?.valor,2),sub:`${hm(nac.Hombres?.tasa,nac.Mujeres?.tasa,v=>eduPct(v,2))} · ${esc(varTxt(m('analfabetismo')?.variacion,'desde 2010'))} · ${esc(fmtNum(nac.Total?.analfabetas))} personas`})}
      ${kpiIndicador(m('promedio_anios'),{fechaHeader:fh,color:'var(--acc)',valor:m('promedio_anios')?.valor!=null?fmtDec(m('promedio_anios').valor,1)+' años':null,sub:hm(rep.Hombres?.promedio_anios,rep.Mujeres?.promedio_anios,v=>fmtDec(v,1)+' años')})}
      ${kpiIndicador(m('universitaria_25'),{fechaHeader:fh,color:'var(--acc3)',sub:`${hm(rep.Hombres?.universitaria,rep.Mujeres?.universitaria,v=>eduPct(v))} · con posgrado: <b>${esc(eduPct(rep.Total?.posgrado))}</b>`})}
      ${EDU_NIVELES.map(([n])=>{ const x=m('desercion_'+n), r=des(n); return kpiIndicador(x,{fechaHeader:fh,color:'var(--acc2)',valor:eduPct(x?.valor,2),
        sub:`${r?hm(r.nacional.desertores.Hombres,r.nacional.desertores.Mujeres,v=>eduPct(v,2)):''}${x?.variacion!=null?` · ${esc(varTxt(x.variacion,'vs. año anterior'))}`:''}${r?` · matrícula ${esc(fmtNum(r.nacional.matricula))}`:''}`}); }).join('')}
      ${kpiIndicador(m('desercion_universidad'),{fechaHeader:fh,color:'var(--muted)',sub:esc(m('desercion_universidad')?.notas||'')})}
      ${kpiIndicador(m('costo_alumno'),{fechaHeader:fh,color:'var(--costo)',valor:m('costo_alumno')?.valor!=null?'$'+fmtNum(m('costo_alumno').valor):null,
        sub:ca?`Primaria <b>$${fmtNum(ca.niveles['Inicial y primaria'])}</b> · Premedia y media <b>$${fmtNum(ca.niveles['Premedia y media'])}</b> · Universidad <b>$${fmtNum(ca.niveles['Universitaria'])}</b>`:''})}
    </div>

    <div class="card" style="margin-bottom:var(--gap)" id="edu-analf"></div>

    <div class="card" style="margin-bottom:var(--gap)" id="edu-instr"></div>

    <div class="grid2">
      <div class="card" id="edu-uni"></div>
      <div class="card" id="edu-deser"></div>
    </div>

    <div class="card ind-fuentes" style="margin-bottom:var(--gap)">
      <div class="card-title">Fuentes</div>
      <ul>
        ${Object.values(F).map(f=>`<li>${fuenteHTML(f.nombre,f.url)}${f.detalle?` — ${esc(f.detalle)}`:''}</li>`).join('')}
        ${Object.values(C.cuadros||{}).map(c=>`<li>Censo 2023: <a href="${safeUrl(c.url)}" target="_blank" rel="noopener">${esc(c.titulo.replace(/^\d+\s+/,''))}</a></li>`).join('')}
        ${EDU_NIVELES.map(([n])=>(D.series?.['desercion_'+n]||[]).map(r=>`<li>MEDUCA: <a href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(r.titulo.replace(/\s*→\s*$/,''))}</a></li>`).join('')).join('')}
        ${uni?`<li>${fuenteHTML(uni.titulo,uni.url)} · <a href="${safeUrl(uni.matricula_cuadro)}" target="_blank" rel="noopener">matrícula por sector (Excel)</a>${uni.graduados_cuadro?` · <a href="${safeUrl(uni.graduados_cuadro)}" target="_blank" rel="noopener">graduados (Excel)</a>`:''}</li>`:''}
      </ul>
    </div>
    ${descargasIndicadorHTML('educacion',[['analfabetismo','Analfabetismo por provincia'],['instruccion','Nivel educativo por provincia'],['universidad','Carreras universitarias'],['desercion','Deserción por región']])}`;

  eduAnalfabetismo(D);
  eduInstruccion(D);
  eduUniversidad(D);
  eduDesercion(D);
}

function eduSeg(grupo, opciones, actual){
  return `<div class="ind-seg" role="group">${opciones.map(([k,t])=>`<button type="button" class="map-chip${actual===k?' active':''}" aria-pressed="${actual===k}" data-edu="${grupo}" data-val="${k}">${t}</button>`).join('')}</div>`;
}
function eduEnlazar(grupo, fn){
  document.querySelectorAll(`[data-edu="${grupo}"]`).forEach(b=>b.addEventListener('click',()=>fn(b.dataset.val)));
}

function eduAnalfabetismo(D){
  const el=document.getElementById('edu-analf'), A=D.censo?.analfabetismo;
  if(!A){ el.innerHTML='<div class="card-title">Analfabetismo</div><p class="ind-sd">s/d</p>'; return; }
  const sx=eduSexo.analf, nacV=A.nacional?.[sx]?.tasa;
  const filas=(A.provincias||[]).map(p=>({prov:p.provincia, v:p[sx]?.tasa, n:p[sx]?.analfabetas, h:p.Hombres?.tasa, mu:p.Mujeres?.tasa, a2000:p['2000'], a2010:p['2010']})).filter(f=>f.v!=null).sort((a,b)=>b.v-a.v);
  const max=Math.max(...filas.map(f=>f.v),1);
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc4)">Analfabetismo por provincia y comarca</div>
    ${eduSeg('analf',SAL_SEXOS,sx)}
    <p class="chart-sub">% de la población de 10 y más años que no sabe leer ni escribir · Censo 2023 · la línea marca el promedio nacional (${esc(eduPct(nacV,2))})</p>
    <div class="sal-prov-grid">
      <div>
        <div class="ch" style="height:200px"><canvas id="c-edu-analf-hist"></canvas></div>
        <div class="map-wrap sis-map" id="edu-map-wrap" style="margin-top:12px"><img class="panama-map-base" src="panama-map.svg" alt="" aria-hidden="true"></div>
      </div>
      <ol class="ind-bars sal-bars" aria-label="${esc(filas.length?`Analfabetismo (${sx}): más alto en ${filas[0].prov}, ${eduPct(filas[0].v,2)}; más bajo en ${filas[filas.length-1].prov}, ${eduPct(filas[filas.length-1].v,2)}.`:'s/d')}">
        ${filas.map(f=>`<li class="ind-bar" title="${esc(f.prov)}: ${fmtNum(f.n)} personas${f.a2000!=null?` · 2000: ${f.a2000}% · 2010: ${f.a2010}%`:''}">
          <span class="ind-bar-lbl"><b>${esc(f.prov)}</b> <span>H ${esc(eduPct(f.h,1))} · M ${esc(eduPct(f.mu,1))}</span></span>
          <span class="ind-bar-track sal-track" aria-hidden="true" style="--ref:${((nacV||0)/max*100).toFixed(1)}%"><span class="ind-bar-fill" style="--bc:${f.v>(nacV||0)?'var(--acc4)':'var(--acc3)'};width:${(f.v/max*100).toFixed(1)}%"></span></span>
          <span class="ind-bar-val">${esc(eduPct(f.v,2))}</span>
        </li>`).join('')}
      </ol>
    </div>
    <p class="ind-nota">En las provincias, la tasa por sexo se calcula con los conteos del cuadro 19 del Censo (sin las personas que no declararon); el total nacional y por provincia es el publicado por el INEC.</p>`;
  eduEnlazar('analf',v=>{eduSexo.analf=v; eduAnalfabetismo(D);});
  const h=A.historico||[];
  if(eduChartHist) eduChartHist.destroy();
  const ch=eduChartHist=new Chart(document.getElementById('c-edu-analf-hist'),{type:'bar',
    data:{labels:h.map(x=>'Censo '+x.anio),datasets:[{label:'Analfabetismo (%)',data:h.map(x=>x.tasa),backgroundColor:['#fca5a5','#f87171','#ef4444'],borderRadius:5}]},
    options:{...opcionesBase({sufijo:'%'}),plugins:{...opcionesBase().plugins,legend:{display:false}},scales:{...opcionesBase().scales,y:{...opcionesBase().scales.y,min:0}}}});
  if(h.length) ariaGrafico(ch,`Analfabetismo nacional: ${h.map(x=>`${x.tasa}% en ${x.anio}`).join(', ')}.`);
  eduMapa(document.getElementById('edu-map-wrap'), filas, '239,68,68', v=>eduPct(v,2), 'Analfabetismo');
}

// Mapa de provincias de la pestaña General, con los círculos coloreados por el valor
function eduMapa(wrap, filas, rgb, fmt, nombre){
  const base=document.getElementById('panama-map');
  if(!wrap||!base||!filas.length) return;
  wrap.querySelector('svg')?.remove();
  const svg=base.cloneNode(true); svg.id='';
  svg.querySelectorAll('[id]').forEach(n=>{ n.id='edu-'+n.id; });
  svg.querySelectorAll('text:not(.map-label)').forEach(t=>t.remove());
  svg.setAttribute('role','img'); svg.removeAttribute('aria-hidden');
  const vals=Object.fromEntries(filas.map(f=>[SAL_PROV_ID[f.prov],f])), vs=filas.map(f=>f.v), lo=Math.min(...vs), hi=Math.max(...vs);
  MAP_ALL_IDS.forEach(id=>{
    const c=svg.querySelector('#edu-pmap-'+id); if(!c) return;
    const f=vals[id]; c.classList.add('sis-prov');
    if(!f){ c.style.fill='rgba(148,163,184,.12)'; c.setAttribute('r',11); return; }
    const t=(f.v-lo)/((hi-lo)||1);
    c.style.fill=`rgba(${rgb},${(0.15+0.75*t).toFixed(2)})`; c.setAttribute('r',(12+t*14).toFixed(1));
    const ti=document.createElementNS('http://www.w3.org/2000/svg','title'); ti.textContent=`${f.prov}: ${fmt(f.v)}`; c.appendChild(ti);
  });
  svg.setAttribute('aria-label',`Mapa de ${nombre.toLowerCase()} por provincia: más alto en ${filas[0].prov} (${fmt(filas[0].v)}).`);
  wrap.appendChild(svg);
}

let eduChartInstr=null, eduChartHist=null;
function eduInstruccion(D){
  const el=document.getElementById('edu-instr'), I=D.censo?.instruccion;
  if(!I){ el.innerHTML='<div class="card-title">Nivel educativo</div><p class="ind-sd">s/d</p>'; return; }
  const sx=eduSexo.instr;
  const lugares=Object.entries(I).map(([l,v])=>({l, d:v[sx]})).filter(x=>x.d).sort((a,b)=>(a.l==='República'?-1:b.l==='República'?1:b.d.universitaria-a.d.universitaria));
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc)">Nivel educativo alcanzado (25 y más años)</div>
    ${eduSeg('instr',SAL_SEXOS,sx)}
    <p class="chart-sub">% de la población de 25 años y más según el nivel más alto que cursó · Censo 2023 · ordenado por estudios universitarios. "Primaria", "Secundaria" y "Universitaria" incluyen a quienes aprobaron algún grado de ese nivel, aunque no lo terminaran.</p>
    <div class="ch" style="height:${Math.max(320,lugares.length*30)}px"><canvas id="c-edu-instr"></canvas></div>
    <div class="tbl-scroll"><table class="cmp-tbl edu-anios">
      <thead><tr><th scope="col">Lugar</th><th scope="col">Años de estudio promedio</th><th scope="col">Universitaria</th><th scope="col">Con posgrado</th><th scope="col">Sin grado</th></tr></thead>
      <tbody>${lugares.map(x=>`<tr><th scope="row">${esc(x.l)}</th><td>${x.d.promedio_anios!=null?esc(fmtDec(x.d.promedio_anios,1)):'s/d'}</td><td>${esc(eduPct(x.d.universitaria))}</td><td>${esc(eduPct(x.d.posgrado))}</td><td>${esc(eduPct(x.d.sin_grado))}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="ind-nota">Años de estudio promedio: de la población de 4 y más años, publicado por el INEC. "Sin grado" incluye preescolar y enseñanza especial.</p>`;
  eduEnlazar('instr',v=>{eduSexo.instr=v; eduInstruccion(D);});
  if(eduChartInstr){ eduChartInstr.destroy(); }
  eduChartInstr=new Chart(document.getElementById('c-edu-instr'),{type:'bar',
    data:{labels:lugares.map(x=>x.l),datasets:EDU_TRAMOS.map(([k,t,c])=>({label:t,data:lugares.map(x=>x.d[k]),backgroundColor:c}))},
    options:{...opcionesBase({sufijo:'%'}),indexAxis:'y',
      scales:{x:{...opcionesBase().scales.x,stacked:true,min:0,max:100},y:{...opcionesBase().scales.y,stacked:true,ticks:{color:'#94a3b8',font:{family:'DM Mono',size:11},autoSkip:false}}}}});
  const r=I['República']?.[sx];
  if(r) ariaGrafico(eduChartInstr,`Nivel educativo de la población de 25 y más años (${sx}): ${eduPct(r.universitaria)} con estudios universitarios, ${eduPct(r.secundaria)} secundaria, ${eduPct(r.primaria)} primaria y ${eduPct(r.sin_grado)} sin grado.`);
}

function eduUniversidad(D){
  const el=document.getElementById('edu-uni'), u=(D.series?.universidad||[]).slice(-1)[0];
  if(!u){ el.innerHTML='<div class="card-title">Carreras universitarias</div><p class="ind-sd">s/d</p>'; return; }
  const B=u[eduUni]||u.matricula, tot=B.total.total;
  const filas=B.sectores.slice().sort((a,b)=>b.total-a.total);
  const max=Math.max(...filas.map(f=>f.total),1);
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc3)">Qué se estudia en la universidad</div>
    ${eduSeg('uni',[['matricula','Matrícula'],['graduados','Graduados']].filter(([k])=>u[k]),eduUni)}
    <p class="chart-sub">${eduUni==='matricula'?'Estudiantes matriculados':'Graduados'} en universidades públicas y privadas por sector de estudio · ${esc(u.periodo)} · total ${esc(fmtNum(tot))} (${esc(eduPct(B.total.mujeres/tot*100,0))} mujeres)</p>
    <ol class="ind-bars sal-bars" aria-label="${esc(`Sectores de estudio con más ${eduUni}: ${filas.slice(0,3).map(f=>`${f.sector} (${fmtNum(f.total)})`).join(', ')}.`)}">
      ${filas.map(f=>`<li class="ind-bar" title="${esc(f.sector)} · hombres ${fmtNum(f.hombres)} · mujeres ${fmtNum(f.mujeres)}">
        <span class="ind-bar-lbl"><b>${esc(f.sector)}</b> <span>${esc(eduPct(f.mujeres/f.total*100,0))} mujeres</span></span>
        <span class="ind-bar-track" aria-hidden="true"><span class="ind-bar-fill" style="--bc:var(--acc3);width:${(f.total/max*100).toFixed(1)}%"></span></span>
        <span class="ind-bar-val">${esc(fmtNum(f.total))} <small>${esc(eduPct(f.total/tot*100))}</small></span>
      </li>`).join('')}
    </ol>
    <p class="ind-nota">Los "sectores de estudio" agrupan carreras afines (clasificación del INEC): por ejemplo, "Educación comercial y administración" incluye administración de empresas, contabilidad y mercadeo. El INEC no publica la matrícula nacional carrera por carrera.</p>`;
  eduEnlazar('uni',v=>{eduUni=v; eduUniversidad(D);});
}

let eduChartDes=null;
function eduDesercion(D){
  const el=document.getElementById('edu-deser');
  const serie=n=>D.series?.['desercion_'+n]||[];
  const anios=[...new Set(EDU_NIVELES.flatMap(([n])=>serie(n).map(r=>r.periodo)))].sort();
  const ult=serie(eduNivel).slice(-1)[0], sx=eduSexo.deser;
  const regiones=(ult?.regiones||[]).filter(r=>!['Indígena','Rural','Urbana','Comarcas'].includes(r.region)).map(r=>({r:r.region,v:r.desertores[sx]})).sort((a,b)=>b.v-a.v);
  const areas=(ult?.regiones||[]).filter(r=>['Urbana','Rural','Indígena'].includes(r.region));
  const max=Math.max(...regiones.map(r=>r.v),0.01), nacV=ult?.nacional?.desertores?.[sx];
  el.innerHTML=`
    <div class="card-title" style="--ct:var(--acc2)">Deserción escolar por nivel</div>
    <p class="chart-sub">% de la matrícula que abandonó durante el año lectivo · escuelas oficiales y particulares · MEDUCA</p>
    <div class="ch" style="height:220px"><canvas id="c-edu-deser"></canvas></div>
    <div class="edu-deser-ctrl">${eduSeg('nivel',EDU_NIVELES,eduNivel)}${eduSeg('deser',SAL_SEXOS,sx)}</div>
    <p class="chart-sub">Por región educativa · ${esc(EDU_NIVELES.find(x=>x[0]===eduNivel)[1])} ${esc(ult?.periodo||'')} · nacional ${esc(eduPct(nacV,2))}${areas.length?` · ${areas.map(a=>`${a.region.toLowerCase()} ${eduPct(a.desertores[sx],2)}`).join(' · ')}`:''}</p>
    <ol class="ind-bars sal-bars" aria-label="${esc(regiones.length?`Deserción en ${eduNivel} (${sx}) por región: más alta en ${regiones[0].r} (${eduPct(regiones[0].v,2)}).`:'s/d')}">
      ${regiones.map(r=>`<li class="ind-bar"><span class="ind-bar-lbl"><b>${esc(r.r)}</b></span>
        <span class="ind-bar-track sal-track" aria-hidden="true" style="--ref:${((nacV||0)/max*100).toFixed(1)}%"><span class="ind-bar-fill" style="--bc:${r.v>(nacV||0)?'var(--acc4)':'var(--acc2)'};width:${Math.max(.5,r.v/max*100).toFixed(1)}%"></span></span>
        <span class="ind-bar-val">${esc(eduPct(r.v,2))}</span></li>`).join('')}
    </ol>
    <p class="ind-nota"><b>Universidad:</b> no hay una tasa nacional oficial de deserción universitaria; por eso no se muestra. MEDUCA advierte que parte de quienes figuran como desertores se trasladó a otro centro.</p>`;
  if(eduChartDes) eduChartDes.destroy();
  const colores=['#fbbf24','#f97316'];
  eduChartDes=new Chart(document.getElementById('c-edu-deser'),{type:'bar',
    data:{labels:EDU_NIVELES.map(x=>x[1]),datasets:anios.map((a,i)=>({label:'Año lectivo '+a,data:EDU_NIVELES.map(([n])=>serie(n).find(r=>r.periodo===a)?.nacional?.desertores?.Total??null),backgroundColor:colores[i%2],borderRadius:4}))},
    options:{...opcionesBase({sufijo:'%'}),scales:{...opcionesBase().scales,y:{...opcionesBase().scales.y,min:0}}}});
  ariaGrafico(eduChartDes,`Deserción escolar nacional ${anios[anios.length-1]||''}: ${EDU_NIVELES.map(([n,t])=>`${t.toLowerCase()} ${eduPct(serie(n).slice(-1)[0]?.nacional?.desertores?.Total,2)}`).join(', ')}.`);
  eduEnlazar('nivel',v=>{eduNivel=v; eduDesercion(D);});
  eduEnlazar('deser',v=>{eduSexo.deser=v; eduDesercion(D);});
}

IND_APLANAR['educacion.analfabetismo']=D=>(D.censo?.analfabetismo?.provincias||[]).flatMap(p=>SAL_SEXOS.map(([sx])=>({censo:2023,provincia:p.provincia,sexo:sx,tasa:p[sx]?.tasa,analfabetas:p[sx]?.analfabetas,tasa_2000:sx==='Total'?p['2000']:'',tasa_2010:sx==='Total'?p['2010']:'',fuente:D.censo?.url})));
IND_APLANAR['educacion.instruccion']=D=>Object.entries(D.censo?.instruccion||{}).flatMap(([l,v])=>Object.entries(v).map(([sx,d])=>({censo:2023,lugar:l,sexo:sx,...d,fuente:D.censo?.url})));
IND_APLANAR['educacion.universidad']=D=>(D.series?.universidad||[]).flatMap(u=>['matricula','graduados'].filter(k=>u[k]).flatMap(k=>u[k].sectores.map(s=>({anio:u.periodo,tipo:k,...s,fuente:u[k+'_cuadro']}))));
IND_APLANAR['educacion.desercion']=D=>EDU_NIVELES.flatMap(([n])=>(D.series?.['desercion_'+n]||[]).flatMap(r=>[r.nacional,...r.regiones].map(x=>({anio:r.periodo,nivel:n,region:x.region,matricula:x.matricula,aprobados_pct:x.aprobados,reprobados_pct:x.reprobados,desertores_pct:x.desertores.Total,desertores_hombres_pct:x.desertores.Hombres,desertores_mujeres_pct:x.desertores.Mujeres,fuente:r.url}))));
