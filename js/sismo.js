// Observatorio Legislativo — Pestaña 🌎 Sismo: terremoto del 9 oct 2026 (data/sismo.json)
// Con "activo": false en el JSON la pestaña pasa a modo archivo histórico.
let sisInited=false, sisReloj=null;

// Proyección aproximada lon/lat → coordenadas del mapa base (panama-map.svg, viewBox 1246×628),
// calibrada con la posición de las etiquetas de provincia del propio mapa (Chiriquí, Coclé, Herrera,
// Los Santos, Darién). Error estimado: unos 10–15 km, suficiente para ubicar el epicentro.
const SIS_PROY = { x0:538, lon0:-80.4, kx:182, y0:322, lat0:8.5, ky:184 };
const sisXY = (lat,lon) => [SIS_PROY.x0+(lon-SIS_PROY.lon0)*SIS_PROY.kx, SIS_PROY.y0+(SIS_PROY.lat0-lat)*SIS_PROY.ky];
const SIS_NIVEL_COLOR = { 0:'rgba(148,163,184,.12)', 1:'rgba(245,158,11,.55)', 2:'rgba(239,68,68,.75)' };

function sisDias(inicio){
  const d=indDiasEntre(hoyPanama(new Date(inicio)), hoyPanama());
  return Number.isFinite(d) ? d : null;
}
function sisChip(mag){
  const c = mag>=6.5 ? 'mag-alta' : mag>=5 ? 'mag-media' : 'mag-baja';
  return `<span class="mag-chip ${c}">M${esc(fmtDec(mag,1))}</span>`;
}
function sisFechaHora(f){
  const s=String(f);
  if(s.length<=10) return fmtDia(s);
  return `${fmtDia(s)} · ${s.slice(11,16)}`;
}

