// Observatorio Legislativo — Comparador de diputados
// ── COMPARADOR ────────────────────────────────────
const CMP_IDS=['cmp-s0','cmp-s1','cmp-s2'];
let _cmpToken=0;
function initComparar(){
  const deps=[...(D.diputados||[])].sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
  const opts='<option value="">— Elegir diputado —</option>'+deps.map(d=>`<option value="${esc(depSlug(d))}">${esc(d.nombre)}</option>`).join('');
  CMP_IDS.forEach(id=>{ document.getElementById(id).innerHTML=opts; });
}
function openComparar(slugs){
  showTab('diputados');
  CMP_IDS.forEach((id,i)=>{ document.getElementById(id).value=slugs[i]||''; });
  const box=document.getElementById('cmp-box');
  box.open=true;
  renderComparar();
  setTimeout(()=>box.scrollIntoView({behavior:'smooth',block:'start'}),80);
}
function onCompararChange(){
  const slugs=CMP_IDS.map(id=>document.getElementById(id).value).filter(Boolean);
  setHash(slugs.length ? 'comparar='+slugs.join(',') : 'diputados');
  renderComparar();
}
async function renderComparar(){
  const token=++_cmpToken;
  const slugs=[...new Set(CMP_IDS.map(id=>document.getElementById(id).value).filter(Boolean))];
  const out=document.getElementById('cmp-result');
  document.getElementById('cmp-copy').style.display=slugs.length>=2?'':'none';
  if(slugs.length<2){ out.innerHTML='<div class="cmp-empty">Elige al menos dos diputados para compararlos.</div>'; return; }
  const deps=slugs.map(s=>(D.diputados||[]).find(d=>depSlug(d)===s)).filter(Boolean);
  const draw=costos=>{
    const cost=d=>costos?.dipCosts.find(c=>c.slug===depSlug(d));
    // [etiqueta, valor numérico, texto, mejor ('max' | 'min' | null)]
    const filas=[
      ['Partido',null,d=>esc(d.partido||'—')],
      ['Provincia · circuito',null,d=>esc([d.provincia,d.circuito].filter(Boolean).join(' · ')||'—')],
      ['Proyectos propuestos',d=>d.proyectos||0,d=>fmtNum(d.proyectos),'max'],
      ['Co-patrocinios',d=>d.co_patrocinios||0,d=>fmtNum(d.co_patrocinios),'max'],
      ['Leyes aprobadas',d=>d.leyes||0,d=>fmtNum(d.leyes),'max'],
      ['Autor → ley',d=>d.efectividad_ley?.autor?.tasa??NaN,d=>celdaTasa(d.efectividad_ley?.autor),'max'],
      ['Co-patrocinio → ley',d=>d.efectividad_ley?.copat?.tasa??NaN,d=>celdaTasa(d.efectividad_ley?.copat),'max'],
      ['Índice de efectividad (autor)',d=>d.efectividad_ley?.autor?.indice??NaN,d=>celdaIndiceRol(d.efectividad_ley,'autor'),'max'],
      ['Índice de efectividad (co-patrocinio)',d=>d.efectividad_ley?.copat?.indice??NaN,d=>celdaIndiceRol(d.efectividad_ley,'copat'),'max'],
      ['Asistencia pleno',d=>Number(d.asistencia_pleno),d=>fmtScore(d.asistencia_pleno)+' / 5','max'],
      ['Asistencia comisiones',d=>Number(d.asistencia_comisiones),d=>fmtScore(d.asistencia_comisiones)+' / 5','max'],
      ['Calificación Espacio Cívico',d=>Number(d.calificacion),d=>fmtScore(d.calificacion)+' / 5','max'],
      ['Co-firmas con otros partidos',null,d=>d.transversalidad==null?'—':`${fmtNum(d.transversalidad)}% <span class="ief-sub">(esperado ${fmtNum(d.transversalidad_esperada)}%)</span>`],
      ['Temas que más propone',null,d=>esc(Object.keys(d.temas_autor||{}).slice(0,3).join(', ')||'—')],
      ['Comisiones',d=>d.comisiones_cantidad||0,d=>fmtNum(d.comisiones_cantidad),null],
      ['Planilla acumulada',d=>Number(d.planilla_valor),d=>fmtMoney(d.planilla_valor),'min'],
      ['Costo acumulado',d=>cost(d)?.costoAcumulado,d=>costos?(cost(d)?'B/. '+fmtNum(cost(d).costoAcumulado):'—'):'…','min'],
      ['Costo por proyecto',d=>cost(d)?.totalProy>0?cost(d).costoPorProy:NaN,d=>costos?(cost(d)?.totalProy>0?'B/. '+fmtNum(cost(d).costoPorProy):'—'):'…','min'],
    ];
    out.innerHTML=`<table class="cmp-tbl" style="--n:${deps.length}">
      <thead><tr><th></th>${deps.map(d=>`<th><a href="#diputado=${esc(depSlug(d))}" style="color:inherit">${esc(d.nombre)}</a></th>`).join('')}</tr></thead>
      <tbody>${filas.map(([lbl,val,txt,best])=>{
        let ganador=null;
        if(best&&val){
          const vals=deps.map(d=>val(d)).filter(Number.isFinite);
          if(vals.length===deps.length && new Set(vals).size>1) ganador=best==='max'?Math.max(...vals):Math.min(...vals);
        }
        return `<tr><th>${lbl}</th>${deps.map(d=>`<td class="${ganador!=null&&val(d)===ganador?'cmp-best':''}">${txt(d)}</td>`).join('')}</tr>`;
      }).join('')}</tbody></table>
      <p class="hist-note" style="margin-top:8px">En verde, el mejor valor de cada fila (menor costo, mayor producción o asistencia).</p>`;
  };
  draw(COSTOS);
  if(!COSTOS){
    try{ const c=await ensureCostos(); if(token===_cmpToken) draw(c); }catch(e){ console.error('Comparar costos:',e); }
  }
}

