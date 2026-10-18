// Observatorio Legislativo — Descargas CSV (datos abiertos)
// ── DESCARGAS CSV ─────────────────────────────────
function fechaArchivo(){
  const m=((D&&D.fecha_extraccion)||'').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0,10);
}
// columnas: [[título, fila=>valor], …]. Se antepone BOM para que Excel respete las tildes.
function downloadCSV(nombre, columnas, filas){
  const cel=v=>{
    if(v==null) return '';
    const s=String(v);
    return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
  const lineas=[columnas.map(c=>cel(c[0])).join(',')]
    .concat(filas.map(f=>columnas.map(c=>cel(c[1](f))).join(',')));
  const blob=new Blob(['﻿'+lineas.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`observatorio_${nombre}_${fechaArchivo()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
// Ejecuta una descarga mostrando estado en el botón (algunas requieren bajar datos.json)
async function withBtn(btn, fn){
  if(!D) return;
  const orig=btn?.innerHTML;
  if(btn){ btn.disabled=true; btn.innerHTML='⏳ Preparando…'; }
  try{ await fn(); }
  catch(e){ console.error('Descarga:',e); alert('No se pudo generar el archivo: '+e.message); }
  finally{ if(btn){ btn.disabled=false; btn.innerHTML=orig; } }
}
const num1=v=>v==null||v===''||!Number.isFinite(Number(v)) ? '' : Number(v);
const round2=v=>Math.round((Number(v)||0)*100)/100;

function exportDiputados(btn, todos=false){
  withBtn(btn, ()=>{
    // Desde la pestaña: lo que se ve (filtros y orden). Desde "Datos abiertos": todos.
    const filas = todos
      ? (D.diputados||[]).map(d=>({...d,efectividad:d.proyectos>0?+((d.leyes/d.proyectos)*100).toFixed(1):0,
          topEtapa:Object.entries(d.etapas||{}).sort((a,b)=>b[1]-a[1])[0]?.[0]||''}))
      : (sortedDeps.length ? sortedDeps : filtered);
    downloadCSV('diputados', [
      ['Diputado',d=>d.nombre], ['Partido',d=>d.partido], ['Provincia',d=>d.provincia], ['Circuito',d=>d.circuito],
      ['Proyectos propuestos',d=>d.proyectos||0], ['Co-patrocinios',d=>d.co_patrocinios||0], ['Leyes',d=>d.leyes||0],
      ['Autor → ley (%)',d=>d.efectividad_ley?.autor?.tasa], ['Leyes esperadas como autor',d=>d.efectividad_ley?.autor?.esperadas],
      ['Índice de efectividad autor (100 = promedio)',d=>d.efectividad_ley?.autor?.indice], ['Evidencia autor',d=>d.efectividad_ley?.autor?.evidencia],
      ['Co-firmas con otros partidos (%)',d=>d.transversalidad], ['Esperado por tamaño del partido (%)',d=>d.transversalidad_esperada],
      ['Firma más con',d=>(d.aliados||[]).slice(0,3).map(a=>`${a.nombre} (${a.proyectos})`).join(' | ')],
      ['Leyes como co-patrocinador',d=>d.leyes_copatrocinio], ['Co-patrocinio → ley (%)',d=>d.efectividad_ley?.copat?.tasa],
      ['Índice de efectividad co-patrocinio (100 = promedio)',d=>d.efectividad_ley?.copat?.indice],
      ['Etapa más frecuente',d=>d.topEtapa], ['Suplente',d=>d.suplente],
      ['Perfil',d=>d.perfil],
    ], filas);
  });
}

function exportMonitoreo(btn, todos=false){
  withBtn(btn, ()=>{
    const filas = (!todos && monitorSorted.length) ? monitorSorted : monitorData();
    downloadCSV('monitoreo', [
      ['Diputado',d=>d.nombre], ['Partido',d=>d.partido], ['Circuito',d=>d.circuito], ['Provincia',d=>d.provincia],
      ['Planilla acumulada (B/.)',d=>num1(d.planilla_valor)], ['Asistencia pleno (1-5)',d=>num1(d.asistencia_pleno)],
      ['Asistencia comisiones (1-5)',d=>num1(d.asistencia_comisiones)], ['Calificación (1-5)',d=>num1(d.calificacion)],
      ['Nº comisiones',d=>d.comisiones_cantidad||0], ['Comisiones',d=>(d.comisiones||[]).join(' | ')],
      ['Perfil Espacio Cívico',d=>d.perfil_monitoreo],
    ], filas);
  });
}

function exportCostosDiputados(btn){
  withBtn(btn, async ()=>{
    const C=await ensureCostos();
    downloadCSV('costo_por_diputado', [
      ['Diputado',d=>d.nombre], ['Partido',d=>d.partido],
      ['Planilla Espacio Cívico (B/.)',d=>round2(d.planilla)], ['Meses cerrados',d=>d.totalMeses],
      ['Salario acumulado (B/.)',d=>round2(d.salarioAcumulado)], ['Costo acumulado (B/.)',d=>round2(d.costoAcumulado)],
      ...C.years.map(y=>[`Costo ${y} (B/.)`,d=>round2(d.byYear[y]?.costoAnual)]),
      ['Participaciones en proyectos',d=>d.totalProy], ['Costo por proyecto (B/.)',d=>d.totalProy>0?round2(d.costoPorProy):''],
    ], C.dipCosts);
  });
}

function exportCostosProyectos(btn){
  withBtn(btn, async ()=>{
    const C=await ensureCostos();
    downloadCSV('costo_por_proyecto', [
      ['Ficha',p=>p.ficha], ['Título',p=>p.titulo], ['Año',p=>p.year], ['Etapa',p=>p.etapa],
      ['Diputados participantes',p=>p.diputados], ['Costo estimado (B/.)',p=>round2(p.costo)],
    ], C.proyectos);
  });
}

function exportProyectos(btn){
  withBtn(btn, async ()=>{
    const datos=await ensureDatosRaw();
    downloadCSV('proyectos', [
      ['Ficha',r=>r.ficha], ['Fecha de presentación',r=>r.fecha_presentacion], ['Título',r=>r.titulo],
      ['Etapa',r=>r.etapa], ['Temas',r=>(D.temas_por_ficha?.[r.ficha]||[]).map(i=>D.temas[i]).join(' | ')],
      ['Proponente(s)',r=>r.proponente], ['Nº proyecto',r=>r.proyecto], ['Nº anteproyecto',r=>r.anteproyecto],
    ], datos);
  });
}

function exportHistorico(btn){
  withBtn(btn, async ()=>{
    const H=await ensureHist();
    if(!H) throw new Error('el historial aún no está disponible');
    const nombres=Object.fromEntries((D.diputados||[]).map(d=>[depSlug(d),d.nombre]));
    const filas=[];
    H.snapshots.forEach(s=>Object.entries(s.diputados||{}).forEach(([slug,v])=>filas.push({fecha:s.fecha,slug,v})));
    const idx=k=>H.campos.indexOf(k);
    downloadCSV('historico', [
      ['Fecha',f=>f.fecha], ['Diputado',f=>nombres[f.slug]||f.slug],
      ['Planilla acumulada (B/.)',f=>num1(f.v[idx('planilla')])], ['Asistencia pleno',f=>num1(f.v[idx('pleno')])],
      ['Asistencia comisiones',f=>num1(f.v[idx('comisiones')])], ['Calificación',f=>num1(f.v[idx('calificacion')])],
      ['Proyectos propuestos',f=>num1(f.v[idx('proyectos')])], ['Leyes',f=>num1(f.v[idx('leyes')])],
    ], filas);
  });
}