async function initSismo(){
  if(sisInited) return;
  sisInited=true;
  const root=document.getElementById('sis-root');
  let D;
  try{ D=await cargarIndicador('sismo'); }
  catch(e){ sisInited=false; return errorIndicador(root,e); }
  const ev=D.evento||{}, fh=D.fecha_corte, m=id=>metricaPorId(D,id);
  const archivo = D.activo===false;
  const conFecha=(x,ref)=>x&&x.fecha_corte&&ref&&x.fecha_corte!==ref.fecha_corte?` <span class="ind-al">(al ${esc(fmtDia(x.fecha_corte,false))})</span>`:'';
  const af=m('afectados'), fa=m('fallecidos'), he=m('heridos'), al=m('albergados'), ag=m('albergues');
  const rl=m('replicas_localizadas'), r4=m('replicas_m4'), rd=m('replicas_detectadas');
  const dias={etiqueta:'Días desde el sismo', valor:null, unidad:'días',
    fuente:ev.fuente, url:ev.url, fecha_corte:fh, periodo:ev.inicio?.slice(0,10)};

  root.innerHTML=`
    ${encabezadoIndicador(D,{titulo:'Terremoto del 9 de octubre de 2026',
      desc:`Situación de la emergencia en Azuero y las provincias centrales: población registrada, albergues, daños y secuencia de réplicas.${archivo?' <strong>Archivo histórico:</strong> esta pestaña ya no se actualiza.':''}`})}
    ${archivo?`<div class="data-banner"><span class="data-banner-ico" aria-hidden="true">🗂</span><div>Modo <strong>archivo histórico</strong>: las cifras corresponden al último corte publicado (${esc(fmtDia(fh))}) y el job semanal ya no las revisa.</div></div>`:''}
    <div class="ind-kpis">
      ${kpiIndicador(m('magnitud'),{fechaHeader:fh,color:'var(--acc4)',
        sub:`${ev.magnitud_inicial?`Sinaproc inicial: M${esc(fmtDec(ev.magnitud_inicial,1))} · `:''}${ev.profundidad_km?`prof. ${esc(ev.profundidad_km)} km · `:''}falla ${esc(ev.falla||'s/d')}`})}
      ${kpiIndicador(dias,{fechaHeader:fh,color:'var(--acc2)',valor:'—',clase:'sis-dias',
        sub:ev.inicio?`${esc(sisFechaHora(ev.inicio))} h · se calcula en tu navegador`:'s/d'})}
      ${kpiIndicador(af,{fechaHeader:fh,color:'var(--acc2)',
        sub:`${fa?`${esc(fmtValor(fa))} fallecidos`:'fallecidos s/d'}${conFecha(fa,af)} · ${he?`${esc(fmtValor(he))} heridos`:'heridos s/d'}${conFecha(he,af)}`})}
      ${kpiIndicador(al,{fechaHeader:fh,color:'var(--acc5)',
        sub:ag?`${esc(fmtValor(ag))} albergues activos${conFecha(ag,al)}`:'albergues s/d'})}
      ${kpiIndicador(rl,{fechaHeader:fh,color:'var(--acc)',
        sub:`${r4?`${esc(fmtValor(r4))} mayores de M4.0${conFecha(r4,rl)}`:''}${rd?` · ${esc(fmtValor(rd))} detectadas${conFecha(rd,rl)}`:''}`})}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title">Réplicas acumuladas (localizadas)</div>
        <p class="chart-sub">Conteo del Instituto de Geociencias de la Universidad de Panamá (IGC-UP), según el último dato publicado en cada fecha</p>
        <div class="ch tall"><canvas id="c-sis-replicas"></canvas></div>
        <p class="ind-nota" id="sis-replicas-nota"></p>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--acc4)">Daños e infraestructura</div>
        <p class="chart-sub">Cada barra muestra su fuente y su fecha de corte</p>
        <ol class="ind-bars" id="sis-danos"></ol>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--gap)">
      <div class="card-title" style="--ct:var(--acc2)">Provincias afectadas y epicentro</div>
      <p class="chart-sub">${fuenteHTML(D.afectacion_provincias?.fuente, D.afectacion_provincias?.url)}</p>
      <div class="map-wrap sis-map" id="sis-map-wrap">
        <img class="panama-map-base" src="panama-map.svg" alt="" aria-hidden="true">
      </div>
      <div class="sis-leyenda" id="sis-leyenda"></div>
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-title">Cronología y réplicas mayores</div>
        <p class="chart-sub"><span class="mag-chip mag-alta">M≥6.5</span> <span class="mag-chip mag-media">M5.0–6.4</span> · lo no confirmado por el IGC-UP queda marcado</p>
        <ol class="sis-crono" id="sis-crono"></ol>
      </div>
      <div class="card">
        <div class="card-title" style="--ct:var(--acc3)">Respuesta y ayuda humanitaria</div>
        <div class="ind-kpis ind-kpis-mini">
          ${['comunidades_atendidas','ayuda_tierra_t','ayuda_aire_lb','viviendas_evaluadas'].map(id=>kpiIndicador(m(id),{fechaHeader:fh,color:'var(--acc3)',unidad:m(id)?.unidad||''})).join('')}
        </div>
        <ul class="sis-otros">${(D.otros_datos||[]).map(o=>`<li><b>${esc(o.etiqueta)}:</b> ${esc(o.valor_texto||'s/d')} · ${fuenteHTML(o.fuente,o.url)} ${pillCalidad(o.calidad)}</li>`).join('')}</ul>
        ${D.fuentes?.ocha?`<p class="chart-sub">Contexto de la respuesta internacional: ${fuenteHTML(D.fuentes.ocha.nombre,D.fuentes.ocha.url)}</p>`:''}
      </div>
    </div>

    <div class="card ind-fuentes" style="margin-bottom:var(--gap)">
      <div class="card-title">Fuentes</div>
      <ul>${Object.values(D.fuentes||{}).map(f=>`<li>${fuenteHTML(f.nombre,f.url)}${f.notas?` — ${esc(f.notas)}`:''}${pillCalidad(f.calidad)}</li>`).join('')}
        ${ev.notas?`<li>Sobre la magnitud y la profundidad: ${esc(ev.notas)}</li>`:''}</ul>
    </div>
    ${descargasIndicadorHTML('sismo',[['replicas','Serie de réplicas'],['cronologia','Cronología']])}`;

  sisContador(ev);
  sisGraficoReplicas(D);
  sisDanos(D);
  sisMapa(D);
  sisCronologia(D);
}

