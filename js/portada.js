// Observatorio Ciudadano — Inicio: centro de consulta con una tarjeta por sección (cifra clave, fuente y frescura).
// Las cifras salen de data/*.json y de resumen.json; nada está escrito a mano en esta página.

function portadaCard({href, titulo, dato, etiqueta, fuente, fecha, extra='', clase=''}){
  const sinDato = dato==null || dato==='s/d' || dato==='pendiente';
  return `<a class="portada-card ${clase}" href="${href}">
    <span class="pc-tit">${esc(titulo)}</span>
    <span class="pc-dato${sinDato?' ind-sd':''}">${esc(sinDato?'s/d':dato)}</span>
    <span class="pc-lbl">${etiqueta}</span>
    ${extra?`<span class="pc-extra">${extra}</span>`:''}
    <span class="pc-meta">${fuente?`<span>${esc(fuente)}</span>`:''}${fecha?frescuraHTML(fecha):''}</span>
    <span class="pc-cta">Consultar <span aria-hidden="true">→</span></span>
  </a>`;
}

function portadaGrupo(id, tarjetas){
  const g=GRUPOS.find(x=>x.id===id);
  return `<section class="portada-grupo" aria-labelledby="pg-${id}">
    <div class="portada-grupo-hdr">
      <h3 id="pg-${id}"><span aria-hidden="true">${g.icono}</span> ${esc(g.nombre)}</h3>
      <p>${esc(g.desc||'')}</p>
    </div>
    <div class="portada-cards">${tarjetas.join('')}</div>
  </section>`;
}

async function initPortada(){
  const root=document.getElementById('portada-root');
  if(!root) return;
  const [ap,cv,sm,mi]=(await Promise.allSettled(['aprobacion','costo_vida','sismo','mineria'].map(cargarIndicador))).map(r=>r.status==='fulfilled'?r.value:null);
  const m=(Dx,id)=>Dx?metricaPorId(Dx,id):null;

  const mala=m(ap,'gestion_mala'), conf=m(ap,'confianza_presidente');
  const g95=m(cv,'gasolina_95_gal'), cbfa=m(cv,'cbfa');
  const afe=m(sm,'afectados'), alb=m(sm,'albergues');
  const est=m(mi,'estado_mina');
  const encVea=(mi?.series?.encuestas||[]).filter(r=>r.fuente==='vea').pop();
  const corteAsamblea = (typeof D!=='undefined' && D) ? getFechaCorte().toISOString().slice(0,10) : null;

  root.innerHTML=`
    <section class="portada-hero">
      <h2>Consulta lo público, con la fuente a la vista</h2>
      <p>El Observatorio Ciudadano de Panamá reúne en un solo lugar datos públicos sobre <strong>cómo se percibe al Gobierno y a las instituciones</strong>, <strong>lo que afecta la vida diaria</strong> y <strong>el trabajo de la Asamblea Nacional</strong>. Cada cifra muestra su fuente, su fecha de corte y cuán reciente es:</p>
      <div class="portada-leyenda" aria-label="Indicador de frescura">
        <span class="fresh fresh-verde"><span class="fresh-dot"></span>7 días o menos</span>
        <span class="fresh fresh-ambar"><span class="fresh-dot"></span>de 8 a 30 días</span>
        <span class="fresh fresh-rojo"><span class="fresh-dot"></span>más de 30 días</span>
        <a href="#metodologia">¿Cómo se construyen los datos?</a>
      </div>
    </section>

    ${portadaGrupo('percepcion',[
      portadaCard({href:'#aprobacion', titulo:'⭐ Aprobación y confianza',
        dato:mala?fmtValor(mala):null, etiqueta:'califica de mala o muy mala la gestión presidencial',
        extra:conf?`Confía en el presidente: <b>${esc(fmtValor(conf))}</b> (${esc(conf.fuente)})`:'',
        fuente:mala?.fuente?.split(' (')[0], fecha:mala?.fecha_corte}),
    ])}

    ${portadaGrupo('intereses',[
      portadaCard({href:'#costo-vida', titulo:'🛒 Costo de vida',
        dato:g95?fmtValor(g95):null, etiqueta:'el galón de gasolina 95 en Panamá y Colón',
        extra:cbfa?`Canasta básica: <b>${esc(fmtValor(cbfa))}</b> (${esc(fmtPeriodo(cbfa.periodo))})`:'',
        fuente:'Secretaría de Energía · MEF', fecha:g95?.fecha_corte}),
      portadaCard({href:'#sismo', titulo:'🌎 Sismo del 9 de octubre',
        dato:afe?fmtValor(afe):null, etiqueta:'personas registradas en la evaluación de daños',
        extra:alb?`Albergues activos: <b>${esc(fmtValor(alb))}</b>`:'',
        fuente:'Sinaproc · IGC-UP', fecha:afe?.fecha_corte}),
      portadaCard({href:'#mineria', titulo:'⛏️ Minería', clase:'pc-texto',
        dato:est?fmtValor(est):null, etiqueta:'mina Cobre Panamá',
        extra:encVea?`En contra de reabrirla: <b>${esc(fmtDec(encVea.en_contra,1))}%</b> (Vea Panamá, ${esc(fmtPeriodo(encVea.periodo))})`:'',
        fuente:est?.fuente, fecha:est?.fecha_corte}),
    ])}

    ${portadaGrupo('asamblea',[
      portadaCard({href:'#general', titulo:'📊 Proyectos de ley',
        dato:D?fmtNum(D.total_proyectos):null, etiqueta:'presentados desde julio de 2024',
        extra:D?`Ya son ley: <b>${fmtNum(D.total_leyes)}</b>`:'', fuente:'Asamblea Nacional', fecha:corteAsamblea}),
      portadaCard({href:'#diputados', titulo:'👤 Diputados',
        dato:D?fmtNum(D.total_diputados):null, etiqueta:'con sus proyectos, asistencia y planilla',
        fuente:'Asamblea · Espacio Cívico', fecha:corteAsamblea}),
      portadaCard({href:'#votaciones', titulo:'🗳 Votaciones', clase:'pc-texto',
        dato:'Pleno', etiqueta:'cómo votó cada diputado, artículo por artículo', fuente:'prensa507.asamblea.gob.pa', fecha:corteAsamblea}),
      portadaCard({href:'#costos', titulo:'💰 Costo legislativo', clase:'pc-texto',
        dato:'Por proyecto', etiqueta:'estimación del costo de cada proyecto y diputado', fuente:'Espacio Cívico · Contraloría', fecha:corteAsamblea}),
    ])}`;
}
