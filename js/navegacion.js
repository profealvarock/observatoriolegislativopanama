// Observatorio Legislativo — Ficha (modal), buscador global, pestañas y enlaces directos (#pestaña, #diputado=, #comparar=, #proyecto=)
// ── MODAL ─────────────────────────────────────────
let _modalDep = null;
function showLeyes(idx){
  const dep = sortedDeps[idx];
  if(!dep) return;
  _modalDep = dep;
  document.getElementById('modal-title').textContent = dep.nombre;
  const leyes = dep.leyes_detalle || [];
  const todos = dep.proyectos_detalle || [];
  const hasTodos = todos.length > 0;
  document.getElementById('modal-tabs').style.display = '';
  document.getElementById('mtab-todos').style.display = hasTodos ? '' : 'none';
  document.getElementById('modal-sub').textContent = hasTodos
    ? `${todos.length} proyecto${todos.length>1?'s':''} · ${leyes.length} ley${leyes.length>1?'es':''}`
    : `${leyes.length} ley${leyes.length>1?'es':''} aprobada${leyes.length>1?'s':''}`;
  const temasDep=Object.keys(dep.temas_autor||{}).slice(0,3);
  if(temasDep.length) document.getElementById('modal-sub').textContent += ` · Temas: ${temasDep.join(', ')}`;
  switchModalTab(hasTodos ? 'todos' : 'leyes');
  document.getElementById('modal-link').classList.add('show');
  setHash('diputado='+depSlug(dep));
  document.getElementById('modal-overlay').classList.add('open');
  document.body.style.overflow='hidden';
  setTimeout(()=>document.querySelector('#modal-overlay .modal-close')?.focus(),60);
}
function showComisiones(idx){
  const dep = monitorSorted[idx];
  if(!dep) return;
  _modalDep = dep;
  const coms = dep.comisiones || [];
  document.getElementById('modal-title').textContent = dep.nombre;
  document.getElementById('modal-sub').textContent = `${coms.length} comisión${coms.length===1?'':'es'} registrada${coms.length===1?'':'s'}`;
  document.getElementById('modal-tabs').style.display = 'none';
  document.getElementById('modal-link').classList.remove('show');
  destroyModalChart();
  document.getElementById('modal-body').innerHTML = coms.length
    ? `<div class="comm-list">${coms.map(c=>`<div class="comm-item">${esc(c)}</div>`).join('')}</div>`
    : '<div class="gs-empty">Sin comisiones registradas en la fuente</div>';
  document.getElementById('modal-overlay').classList.add('open');
  document.body.style.overflow='hidden';
  setTimeout(()=>document.querySelector('#modal-overlay .modal-close')?.focus(),60);
}
function switchModalTab(tab){
  document.getElementById('mtab-todos').classList.toggle('active', tab==='todos');
  document.getElementById('mtab-leyes').classList.toggle('active', tab==='leyes');
  document.getElementById('mtab-hist').classList.toggle('active', tab==='hist');
  document.getElementById('mtab-red').classList.toggle('active', tab==='red');
  const dep = _modalDep;
  if(!dep) return;
  destroyModalChart();
  const body = document.getElementById('modal-body');
  if(tab==='todos'){
    const items = dep.proyectos_detalle || dep.leyes_detalle || [];
    body.innerHTML = items.length
      ? items.map(l=>`
        <div class="ley-item">
          <div class="ley-num">Ficha<br>${esc(l.ficha)}</div>
          <div class="ley-info">
            <div class="ley-titulo">${esc(l.titulo||'Sin título registrado')}</div>
            <div class="ley-meta">
              <span>📅 ${esc(l.fecha)}</span>
              ${l.etapa?`<span class="badge ${etapaClass(l.etapa)}" style="padding:1px 7px">${esc(l.etapa)}</span>`:''}
            </div>
          </div>
        </div>`).join('')
      : '<div class="gs-empty">Sin proyectos registrados</div>';
  } else if(tab==='leyes'){
    const leyes = dep.leyes_detalle || [];
    body.innerHTML = leyes.length
      ? leyes.map(l=>`
        <div class="ley-item">
          <div class="ley-num">Ficha<br>${esc(l.ficha)}</div>
          <div class="ley-info">
            <div class="ley-titulo">${esc(l.titulo||'Sin título registrado')}</div>
            <div class="ley-meta"><span>📅 ${esc(l.fecha)}</span></div>
          </div>
        </div>`).join('')
      : '<div class="gs-empty">Sin leyes aprobadas como proponente principal</div>';
  } else if(tab==='red'){
    renderAlianzas(dep);
  } else {
    renderModalHist(dep);
  }
}
function closeModal(e){
  if(e&&e.target!==document.getElementById('modal-overlay'))return;
  const overlay=document.getElementById('modal-overlay');
  if(!overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  document.body.style.overflow='';
  destroyModalChart();
  if(location.hash.startsWith('#diputado=')) setHash('diputados');
}
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){ closeModal(); gsClose(); return; }
  if(e.key==='Tab'){
    const overlay=document.getElementById('modal-overlay');
    if(overlay&&overlay.classList.contains('open')){
      const modal=overlay.querySelector('.modal');
      const focusable=[...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el=>!el.disabled&&el.offsetParent!==null);
      if(!focusable.length){e.preventDefault();return;}
      const first=focusable[0],last=focusable[focusable.length-1];
      if(e.shiftKey){if(document.activeElement===first){e.preventDefault();last.focus();}}
      else{if(document.activeElement===last){e.preventDefault();first.focus();}}
    }
  }
});

