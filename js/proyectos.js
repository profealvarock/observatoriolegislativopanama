// Observatorio Legislativo — Pestaña Proyectos (buscador y temas) y mapas de calor de redes y temas
// ── PROYECTOS ─────────────────────────────────────
const GRUPO_ETAPA={
  analisis:['Preliminar','Prohijado','Enviado a subcomisión para analisis'],
  debate:['Primer Debate','Segundo Debate','Tercer Debate'],
  ejecutivo:['Enviado al Ejecutivo','Objetado por Ejecutivo','Segundo Debate(Objetado)','Tercer Debate(Objetado)'],
  ley:['Ley'],
  sin:['Archivado','Negado','Retirado por proponente','Suspendido'],
};
const PROY_PAGINA=20;
// Nombres cortos de temas y tipos de norma para los ejes de los gráficos (temas_meta, de temas_cap.py)
const temaCorto=t=>D?.temas_meta?.cortos?.[t]||t;
const tipoCorto=k=>D?.temas_meta?.tipos_cortos?.[k]||(D?.tipos_norma||{})[k]||k;
let PROY=[], proyFiltrados=[], proyMostrados=0, _proyListo=null, _proyT=null, ETAPAS_H=null;
const sinTildes=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fechaOrden=f=>{ const [d,m,y]=String(f||'').split('-'); return y ? +(y+m+d) : 0; };

// Expresión que encuentra una palabra con o sin tildes (para resaltar coincidencias)
function reSinTildes(w){
  const cls={a:'[aáàä]',e:'[eéèë]',i:'[iíìï]',o:'[oóòö]',u:'[uúùü]',n:'[nñ]'};
  return w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/[aeioun]/g,c=>cls[c]);
}

function prepararProyectos(){
  if(!_proyListo){
    _proyListo=Promise.all([ensureDatosRaw(), ensureEtapas(), ensureVotaciones()]).then(([,H])=>{
      ETAPAS_H=H;
      const autorPorFicha={};
      (D.diputados||[]).forEach(d=>(d.proyectos_detalle||[]).forEach(p=>{ autorPorFicha[p.ficha]=d; }));
      const temas=D.temas||[], tpf=D.temas_por_ficha||{};
      PROY=DATOS_RAW.map(r=>{
        const firmantes=String(r.proponente||'').split(',').map(s=>s.trim()).filter(Boolean);
        return {...r, _temas:(tpf[r.ficha]||[]).map(i=>temas[i]).filter(Boolean), _tipo:(D.tipo_por_ficha||{})[r.ficha]||'', _autor:autorPorFicha[r.ficha]||null,
          _primero:(firmantes[0]||'').replace(/^H\.D\.?S?\s+/i,''), _firmantes:firmantes,
          _orden:fechaOrden(r.fecha_presentacion), _busca:sinTildes(`${r.titulo} ${r.ficha} ${r.proponente}`)};
      });
      const anios=[...new Set(PROY.map(p=>String(p.fecha_presentacion||'').split('-')[2]).filter(Boolean))].sort().reverse();
      document.getElementById('proy-anio').insertAdjacentHTML('beforeend',anios.map(a=>`<option>${esc(a)}</option>`).join(''));
      document.getElementById('proy-tema').insertAdjacentHTML('beforeend',temas.map(t=>`<option>${esc(t)}</option>`).join(''));
      document.getElementById('proy-tipo').insertAdjacentHTML('beforeend',Object.entries(D.tipos_norma||{}).map(([k,n])=>`<option value="${esc(k)}">${esc(n)}</option>`).join(''));
      renderTemasChart();
      renderHeatTemas();
      try{ renderFrentes(); }catch(e){ console.error('Frentes legislativos:',e); }
      try{ renderTemasLey(); }catch(e){ console.error('Temas que llegan a ley:',e); }
      try{ renderTipoNorma(); }catch(e){ console.error('Tipo de norma:',e); }
    }).catch(e=>{ _proyListo=null; throw e; });
  }
  return _proyListo;
}

