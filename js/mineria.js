// Observatorio Ciudadano — Pestaña ⛏️ Minería: mina Cobre Panamá, opinión pública, economía y concesiones
// (data/mineria.json) y lo que la Asamblea ha tramitado sobre minería (datos.json y votaciones.json, en vivo).
let minInited=false;

const MIN_ENCUESTADORA = { vea:'Vea Panamá', cid:'CID Gallup', doxa:'Doxa' };

async function initMineria(){
  if(minInited) return;
  minInited=true;
  const root=document.getElementById('min-root');
  let D;
  try{ D=await cargarIndicador('mineria'); }
  catch(e){ minInited=false; return errorIndicador(root,e); }
  const fh=D.fecha_corte, m=id=>metricaPorId(D,id);
  const ref=(D.series?.referendo||[]).slice(-1)[0];
  const est=D.estado||{};

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Minería',
      desc:'La mina Cobre Panamá, lo que opina la población, su peso en la economía, las concesiones y lo que la Asamblea ha tramitado sobre minería. Cada dato con su fuente y su fecha.'})}
    <div class="ind-kpis">
      ${kpiIndicador(m('estado_mina'),{fechaHeader:fh,color:'var(--acc2)',clase:'ind-kpi-texto',sub:esc(m('estado_mina')?.notas||'')})}
      ${kpiIndicador(m('auditoria_cumplimiento'),{fechaHeader:fh,color:'var(--acc3)',valor:fmtValor(m('auditoria_cumplimiento'),{dec:2}),sub:esc(m('auditoria_cumplimiento')?.notas||'')})}
      ${kpiIndicador(m('arbitrajes_usd'),{fechaHeader:fh,color:'var(--acc4)',sub:'Reclamaciones de First Quantum, suspendidas para negociar'})}
      ${kpiIndicador(m('material_procesado'),{fechaHeader:fh,color:'var(--acc)',sub:esc(m('material_procesado')?.notas||'')})}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title" style="--ct:var(--acc2)">${esc(est.titulo||'Situación actual')}</div>
        <ul class="min-puntos">${(est.puntos||[]).map(p=>`<li>${esc(p.texto)} <span class="min-fuente">${fuenteHTML(p.fuente,p.url)}</span></li>`).join('')||'<li>s/d</li>'}</ul>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--acc5)">Opinión pública sobre reabrir la mina</div>
        <p class="chart-sub">% de encuestados · cada encuestadora hace una pregunta distinta, por eso no se promedian</p>
        <div class="ch tall"><canvas id="c-min-encuestas"></canvas></div>
        ${ref?`<p class="ind-nota"><b>Referéndum</b> (${fuenteHTML(D.fuentes?.[ref.fuente]?.nombre,ref.url)}, ${esc(fmtPeriodo(ref.periodo))}): ${esc(fmtDec(ref.quiere_referendo,1))}% quiere que se decida en un referéndum y ${esc(fmtDec(ref.votaria_no,1))}% votaría "No" a la mina.</p>`:''}
        <ul class="min-preguntas" id="min-preguntas"></ul>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc)">Minería en la Asamblea</div>
      <p class="chart-sub">Proyectos de ley y votaciones del pleno de la legislatura 2024-2029 cuyo título trata de minería. Se actualiza solo, con los datos diarios de la pestaña Asamblea.</p>
      <div id="min-asamblea"><div class="loader"><div class="spinner"></div> Buscando en los proyectos de ley…</div></div>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title" style="--ct:var(--acc3)">Economía y concesiones</div>
        <div class="ind-kpis ind-kpis-mini min-eco">
          ${['exportaciones_cobre_2025','ingresos_q3_2026','concesiones_metalicas','concesiones_no_metalicas'].map(id=>{
            const x=m(id); return kpiIndicador(x,{fechaHeader:fh,color:'var(--acc3)',clase:typeof x?.valor==='string'?'ind-kpi-texto':'',valor:x&&typeof x.valor==='number'&&x.unidad==='USD millones'?'$'+fmtDec(x.valor,1)+' M':undefined,sub:esc(x?.notas||'')});
          }).join('')}
        </div>
      </div>
      <div class="card">
        <div class="card-title">Cronología</div>
        <ol class="sis-crono" id="min-crono"></ol>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc2)">Noticias recientes sobre minería</div>
      <p class="chart-sub">Titulares tomados cada semana de los RSS de TVN y Panamá América. Son enlaces a la nota original: el observatorio no resume ni interpreta su contenido.</p>
      <ul class="min-noticias" id="min-noticias"></ul>
    </div>

    <div class="card ind-fuentes" style="margin-bottom:var(--gap)">
      <div class="card-title">Fuentes</div>
      <ul>${Object.values(D.fuentes||{}).map(f=>`<li>${fuenteHTML(f.nombre,f.url)}${f.detalle?` — ${esc(f.detalle)}`:''}${pillCalidad(f.calidad)}</li>`).join('')}</ul>
    </div>
    ${descargasIndicadorHTML('mineria',[['encuestas','Encuestas'],['cronologia','Cronología'],['noticias','Noticias']])}`;

  minEncuestas(D);
  minCronologia(D);
  minNoticias(D);
  minAsamblea(D);
}

function minEncuestas(D){
  const s=(D.series?.encuestas||[]).slice().sort((a,b)=>String(a.periodo).localeCompare(b.periodo));
  const etq=r=>`${MIN_ENCUESTADORA[r.fuente]||r.fuente} · ${fmtPeriodo(r.periodo)}`;
  const ch=new Chart(document.getElementById('c-min-encuestas'),{
    type:'bar',
    data:{labels:s.map(r=>[MIN_ENCUESTADORA[r.fuente]||r.fuente, fmtPeriodo(r.periodo)]),datasets:[
      {label:'A favor',data:s.map(r=>r.a_favor??null),backgroundColor:'#10b981',borderRadius:4,borderSkipped:false},
      {label:'En contra',data:s.map(r=>r.en_contra??null),backgroundColor:'#ef4444',borderRadius:4,borderSkipped:false},
    ]},
    options:{...opcionesBase({min:0,max:100,sufijo:'%'}),
      scales:{...opcionesBase().scales,x:{...opcionesBase().scales.x,ticks:{...opcionesBase().scales.x.ticks,autoSkip:false,maxRotation:0}},y:{...opcionesBase().scales.y,min:0,max:100}}},
  });
  const ult=s[s.length-1], veaUlt=s.filter(r=>r.fuente==='vea').pop();
  ariaGrafico(ch, veaUlt?`Opinión sobre reabrir la mina. Vea Panamá, ${fmtPeriodo(veaUlt.periodo)}: ${veaUlt.en_contra}% en contra y ${veaUlt.a_favor}% a favor.${ult&&ult!==veaUlt?` La medición más reciente (${etq(ult)}) da ${ult.a_favor}% a favor.`:''}`:'Opinión sobre reabrir la mina: s/d.');
  const F=D.fuentes||{};
  document.getElementById('min-preguntas').innerHTML=s.map(r=>`<li><b>${esc(etq(r))}</b>: "${esc(r.pregunta||'s/d')}" — ${fuenteHTML(F[r.fuente]?.nombre,r.url)}${r.en_contra==null?' · <i>no publicó el % en contra</i>':''}</li>`).join('');
}

function minCronologia(D){
  const hoy=hoyPanama();
  const items=(D.series?.cronologia||[]).slice().sort((a,b)=>String(a.fecha).localeCompare(String(b.fecha)));
  document.getElementById('min-crono').innerHTML=items.map(e=>{
    const futuro=e.programado && String(e.fecha)>hoy;
    return `<li class="${futuro?'sis-noverif':''}">
      <span class="sis-crono-fecha">${esc(fmtDia(e.fecha))}</span>
      <span><b>${esc(e.titulo)}</b>${futuro?' <em class="sis-tag">programado</em>':''}. ${esc(e.descripcion||'')}
        <span class="sis-crono-fuente">${fuenteHTML(e.fuente,e.url)}</span></span>
    </li>`;
  }).join('')||'<li>s/d</li>';
}

function minNoticias(D){
  const n=D.series?.noticias||[];
  document.getElementById('min-noticias').innerHTML = n.length
    ? n.slice(0,12).map(x=>`<li><span class="min-not-fecha">${esc(fmtDia(x.periodo))}</span> <a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.titulo)}</a> <span class="min-fuente">${esc(x.medio||'')}</span></li>`).join('')
    : '<li class="ind-sd">Sin titulares nuevos en las últimas semanas.</li>';
}

// Proyectos y votaciones de la Asamblea sobre minería, filtrados en vivo por el título
async function minAsamblea(D){
  const el=document.getElementById('min-asamblea');
  const pat=new RegExp(D.asamblea?.patron||'miner', 'i');
  const fechaOrd=f=>{ const p=String(f||'').split('-'); return p.length===3&&p[0].length===2?`${p[2]}-${p[1]}-${p[0]}`:String(f||''); };
  let proyectos=[], votos=[], errores=[];
  try{ proyectos=(await ensureDatosRaw()).filter(r=>pat.test(r.titulo||'')).sort((a,b)=>fechaOrd(b.fecha_presentacion).localeCompare(fechaOrd(a.fecha_presentacion))); }
  catch(e){ errores.push('proyectos: '+e.message); }
  try{ const V=await ensureVotaciones(); votos=(V?.votaciones||[]).filter(v=>pat.test(`${v.titulo||''} ${v.descripcion||''}`)); }
  catch(e){ errores.push('votaciones: '+e.message); }
  el.innerHTML=`
    <div class="tbl-scroll"><table class="cmp-tbl min-tbl">
      <thead><tr><th scope="col">Ficha</th><th scope="col">Presentado</th><th scope="col">Título</th><th scope="col">Etapa</th><th scope="col">Proponente</th></tr></thead>
      <tbody>${proyectos.map(p=>`<tr>
        <td><a href="#proyecto=${esc(p.ficha)}">${esc(p.ficha)}</a></td>
        <td style="white-space:nowrap">${esc(fmtDia(fechaOrd(p.fecha_presentacion)))}</td>
        <td style="white-space:normal;min-width:240px">${esc(p.titulo)}</td>
        <td><span class="badge ${etapaClass(p.etapa||'')}" style="font-size:.6875rem">${esc(p.etapa||'s/d')}</span></td>
        <td style="white-space:normal">${esc(String(p.proponente||'').replace(/^H\.D\.?S?\s+/i,'').split(',')[0])}</td>
      </tr>`).join('')||'<tr><td colspan="5" class="ind-sd">Ningún proyecto con tema minero en la legislatura actual.</td></tr>'}</tbody>
    </table></div>
    <p class="ind-nota">${proyectos.length} proyecto${proyectos.length===1?'':'s'} · ${votos.length
      ? `${votos.length} votación${votos.length===1?'':'es'} del pleno: ${votos.map(v=>`<a href="#votacion=${esc(v.votacion_id)}">${esc(fmtDia(v.fecha))} · ${esc(v.resultado||'')}</a>`).join(' · ')}`
      : 'ninguna votación del pleno sobre minería en esta legislatura'}. ${errores.length?`<br>⚠ No se pudieron cargar: ${esc(errores.join('; '))}.`:''}
      La búsqueda usa palabras del título (minería, minera, recursos minerales, cobre…), así que puede dejar fuera proyectos que no las mencionen.</p>`;
}
