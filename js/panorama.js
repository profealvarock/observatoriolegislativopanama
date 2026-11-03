// Observatorio Legislativo — Panorama de los proyectos de ley (pestaña Proyectos): indicadores principales,
// origen, lecturas clave y gasto estimado por proyecto (metodología de Costo Legislativo, calcCostos)
let _panoramaListo=false;

function kpiHTML(c,i,{pct=null,id}={}){
  return `<div class="kpi fade-in" style="--kc:${c.c};animation-delay:${i*.06}s">
    <div class="kpi-label">${c.l}</div>
    <div class="kpi-value${c.txt||c.fmt?' kpi-txt':''}" ${id?`id="${id}"`:''}>${c.txt||c.v==null?esc(c.v??'—'):'0'}</div>
    <div class="kpi-sub">${c.s||''}</div>
    ${pct!=null?`<div class="kpi-pct"><div class="kpi-pct-track"><div class="kpi-pct-fill" style="width:${pct}%"></div></div><div class="kpi-pct-lbl">${pct}%</div></div>`:''}
  </div>`;
}
// Pinta una fila de KPIs; los valores numéricos se animan con countUp y opcionalmente con un formato
function filaKPIs(id, cards, {conPct=false,total=0}={}){
  const cont=document.getElementById(id);
  cont.innerHTML=cards.map((c,i)=>kpiHTML(c,i,{pct:conPct&&total?+(100*c.v/total).toFixed(1):null,id:`${id}-v${i}`})).join('');
  cards.forEach((c,i)=>{
    if(c.txt||c.v==null) return;
    const el=document.getElementById(`${id}-v${i}`);
    if(c.fmt) el.textContent=c.fmt(c.v); else countUp(el,c.v,i*70);
  });
}

async function renderPanorama(){
  if(_panoramaListo||!PROY.length) return;
  _panoramaListo=true;
  const total=D.total_proyectos, leyes=D.total_leyes, pctTxt=(n,d)=>d?(100*n/d).toLocaleString('es-PA',{maximumFractionDigits:1})+'%':'—';
  document.getElementById('pan-corte').textContent=`Datos al ${fmtFechaCorte()}`;

  // ── Fila 1: indicadores principales ──
  const meses=Math.max(getTotalMonths(),1);
  const vots=(VOT?.votaciones||[]).filter(v=>v.tipo==='proyecto');
  const votados=new Set(vots.map(v=>v.proyecto)).size, unan=vots.filter(v=>v.unanime).length;
  const nov=await ensureNovedades().catch(()=>null), tl=nov?.tiempo_ley;
  filaKPIs('pan-kpis',[
    {l:'Proyectos presentados',v:total,s:`desde julio de 2024 · unos ${fmtNum(total/meses)} por mes`,c:'var(--acc)'},
    {l:'Ya son ley',v:leyes,s:`${pctTxt(leyes,total)} de los presentados`,c:'var(--st-ley)'},
    {l:'Votados en el pleno',v:votados,s:votados?`${fmtNum(vots.length)} debates · ${pctTxt(unan,vots.length)} unánimes`:'sin datos de votaciones',c:'var(--acc5)'},
    {l:'Tiempo hasta ser ley',v:tl?.n?tl.mediana:null,fmt:v=>`${fmtNum(v)} días`,s:tl?.n?`mediana · la mitad tarda entre ${fmtNum(tl.p25)} y ${fmtNum(tl.p75)} días`:'aún sin casos medidos',c:'var(--st-debate)'},
  ]);

  // ── Fila 2: origen (partición exacta del total) ──
  const otros=D.otros_proponentes||[], de=t=>otros.filter(o=>o.tipo===t);
  const suma=(l,k)=>l.reduce((a,o)=>a+(o[k]||0),0);
  const dips=D.diputados||[], nDip=suma(dips,'proyectos'), lDip=suma(dips,'leyes');
  const origen=[
    {l:'Diputados',v:nDip,ley:lDip,c:'var(--acc)'},
    {l:'Órgano Ejecutivo',v:suma(de('ejecutivo'),'proyectos'),ley:suma(de('ejecutivo'),'leyes'),c:'var(--acc5)'},
    {l:'Iniciativa ciudadana',v:suma(de('ciudadano'),'proyectos'),ley:suma(de('ciudadano'),'leyes'),c:'var(--acc2)'},
    {l:'Comisiones',v:suma(de('comision'),'proyectos'),ley:suma(de('comision'),'leyes'),c:'var(--acc3)'},
  ].map(o=>({...o,s:`${fmtNum(o.ley)} ya son ley (${pctTxt(o.ley,o.v)})`}));
  const sumaOrigen=origen.reduce((a,o)=>a+o.v,0);
  document.getElementById('pan-origen-sum').textContent=`${fmtNum(sumaOrigen)} de ${fmtNum(total)} proyectos · según el autor principal`;
  filaKPIs('pan-origen',origen,{conPct:true,total});

  // ── Fila 3: lecturas clave (clasificación temática y tipo de norma) ──
  const porTema={}, leyTema={};
  PROY.forEach(p=>{ const t=p._temas[0]; if(!t||t==='Otros') return; porTema[t]=(porTema[t]||0)+1; if(p.etapa==='Ley') leyTema[t]=(leyTema[t]||0)+1; });
  const temas=Object.keys(porTema).sort((a,b)=>porTema[b]-porTema[a]);
  const exito=temas.filter(t=>porTema[t]>=10).sort((a,b)=>(leyTema[b]||0)/porTema[b]-(leyTema[a]||0)/porTema[a])[0];
  const pt=D.por_tipo_norma||{}, tot=Object.values(pt).reduce((a,x)=>a+x.proyectos,0);
  filaKPIs('pan-lecturas',[
    {l:'Frente principal',v:temas[0]?temaCorto(temas[0]):'—',txt:true,s:temas[0]?`${fmtNum(porTema[temas[0]])} proyectos (${pctTxt(porTema[temas[0]],total)}) · le sigue ${temaCorto(temas[1]||'')}`:'',c:'var(--acc)'},
    {l:'El frente que más llega a ley',v:exito?temaCorto(exito):'—',txt:true,s:exito?`${pctTxt(leyTema[exito]||0,porTema[exito])} de sus ${fmtNum(porTema[exito])} proyectos ya son ley`:'',c:'var(--st-ley)'},
    {l:'Reforman una ley existente',v:pt.reforma?pctTxt(pt.reforma.proyectos,tot):'—',txt:true,s:pt.reforma?`${fmtNum(pt.reforma.proyectos)} proyectos · ${fmtNum(pt.nueva?.proyectos||0)} crean regulación nueva`:'',c:'var(--acc5)'},
    {l:'Declarativos o conmemorativos',v:pt.declarativa?pctTxt(pt.declarativa.proyectos,tot):'—',txt:true,s:pt.declarativa?`${fmtNum(pt.declarativa.proyectos)} proyectos: días, festivales, patrimonio y condecoraciones`:'',c:'var(--acc2)'},
  ]);

  // ── Gasto estimado por proyecto ──
  let C;
  try{ C=await ensureCostos(); }catch(e){ console.error('Costos:',e); }
  if(!C){ document.getElementById('pan-gasto-kpis').innerHTML='<div class="gs-empty" style="grid-column:1/-1">No se pudo calcular el gasto.</div>'; return; }
  renderGastoProyectos(C);
}