async function initProyectos(){
  if(!D) return;
  try{ await prepararProyectos(); }
  catch(e){ document.getElementById('proy-lista').innerHTML=`<div class="loader">⚠️ No se pudieron cargar los proyectos: ${esc(e.message)}</div>`; return; }
  aplicarFiltroProyectos();
}

function filtrarProyectos(){ clearTimeout(_proyT); _proyT=setTimeout(aplicarFiltroProyectos,120); }

function aplicarFiltroProyectos(){
  if(!PROY.length) return;
  const val=id=>document.getElementById(id).value;
  const palabras=sinTildes(val('proy-q').trim()).split(/\s+/).filter(Boolean);
  const grupo=val('proy-etapa') ? new Set(GRUPO_ETAPA[val('proy-etapa')]) : null;
  const anio=val('proy-anio'), tema=val('proy-tema'), tipo=val('proy-tipo'), orden=val('proy-orden');
  proyFiltrados=PROY.filter(p=>(!grupo||grupo.has(p.etapa)) && (!anio||String(p.fecha_presentacion).endsWith('-'+anio))
    && (!tema||p._temas.includes(tema)) && (!tipo||p._tipo===tipo) && palabras.every(w=>p._busca.includes(w)));
  const cmp={reciente:(a,b)=>b._orden-a._orden||b.ficha-a.ficha, antiguo:(a,b)=>a._orden-b._orden||a.ficha-b.ficha,
    firmas:(a,b)=>b._firmantes.length-a._firmantes.length||b._orden-a._orden}[orden];
  proyFiltrados.sort(cmp);
  const leyes=proyFiltrados.filter(p=>p.etapa==='Ley').length, n=proyFiltrados.length;
  document.getElementById('proy-resumen').innerHTML = n
    ? `<b>${fmtNum(n)}</b> proyecto${n===1?'':'s'} · <b>${fmtNum(leyes)}</b> ley${leyes===1?'':'es'} (${(100*leyes/n).toFixed(1)}%)`
    : 'Ningún proyecto coincide con la búsqueda.';
  proyMostrados=0;
  document.getElementById('proy-lista').innerHTML='';
  masProyectos();
}

function masProyectos(){
  const palabras=sinTildes(document.getElementById('proy-q').value.trim()).split(/\s+/).filter(w=>w.length>1);
  const re=palabras.length ? new RegExp('('+palabras.map(reSinTildes).join('|')+')','gi') : null;
  const hl=t=>re ? esc(t).replace(re,'<mark>$1</mark>') : esc(t);
  const lote=proyFiltrados.slice(proyMostrados, proyMostrados+PROY_PAGINA);
  document.getElementById('proy-lista').insertAdjacentHTML('beforeend', lote.map(p=>{
    const autor=p._autor
      ? `<a href="#diputado=${esc(depSlug(p._autor))}">${esc(p._autor.nombre)}</a>`
      : esc(p._primero||'—');
    const temas=p._temas.filter(t=>t!=='Otros').map((t,i)=>`<button type="button" class="tema-chip${i===0?' principal':''}" data-tema="${esc(t)}" title="${i===0?'Tema principal':'Tema secundario'}" onclick="filtrarTema(this.dataset.tema)">${esc(t)}</button>`).join(' ')
      +(p._tipo?` <span class="tipo-norma">${esc((D.tipos_norma||{})[p._tipo]||'')}</span>`:'');
    return `<article class="proy-item">
      <div class="proy-top"><span>Ficha ${esc(p.ficha)}</span><span>📅 ${esc(p.fecha_presentacion)}</span>
        <span class="badge ${etapaClass(p.etapa)}">${esc(p.etapa)}</span>
        <a href="#proyecto=${esc(p.ficha)}" title="Enlace directo a este proyecto" style="color:var(--muted);text-decoration:none">🔗</a></div>
      <div class="proy-titulo">${hl(p.titulo||p.anteproyecto||'Sin título registrado')}</div>
      <div class="proy-meta"><span>Autor principal: ${autor}</span>${temas?`<span>${temas}</span>`:''}
        ${p._firmantes.length>1?`<details class="proy-firmas"><summary>${p._firmantes.length} firmantes</summary><p>${esc(p._firmantes.join(' · '))}</p></details>`:''}
        ${historialEtapasHTML(p.ficha, ETAPAS_H)}${comoSeVotoHTML(p.ficha)}</div>
    </article>`;
  }).join(''));
  proyMostrados+=lote.length;
  const btn=document.getElementById('proy-mas');
  btn.style.display=proyMostrados<proyFiltrados.length?'':'none';
  btn.textContent=`Mostrar más (${fmtNum(proyFiltrados.length-proyMostrados)} restantes)`;
}