// ── GLOBAL SEARCH ─────────────────────────────────
function gsClose(){
  const drop=document.getElementById('gs-dropdown');
  const wrap=document.getElementById('gs-wrap');
  const inp=document.getElementById('global-search');
  if(drop){drop.innerHTML='';drop.classList.remove('open');}
  if(wrap)wrap.classList.remove('active');
  if(inp)inp.value='';
}
function gsInput(val){
  clearTimeout(gsTimeout);
  const wrap=document.getElementById('gs-wrap');
  const drop=document.getElementById('gs-dropdown');
  if(!val||val.length<2){drop.innerHTML='';drop.classList.remove('open');wrap.classList.remove('active');return;}
  wrap.classList.add('active');
  gsTimeout=setTimeout(()=>{
    if(!D){drop.innerHTML='<div class="gs-empty">Cargando datos…</div>';drop.classList.add('open');return;}
    const ql=val.toLowerCase();
    const deps=(D.diputados||[]).filter(d=>d.nombre.toLowerCase().includes(ql)||(d.partido||'').toLowerCase().includes(ql)||(d.provincia||'').toLowerCase().includes(ql)).slice(0,5);
    const parties=Object.keys(D.por_partido||{}).filter(p=>p.toLowerCase().includes(ql)).slice(0,3);
    const otros=(D.otros_proponentes||[]).filter(o=>o.nombre.toLowerCase().includes(ql)).slice(0,3);
    if(!deps.length&&!parties.length&&!otros.length){
      drop.innerHTML=`<div class="gs-empty">Sin resultados para "${esc(val)}"</div>`;
      drop.classList.add('open');return;
    }
    // Se escapa el texto primero y luego se resalta la coincidencia (también escapada)
    const re=new RegExp('('+esc(val).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi');
    const hl=t=>esc(t).replace(re,'<mark>$1</mark>');
    let html='';
    if(deps.length){
      html+='<div class="gs-group">Diputados</div>';
      html+=deps.map(d=>`<div class="gs-item" data-name="${esc(d.nombre)}" onclick="gsGo('dep',this.dataset.name)">
        ${d.foto?`<img class="gs-avatar" src="${safeUrl(d.foto)}" alt="" onerror="this.style.display='none'">`:''}<div><div class="gs-name">${hl(d.nombre)}</div><div class="gs-sub">${esc(d.partido||'')} · ${esc(d.provincia||'')}</div></div></div>`).join('');
    }
    if(parties.length){
      html+='<div class="gs-group">Partidos</div>';
      html+=parties.map(p=>`<div class="gs-item" onclick="gsGo('partido','')"><div><div class="gs-name">${hl(p)}</div><div class="gs-sub">${(D.por_partido[p]||{}).proyectos||0} proyectos</div></div></div>`).join('');
    }
    if(otros.length){
      html+='<div class="gs-group">Otros Proponentes</div>';
      html+=otros.map(o=>`<div class="gs-item" onclick="gsGo('proponente','')"><div><div class="gs-name">${hl(o.nombre)}</div><div class="gs-sub">${fmtNum(o.proyectos)} proyecto${o.proyectos>1?'s':''}</div></div></div>`).join('');
    }
    drop.innerHTML=html;drop.classList.add('open');
  },180);
}
function gsGo(type,val){
  gsClose();
  if(type==='dep'){
    showTab('diputados');
    const s=document.getElementById('search');
    if(s){s.value=val;buildFiltered();page=1;viewMode==='grid'?renderGrid():renderTable();}
  }else if(type==='partido'){ showTab('partidos'); }
  else{ showTab('proponentes'); }
}
document.addEventListener('click',e=>{
  const wrap=document.getElementById('gs-wrap');
  if(wrap&&!wrap.contains(e.target))gsClose();
});

const ORDEN_ETAPAS=Object.keys(ETAPA_COLOR);
const ordenEtapa=e=>{ const i=ORDEN_ETAPAS.indexOf(e); return i<0?99:i; };

// Texto legible sobre una barra de color (tinta oscura sobre colores claros)
function tintaSobre(hex){
  const n=parseInt(hex.slice(1),16), r=(n>>16)&255, g=(n>>8)&255, b=n&255;
  return (0.2126*r+0.7152*g+0.0722*b)/255 > 0.6 ? '#0b1220' : '#ffffff';
}

function renderFunnel(){
  const order=['Preliminar','Enviado a subcomisión para analisis','Primer Debate','Segundo Debate','Tercer Debate','Enviado al Ejecutivo','Objetado por Ejecutivo','Ley','Negado','Archivado','Retirado por proponente'];
  const theme=currentTheme();
  document.getElementById('funnel').innerHTML=order.map(e=>{
    const n=D.etapas[e]||0;if(!n)return'';
    const pct=(n/D.total_proyectos*100).toFixed(0);
    const lbl=e.length>26?e.slice(0,24)+'…':e;
    const col=etapaColor(e,theme);
    return`<div class="f-row"><div class="f-lbl" title="${esc(e)}">${esc(lbl)}</div><div class="f-wrap"><div class="f-bar" style="width:${Math.max(pct,3)}%;background:${col};color:${tintaSobre(col)}">${n}</div></div></div>`;
  }).join('');
}

// Los partidos no tienen color propio: el observatorio los trata a todos igual (identidad por
// nombre), y así ninguno queda asociado al color de la marca ni a los de éxito o alerta.

function etapaClass(e){
  e=e||'';
  if(e==='Ley')return 'etapa-ley';
  if(e==='Negado')return 'etapa-neg';
  if(e.includes('Objetado'))return 'etapa-obj';
  if(e.includes('Ejecutivo'))return 'etapa-ejec';
  if(e.includes('Debate'))return 'etapa-deb';
  if(e==='Preliminar'||e==='Prohijado'||e.includes('subcomisión'))return 'etapa-pre';
  if(e.includes('Archivado')||e.includes('Retirado')||e.includes('Suspendido'))return 'etapa-arch';
  return 'etapa-otro';
}

function countUp(el, target, delay=0){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    setTimeout(()=>{el.textContent=fmtNum(target);},delay);
    return;
  }
  const dur=window.innerWidth<640?450:900;
  setTimeout(()=>{
    const start=performance.now();
    const tick=now=>{
      const t=Math.min((now-start)/dur,1);
      const ease=1-Math.pow(1-t,3);
      el.textContent=fmtNum(target*ease);
      if(t<1)requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, delay);
}

// ── TABS ──────────────────────────────────────────
const TABS=['general','novedades','diputados','proyectos','monitoreo','partidos','proponentes','costos','metodologia'];

// Pestañas accesibles: roles ARIA y navegación con flechas, Inicio y Fin (patrón WAI-ARIA)
(function initTabsA11y(){
  const btns=[...document.querySelectorAll('.tabs .tab')];
  btns.forEach((b,i)=>{
    const name=TABS[i], panel=document.getElementById('tab-'+name);
    b.id='tabbtn-'+name; b.setAttribute('role','tab'); b.setAttribute('aria-controls','tab-'+name);
    b.setAttribute('aria-selected',b.classList.contains('active')?'true':'false');
    b.tabIndex=b.classList.contains('active')?0:-1;
    if(panel){ panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby','tabbtn-'+name); panel.tabIndex=-1; }
    b.addEventListener('keydown',e=>{
      const k={ArrowRight:1,ArrowLeft:-1,Home:'ini',End:'fin'}[e.key];
      if(k===undefined) return;
      e.preventDefault();
      const j=k==='ini'?0:k==='fin'?btns.length-1:(i+k+btns.length)%btns.length;
      showTab(TABS[j]); btns[j].focus();
    });
  });
})();

function showTab(name){
  if(!TABS.includes(name)) name='general';
  document.querySelectorAll('.tab').forEach((t,i)=>{
    const on=TABS[i]===name;
    t.classList.toggle('active',on); t.setAttribute('aria-selected',on?'true':'false'); t.tabIndex=on?0:-1;
  });
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  // La pestaña queda en la URL (#costos, #monitoreo…) para poder compartirla
  const h=location.hash.slice(1);
  if(!((name==='diputados'&&/^(diputado|comparar)=/.test(h))||(name==='proyectos'&&/^proyecto=/.test(h)))) setHash(name==='general'?'':name);
  if(!D) return;
  if(name==='general'&&!tabInited.general){try{renderGeneral();}catch(e){console.error('General:',e)}tabInited.general=true}
  if(name==='diputados'){try{initTable();}catch(e){console.error('Table:',e)}}
  if(name==='monitoreo'&&!tabInited.monitoreo){try{initMonitor();}catch(e){console.error('Monitoreo:',e)}tabInited.monitoreo=true}
  if(name==='partidos'&&!tabInited.partidos){try{renderPartidos();}catch(e){console.error('Partidos:',e)}tabInited.partidos=true}
  if(name==='proponentes'&&!tabInited.proponentes){try{renderProponentes();}catch(e){console.error('Proponentes:',e)}tabInited.proponentes=true}
  if(name==='costos'&&!tabInited.costos){loadDatosRawAndRender();tabInited.costos=true;}
  if(name==='metodologia'){try{renderMetodologia();}catch(e){console.error('Metodología:',e)}}
  if(name==='proyectos'){initProyectos();}
  if(name==='novedades'){initNovedades();}
}

// ── ENLACES DIRECTOS ──────────────────────────────
// #costos · #diputado=<slug> · #comparar=<slug>,<slug>[,<slug>]
function setHash(h){
  if(location.hash.slice(1)===h) return;
  history.replaceState(null,'',h ? '#'+h : location.pathname+location.search);
}
function routeFromHash(){
  if(!D) return;
  const h=decodeURIComponent(location.hash.slice(1));
  if(h.startsWith('diputado=')) return openDiputado(h.slice(9));
  closeModal();
  if(h.startsWith('comparar=')) return openComparar(h.slice(9).split(',').filter(Boolean));
  if(h.startsWith('proyecto=')){
    showTab('proyectos');
    const q=document.getElementById('proy-q'); if(q) q.value=h.slice(9);
    return initProyectos();
  }
  showTab(h);
}
window.addEventListener('hashchange', routeFromHash);

function openDiputado(slug){
  const dep=(D.diputados||[]).find(d=>depSlug(d)===slug);
  showTab('diputados');
  if(!dep) return;
  const s=document.getElementById('search');
  if(s) s.value=dep.nombre;
  buildFiltered(); page=1;
  viewMode==='grid' ? renderGrid() : renderTable();
  const idx=sortedDeps.findIndex(d=>d.nombre===dep.nombre);
  if(idx>=0) showLeyes(idx);
}

async function copyLink(btn, url=location.href){
  const orig=btn.textContent;
  try{ await navigator.clipboard.writeText(url); btn.textContent='✓ Copiado'; }
  catch(e){ window.prompt('Copia este enlace:', url); }
  setTimeout(()=>{ btn.textContent=orig; },1600);
}