const fmtBalboas=v=>'B/. '+fmtNum(v);
const fmtBalboasCorto=v=>v>=1e6?'B/. '+(v/1e6).toLocaleString('es-PA',{maximumFractionDigits:1})+' M':v>=1e4?'B/. '+fmtNum(v/1000)+' mil':fmtBalboas(v);
const mediana=a=>{ const s=[...a].sort((x,y)=>x-y); return s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):0; };

function renderGastoProyectos(C){
  const porFicha=Object.fromEntries(C.proyectos.map(p=>[p.ficha,p]));
  const conCosto=PROY.filter(p=>porFicha[p.ficha]).map(p=>({...p,_costo:porFicha[p.ficha].costo,_firmas:porFicha[p.ficha].diputados}));
  const atribuido=conCosto.reduce((a,p)=>a+p._costo,0);
  const deLey=conCosto.filter(p=>p.etapa==='Ley'), gastoLey=deLey.reduce((a,p)=>a+p._costo,0);
  const pct=(n,d)=>d?Math.round(100*n/d):0;
  filaKPIs('pan-gasto-kpis',[
    {l:'Gasto atribuido a proyectos',v:atribuido,fmt:fmtBalboasCorto,s:`${(100*atribuido/(C.totalCost||1)).toLocaleString('es-PA',{maximumFractionDigits:1})}% del costo legislativo estimado (${fmtBalboasCorto(C.totalCost)})`,c:'var(--costo)'},
    {l:'Costo mediano por proyecto',v:mediana(conCosto.map(p=>p._costo)),fmt:fmtBalboas,s:`promedio ${fmtBalboas(atribuido/(conCosto.length||1))} · ${fmtNum(conCosto.length)} proyectos con diputados`,c:'var(--costo)'},
    {l:'Costo medio de un proyecto que llegó a ley',v:deLey.length?gastoLey/deLey.length:null,fmt:fmtBalboas,s:`${fmtNum(deLey.length)} leyes con participación de diputados`,c:'var(--st-ley)'},
    {l:'Gasto por cada ley lograda',v:deLey.length?atribuido/deLey.length:null,fmt:fmtBalboasCorto,s:'todo el gasto atribuido ÷ leyes logradas: incluye lo que no prosperó',c:'var(--acc4)'},
  ]);

  // Gasto por frente (tema principal)
  const porTema={};
  conCosto.forEach(p=>{ const t=p._temas[0]||'Otros'; const x=porTema[t]||(porTema[t]={g:0,n:0,ley:0}); x.g+=p._costo; x.n++; x.ley+=p.etapa==='Ley'; });
  const temas=Object.keys(porTema).sort((a,b)=>porTema[b].g-porTema[a].g);
  new Chart(document.getElementById('c-pan-gasto-tema'),{type:'bar',
    data:{labels:temas.map(temaCorto),datasets:[{label:'Gasto atribuido (B/.)',data:temas.map(t=>Math.round(porTema[t].g)),backgroundColor:'#f59e0b',borderRadius:4,borderSkipped:false,barThickness:13}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      onClick:(e,els)=>{ if(els.length) filtrarTema(temas[els[0].index]); },
      onHover:(e,els)=>{ e.native.target.style.cursor=els.length?'pointer':'default'; },
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,callbacks:{
        title:items=>temas[items[0].dataIndex],
        label:c=>{ const x=porTema[temas[c.dataIndex]]; return [` ${fmtBalboas(x.g)} (${pct(x.g,atribuido)}% del gasto atribuido)`,` ${x.n} proyectos · costo medio ${fmtBalboas(x.g/x.n)} · ${x.ley} ya son ley`]; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},callback:v=>fmtBalboasCorto(v)}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});

  // ¿En qué terminó el gasto? (grupos de etapa de la pestaña Proyectos)
  const GRUPOS=[['ley','Ya es ley','Ley'],['ejecutivo','Ante el Ejecutivo','Enviado al Ejecutivo'],['debate','En debate','Segundo Debate'],
    ['analisis','En análisis','Preliminar'],['sin','Sin avance','Archivado']];
  const grupoDe=e=>(GRUPOS.find(([k])=>GRUPO_ETAPA[k].includes(e))||[])[0];
  const porGrupo={};
  conCosto.forEach(p=>{ const g=grupoDe(p.etapa)||'otro'; const x=porGrupo[g]||(porGrupo[g]={g:0,n:0}); x.g+=p._costo; x.n++; });
  const grupos=GRUPOS.filter(([k])=>porGrupo[k]);
  new Chart(document.getElementById('c-pan-gasto-estado'),{type:'bar',
    data:{labels:grupos.map(g=>g[1]),datasets:[{label:'Gasto atribuido (B/.)',data:grupos.map(([k])=>Math.round(porGrupo[k].g)),
      backgroundColor:grupos.map(g=>etapaColor(g[2])),$etapas:true,borderRadius:4,borderSkipped:false,barThickness:16}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,callbacks:{
        label:c=>{ const x=porGrupo[grupos[c.dataIndex][0]]; return ` ${fmtBalboas(x.g)} (${pct(x.g,atribuido)}%) · ${x.n} proyectos`; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},callback:v=>fmtBalboasCorto(v)}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});

  // Costo medio por tipo de norma
  const porTipo={};
  conCosto.forEach(p=>{ const k=p._tipo||'nueva'; const x=porTipo[k]||(porTipo[k]={g:0,n:0}); x.g+=p._costo; x.n++; });
  const tipos=Object.keys(porTipo).filter(k=>porTipo[k].n>=3).sort((a,b)=>porTipo[b].g/porTipo[b].n-porTipo[a].g/porTipo[a].n);
  new Chart(document.getElementById('c-pan-gasto-tipo'),{type:'bar',
    data:{labels:tipos.map(tipoCorto),datasets:[{label:'Costo medio por proyecto (B/.)',data:tipos.map(k=>Math.round(porTipo[k].g/porTipo[k].n)),backgroundColor:'#f59e0b',borderRadius:4,borderSkipped:false,barThickness:16}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,callbacks:{
        title:items=>(D.tipos_norma||{})[tipos[items[0].dataIndex]]||'',
        label:c=>{ const x=porTipo[tipos[c.dataIndex]]; return ` costo medio ${fmtBalboas(x.g/x.n)} · ${x.n} proyectos · total ${fmtBalboasCorto(x.g)}`; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},callback:v=>fmtBalboasCorto(v)}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});

  // Los 6 proyectos con mayor costo estimado
  const top=[...conCosto].sort((a,b)=>b._costo-a._costo).slice(0,6), max=top[0]?._costo||1;
  document.getElementById('pan-top').innerHTML=top.map(p=>`<div class="pan-top-item">
      <div><a href="#proyecto=${esc(p.ficha)}">${esc((p.titulo||p.anteproyecto||'Sin título').slice(0,140))}</a>
        <small>Ficha ${esc(p.ficha)} · ${esc(temaCorto(p._temas[0]||''))} · ${fmtNum(p._firmas)} diputado${p._firmas===1?'':'s'} firmante${p._firmas===1?'':'s'} · <span class="badge ${etapaClass(p.etapa)}" style="padding:0 6px">${esc(p.etapa)}</span></small></div>
      <div class="pan-top-bar"><div style="width:${Math.round(100*p._costo/max)}%"></div></div>
      <div class="pan-top-v">${fmtBalboas(p._costo)}</div></div>`).join('')
    +`<p class="hist-note" style="margin-top:6px">Los proyectos más costosos suelen ser los que firman muchos diputados: cada firmante le aporta una porción de su costo de ese año.</p>`;
}