function filtrarTema(t){
  const sel=document.getElementById('proy-tema');
  sel.value=t; aplicarFiltroProyectos();
  document.querySelector('.proy-filtros').scrollIntoView({behavior:'smooth',block:'start'});
}

function renderTemasChart(){
  const pt=D.por_tema||{}, canvas=document.getElementById('c-temas');
  if(!canvas || !Object.keys(pt).length) return;
  const temas=Object.keys(pt).filter(t=>pt[t].proyectos>0).sort((a,b)=>t2(a,b));
  function t2(a,b){ return (a==='Otros')-(b==='Otros') || pt[b].proyectos-pt[a].proyectos; }
  new Chart(canvas,{type:'bar',
    data:{labels:temas.map(temaCorto),datasets:[{label:'Proyectos',data:temas.map(t=>pt[t].proyectos),backgroundColor:'#3b82f6',borderRadius:4,borderSkipped:false,barThickness:16}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      onClick:(e,els)=>{ if(els.length) filtrarTema(temas[els[0].index]); },
      onHover:(e,els)=>{ e.native.target.style.cursor=els.length?'pointer':'default'; },
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
        callbacks:{title:items=>temas[items[0].dataIndex],label:c=>{ const v=pt[temas[c.dataIndex]]; return ` ${v.proyectos} proyectos · ${v.leyes} leyes (${(100*v.leyes/v.proyectos).toFixed(0)}%)`; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},precision:0}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});
}

// ── FRENTES LEGISLATIVOS (clasificación CAP: tema principal = primer tema de cada ficha) ──
const semestreDe=f=>{ const [,m,y]=String(f||'').split('-'); return y ? `${y}-S${+m<=6?1:2}` : null; };
const fmtSemestre=s=>{ const [y,h]=s.split('-'); return (h==='S1'?'ene–jun ':'jul–dic ')+y; };
function renderFrentes(){
  const cont=document.getElementById('heat-frentes');
  if(!cont||!PROY.length) return;
  const cuenta={}, sems=new Set();
  PROY.forEach(p=>{ const s=semestreDe(p.fecha_presentacion), t=p._temas[0]; if(!s||!t) return; sems.add(s); (cuenta[t]=cuenta[t]||{})[s]=(cuenta[t][s]||0)+1; });
  const cols=[...sems].sort(), total=t=>Object.values(cuenta[t]||{}).reduce((a,b)=>a+b,0);
  const filas=(D.temas||[]).filter(t=>t!=='Otros'&&total(t)).sort((a,b)=>total(b)-total(a));
  const max=Math.max(...filas.flatMap(t=>cols.map(s=>cuenta[t][s]||0)),1);
  const totSem=s=>filas.reduce((a,t)=>a+(cuenta[t][s]||0),0);
  const celda=(v,tit)=>{
    if(!v) return `<td class="vacio" title="${esc(tit)}">0</td>`;
    const pct=Math.round(8+82*v/max);
    return `<td title="${esc(tit)}" style="background:color-mix(in srgb,var(--acc) ${pct}%,transparent);color:${pct>50?'#fff':'var(--text)'}">${fmtNum(v)}</td>`;
  };
  cont.innerHTML=`<table class="heat"><thead><tr><th scope="col">Tema principal</th>${cols.map(s=>`<th scope="col">${esc(fmtSemestre(s))}</th>`).join('')}<th scope="col">Total</th></tr></thead>
    <tbody>${filas.map(t=>`<tr><th scope="row"><button type="button" class="vot-art-btn" data-tema="${esc(t)}" onclick="filtrarTema(this.dataset.tema)">${esc(t)}</button></th>${cols.map(s=>celda(cuenta[t][s]||0,`${t}: ${cuenta[t][s]||0} proyectos en ${fmtSemestre(s)} (${Math.round(100*(cuenta[t][s]||0)/(totSem(s)||1))}% del semestre)`)).join('')}<td class="vacio">${fmtNum(total(t))}</td></tr>`).join('')}</tbody></table>`
    +leyendaCalor('el número es la cantidad de proyectos presentados; el semestre en curso está incompleto');
}

function renderTemasLey(){
  const canvas=document.getElementById('c-temas-ley');
  if(!canvas||!PROY.length) return;
  const n={}, ley={};
  PROY.forEach(p=>{ const t=p._temas[0]; if(!t||t==='Otros') return; n[t]=(n[t]||0)+1; if(p.etapa==='Ley') ley[t]=(ley[t]||0)+1; });
  const temas=Object.keys(n).filter(t=>n[t]>=5).sort((a,b)=>(ley[b]||0)/n[b]-(ley[a]||0)/n[a]);
  new Chart(canvas,{type:'bar',
    data:{labels:temas.map(temaCorto),datasets:[{label:'Ya son ley (%)',data:temas.map(t=>Math.round(1000*(ley[t]||0)/n[t])/10),backgroundColor:etapaColor('Ley'),$etapas:true,borderRadius:4,borderSkipped:false,barThickness:14}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      onClick:(e,els)=>{ if(els.length) filtrarTema(temas[els[0].index]); },
      onHover:(e,els)=>{ e.native.target.style.cursor=els.length?'pointer':'default'; },
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
        callbacks:{title:items=>temas[items[0].dataIndex],label:c=>{ const t=temas[c.dataIndex]; return ` ${ley[t]||0} de ${n[t]} proyectos ya son ley (${c.raw}%)`; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},callback:v=>v+'%'}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});
}

function renderTipoNorma(){
  const canvas=document.getElementById('c-tipo-norma'), pt=D.por_tipo_norma||{}, nombres=D.tipos_norma||{};
  if(!canvas||!Object.keys(pt).length) return;
  const tipos=Object.keys(pt).filter(k=>pt[k].proyectos).sort((a,b)=>pt[b].proyectos-pt[a].proyectos);
  const total=tipos.reduce((a,k)=>a+pt[k].proyectos,0);
  new Chart(canvas,{type:'bar',
    data:{labels:tipos.map(tipoCorto),datasets:[{label:'Proyectos',data:tipos.map(k=>pt[k].proyectos),backgroundColor:'#a78bfa',borderRadius:4,borderSkipped:false,barThickness:18}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,
      onClick:(e,els)=>{ if(!els.length) return; document.getElementById('proy-tipo').value=tipos[els[0].index]; aplicarFiltroProyectos(); document.querySelector('.proy-filtros').scrollIntoView({behavior:'smooth',block:'start'}); },
      onHover:(e,els)=>{ e.native.target.style.cursor=els.length?'pointer':'default'; },
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#0e1623',borderColor:'#1a2940',borderWidth:1,
        callbacks:{title:items=>nombres[tipos[items[0].dataIndex]]||'',label:c=>{ const v=pt[tipos[c.dataIndex]]; return ` ${v.proyectos} proyectos (${Math.round(100*v.proyectos/total)}%) · ${v.leyes} ya son ley (${Math.round(100*v.leyes/v.proyectos)}%)`; }}}},
      scales:{x:{beginAtZero:true,grid:{color:'rgba(255,255,255,.03)'},ticks:{color:'#7a8fb0',font:{family:'DM Mono',size:10},precision:0}},
        y:{grid:{display:false},ticks:{color:'#94a3b8',font:{family:'DM Mono',size:10}}}}}});
  const ref=pt.reforma, tra=pt.tratado;
  document.getElementById('tipo-norma-nota').innerHTML=ref
    ? `<b>${Math.round(100*ref.proyectos/total)}%</b> de los proyectos reforma una ley que ya existe.`
      +(tra?.proyectos?` Los tratados son los que más llegan a ley (${Math.round(100*tra.leyes/tra.proyectos)}%): los presenta el Ejecutivo y la Asamblea solo los aprueba o rechaza.`:'')+' Toca una barra para filtrar.'
    : '';
}

function exportProyectosFiltrados(btn){
  withBtn(btn, async ()=>{
    await prepararProyectos();
    if(!proyFiltrados.length) aplicarFiltroProyectos();
    downloadCSV('proyectos_filtrados', [
      ['Ficha',p=>p.ficha], ['Fecha de presentación',p=>p.fecha_presentacion], ['Título',p=>p.titulo], ['Etapa',p=>p.etapa],
      ['Tema principal',p=>p._temas[0]||''], ['Tema secundario',p=>p._temas[1]||''], ['Tipo de norma',p=>(D.tipos_norma||{})[p._tipo]||''], ['Autor principal',p=>p._autor?.nombre||p._primero], ['Nº firmantes',p=>p._firmantes.length],
      ['Proponentes',p=>p.proponente],
    ], proyFiltrados);
  });
}

// ── REDES Y TEMAS POR GRUPO (mapas de calor) ──────
const PARTIDO_CORTO={
  'Coalición Vamos':'Vamos','Partido Revolucionario Democrático':'PRD','Partido Panameñista':'Panameñista',
  'Realizando Metas':'RM','Movimiento Otro Camino':'MOCA','Cambio Democrático':'CD','Partido Popular':'PP',
  'Partido Alianza':'Alianza','Movimiento Liberal Republicano Nacionalista':'Molirena',
  'Libre Postulación':'Libre post.','Libre Postulación | Seguimos':'Libre post. (Seguimos)',
};
const corto=p=>PARTIDO_CORTO[p]||p;

// Celda de mapa de calor: un solo tono (escala secuencial) y el valor escrito, nunca solo color
function celdaCalor(v, max, titulo, extra=''){
  if(!v) return `<td class="vacio ${extra}" title="${esc(titulo)}">0</td>`;
  const pct=Math.round(8+82*v/max);
  return `<td class="${extra}" title="${esc(titulo)}" style="background:color-mix(in srgb,var(--acc) ${pct}%,transparent);color:${pct>50?'#fff':'var(--text)'}">${fmtNum(v)}%</td>`;
}
const leyendaCalor=txt=>`<div class="heat-leyenda"><span>menos</span><span class="barra"></span><span>más</span><span>· ${txt}</span></div>`;

function renderHeatRed(){
  const red=D.red_partidos||{}, cont=document.getElementById('heat-red');
  if(!cont) return;
  const tot=p=>Object.values(red[p]||{}).reduce((a,b)=>a+b,0);
  const filas=Object.keys(red).filter(p=>tot(p)>=20).sort((a,b)=>tot(b)-tot(a));
  // Columnas: mismos partidos que las filas (así la diagonal es "su propio partido") y luego el resto
  const cols=filas.concat([...new Set(Object.values(red).flatMap(Object.keys))].filter(p=>!filas.includes(p)).sort());
  const pct=(a,b)=>tot(a)?Math.round(100*(red[a]?.[b]||0)/tot(a)):0;
  const max=Math.max(...filas.flatMap(a=>cols.map(b=>pct(a,b))),1);
  cont.innerHTML=`<table class="heat"><thead><tr><th scope="col">Autor ↓ · co-firmantes →</th>${cols.map(c=>`<th scope="col" title="${esc(c)}">${esc(corto(c))}</th>`).join('')}</tr></thead>
    <tbody>${filas.map(a=>`<tr><th scope="row" title="${esc(a)} · ${fmtNum(tot(a))} co-firmas">${esc(corto(a))}</th>${
      cols.map(b=>celdaCalor(pct(a,b),max,`Proyectos de ${a}: ${pct(a,b)}% de sus co-firmas vienen de ${b} (${red[a]?.[b]||0})`,a===b?'propio':'')).join('')
    }</tr>`).join('')}</tbody></table>`+leyendaCalor('se muestran los partidos con al menos 20 co-firmas recibidas');
}

function renderHeatTemas(){
  const por=document.getElementById('heat-temas-por')?.value||'partido';
  const datos=por==='partido'?D.temas_por_partido:D.temas_por_provincia, base=por==='partido'?D.por_partido:D.por_provincia;
  const cont=document.getElementById('heat-temas');
  if(!cont||!datos) return;
  const grupos=Object.keys(datos).filter(g=>(base[g]?.proyectos||0)>=5).sort((a,b)=>(base[b]?.proyectos||0)-(base[a]?.proyectos||0));
  const temas=(D.temas||[]).filter(t=>t!=='Otros');
  const pct=(g,t)=>Math.round(100*(datos[g]?.[t]||0)/(base[g]?.proyectos||1));
  const max=Math.max(...temas.flatMap(t=>grupos.map(g=>pct(g,t))),1);
  cont.innerHTML=`<table class="heat"><thead><tr><th scope="col">Tema</th>${grupos.map(g=>`<th scope="col" title="${esc(g)} · ${base[g]?.proyectos} proyectos">${esc(por==='partido'?corto(g):g)}</th>`).join('')}</tr></thead>
    <tbody>${temas.map(t=>`<tr><th scope="row">${esc(t)}</th>${grupos.map(g=>celdaCalor(pct(g,t),max,`${g}: ${datos[g]?.[t]||0} de ${base[g]?.proyectos} proyectos (${pct(g,t)}%) sobre ${t}`)).join('')}</tr>`).join('')}</tbody></table>`
    +leyendaCalor(`se muestran los grupos con al menos 5 proyectos propuestos`);
}

function renderAlianzas(dep){
  const al=dep.aliados||[], body=document.getElementById('modal-body');
  if(!al.length){ body.innerHTML='<div class="gs-empty">Sin co-firmas registradas con otros diputados.</div>'; return; }
  const max=al[0].proyectos||1;
  const t=dep.transversalidad, te=dep.transversalidad_esperada, dif=t!=null&&te!=null?t-te:null;
  const lectura=dif==null?'':dif<=-10?'firma <b>bastante más con su propio partido</b> de lo que se esperaría':dif>=10?'firma <b>más con otros partidos</b> de lo que se esperaría':'firma con otros partidos <b>en la proporción esperada</b>';
  body.innerHTML=`<p class="hist-note" style="margin-top:12px">Diputados con los que más proyectos ha firmado (como autor o co-patrocinador):</p>
    <div class="ali-list">${al.map(a=>{
      const otro=(D.diputados||[]).find(d=>d.nombre===a.nombre);
      return `<div class="ali-row"><div>${otro?`<a href="#diputado=${esc(depSlug(otro))}">${esc(a.nombre)}</a>`:esc(a.nombre)}<small>${esc(a.partido)}</small></div>
        <div class="ali-bar"><div style="width:${Math.round(100*a.proyectos/max)}%"></div></div><div style="text-align:right">${a.proyectos}</div></div>`;
    }).join('')}</div>
    ${t!=null?`<div class="ali-trans"><b>${fmtNum(t)}%</b> de sus co-firmas son con diputados de otros partidos. Si firmara al azar, por el tamaño de su partido sería cerca de <b>${fmtNum(te)}%</b>: ${lectura}.</div>`:''}`;
}