// "Días desde el sismo" se calcula en el navegador y se refresca al cambiar el día
function sisContador(ev){
  const el=document.querySelector('#sis-root .sis-dias .kpi-value');
  if(!el) return;
  const pintar=()=>{
    const d=ev.inicio?sisDias(ev.inicio):null;
    el.textContent = d==null ? 's/d' : fmtNum(d);
    el.classList.toggle('ind-sd', d==null);
  };
  pintar();
  clearInterval(sisReloj);
  sisReloj=setInterval(pintar, 60000);
}

function sisGraficoReplicas(D){
  const s=D.series?.replicas||[];
  const ch=new Chart(document.getElementById('c-sis-replicas'),{
    type:'line',
    data:{labels:s.map(r=>fmtDia(r.periodo,false)),datasets:[{label:'Réplicas localizadas (acumulado)',data:s.map(r=>r.localizadas??null),
      borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.18)',fill:'origin',pointRadius:4,spanGaps:false,tension:.15}]},
    options:{...opcionesBase(),plugins:{...opcionesBase().plugins,legend:{display:false},
      tooltip:{...opcionesBase().plugins.tooltip,callbacks:{label:ctx=>{const r=s[ctx.dataIndex];
        return ` ${r.minimo?'más de ':r.aproximado?'aprox. ':''}${fmtNum(ctx.raw)} réplicas · ${r.fuente||''}`;}}}}},
  });
  const ult=s[s.length-1];
  if(ult) ariaGrafico(ch,`Réplicas localizadas acumuladas: ${ult.aproximado?'aproximadamente ':''}${fmtNum(ult.localizadas)} al ${fmtDia(ult.periodo)}.`);
  const notas=[];
  if(s.some(r=>r.minimo)) notas.push('Los puntos marcados como mínimo (">350") se grafican con el piso publicado.');
  if(s.some(r=>r.aproximado)) notas.push('Las cifras aproximadas vienen de declaraciones del IGC-UP citadas por la prensa.');
  document.getElementById('sis-replicas-nota').textContent=notas.join(' ');
}

function sisDanos(D){
  const ids=['viviendas_evaluadas','derrumbes','escuelas','albergues','salud'];
  const items=ids.map(id=>metricaPorId(D,id)).filter(Boolean);
  const max=Math.max(...items.map(x=>x.valor||0),1);
  const el=document.getElementById('sis-danos');
  const top=items.filter(x=>x.valor!=null).sort((a,b)=>b.valor-a.valor)[0];
  el.setAttribute('aria-label', top?`Daños e infraestructura: la cifra mayor es ${top.etiqueta}, ${fmtNum(top.valor)}.`:'Daños: s/d');
  el.innerHTML=items.map(x=>`<li class="ind-bar ind-bar-2l">
    <span class="ind-bar-lbl"><b>${esc(x.etiqueta)}</b> <span>${fuenteHTML(x.fuente,x.url)} · ${esc(fmtDia(x.fecha_corte))}</span> ${pillCalidad(x.calidad)}</span>
    <span class="ind-bar-track" aria-hidden="true"><span class="ind-bar-fill" style="--bc:var(--acc4);width:${x.valor==null?0:Math.max(.6,x.valor/max*100).toFixed(1)}%"></span></span>
    <span class="ind-bar-val${x.valor==null?' ind-sd':''}">${x.valor==null?'s/d':fmtNum(x.valor)}</span>
    ${x.calidad==='baja'&&x.notas?`<span class="ind-bar-nota">${esc(x.notas)}</span>`:''}
  </li>`).join('');
}

// Reutiliza el mapa SVG de provincias de la pestaña General (mismos círculos y etiquetas)
function sisMapa(D){
  const wrap=document.getElementById('sis-map-wrap'), base=document.getElementById('panama-map');
  if(!wrap || !base) return;
  const svg=base.cloneNode(true);
  svg.id='sis-map';
  svg.querySelectorAll('[id]').forEach(n=>{ n.id='sis-'+n.id; });
  svg.querySelectorAll('text:not(.map-label)').forEach(t=>t.remove());
  svg.setAttribute('role','img'); svg.removeAttribute('aria-hidden');
  const niveles=D.afectacion_provincias?.niveles||{}, etiquetas=D.afectacion_provincias?.etiquetas||{};
  const porId={};
  Object.entries(niveles).forEach(([prov,n])=>{ const id=PROV_MAP[prov]; if(id) porId[id]={prov,n}; });
  MAP_ALL_IDS.forEach(id=>{
    const c=svg.querySelector('#sis-pmap-'+id); if(!c) return;
    const n=porId[id]?.n||0;
    c.classList.add('sis-prov'); c.style.fill=SIS_NIVEL_COLOR[n]; c.setAttribute('r', n===2?24:n===1?19:13);
    const t=document.createElementNS('http://www.w3.org/2000/svg','title');
    t.textContent=`${porId[id]?.prov||id.replace(/_/g,' ')}: ${etiquetas[n]||'Sin reporte'}`; c.appendChild(t);
  });
  const ep=D.evento?.epicentro;
  if(ep && Number.isFinite(ep.lat) && Number.isFinite(ep.lon)){
    const [x,y]=sisXY(ep.lat,ep.lon), ns='http://www.w3.org/2000/svg';
    const g=document.createElementNS(ns,'g'); g.setAttribute('class','sis-epi');
    g.innerHTML=`<circle class="sis-epi-onda" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16"/><path d="M${x} ${y-13}l3.4 8.6 9.2.4-7.2 5.8 2.5 8.9-7.9-5.1-7.9 5.1 2.5-8.9-7.2-5.8 9.2-.4z"/><title>Epicentro: ${esc(ep.descripcion||'')}</title>`;
    svg.appendChild(g);
  }
  const afectadas=Object.entries(niveles).sort((a,b)=>b[1]-a[1]).map(([p,n])=>`${p} (${etiquetas[n]||n})`).join(', ');
  svg.setAttribute('aria-label',`Mapa de afectación por provincia: ${afectadas||'s/d'}. Epicentro: ${ep?.descripcion||'s/d'}.`);
  wrap.appendChild(svg);
  document.getElementById('sis-leyenda').innerHTML=[2,1,0].map(n=>`<span><i style="background:${SIS_NIVEL_COLOR[n]}"></i>${esc(etiquetas[n]||'')}</span>`).join('')
    +`<span><i class="sis-ley-epi" aria-hidden="true">★</i>Epicentro${ep?.descripcion?': '+esc(ep.descripcion):''} (ubicación aproximada)</span>`;
}

function sisCronologia(D){
  const items=(D.series?.cronologia||[]).slice().sort((a,b)=>String(a.fecha).localeCompare(String(b.fecha)));
  document.getElementById('sis-crono').innerHTML=items.map(e=>`<li class="${e.verificado===false?'sis-noverif':''}">
    <span class="sis-crono-fecha">${esc(sisFechaHora(e.fecha))}</span>
    <span>${e.magnitud!=null?sisChip(e.magnitud):''} ${esc(e.descripcion||'')}
      ${e.verificado===false?'<em class="sis-tag">sin verificar</em>':''}
      <span class="sis-crono-fuente">${fuenteHTML(e.fuente,e.url)}</span></span>
  </li>`).join('') || '<li>s/d</li>';
}
