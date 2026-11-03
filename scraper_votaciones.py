"""
=============================================================
 VOTACIONES NOMINALES DEL PLENO - Observatorio Legislativo
 Fuente: API pública de prensa507.asamblea.gob.pa (sin token)

 Solo la legislatura 2024-2029 (sesiones desde el 1 de julio de 2024).
 Descarga incremental: guarda los IDs de reportes ya procesados y en cada
 corrida baja solo los nuevos. Si la API falla, conserva los datos anteriores.

 Tablas (fuente de verdad, también publicadas como datos abiertos):
   votaciones.csv  una fila por votación (proyecto + debate, ratificación, informe de minoría…)
   preguntas.csv   una fila por artículo / título votado
   votos.csv       una fila por diputado y artículo
 Derivados:
   votaciones.json         lista para el sitio
   votaciones/{id}.json    detalle nominal de cada votación (se carga bajo demanda)
   votaciones_estado.json  reportes procesados
   votaciones_calidad.json log de calidad de cada corrida

EJECUCIÓN:
    python scraper_votaciones.py                       # incremental
    python scraper_votaciones.py --sin-descarga        # regenera los derivados desde los CSV
    python scraper_votaciones.py --desde-carpeta DIR   # usa DIR/{id}.json ya descargados (desarrollo)
=============================================================
"""

import csv, json, os, re, sys, time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from scraper import EmparejadorDiputados, tokens_nombre, _leer_json

API = 'https://prensa507.asamblea.gob.pa/api/v1'
INICIO_LEGISLATURA = '2024-07-01'
PAUSA = 1.2            # segundos entre requests
TIMEOUT = 90           # algunos reportes pesan varios MB
REINTENTOS = 3
MAX_MINUTOS = 18       # presupuesto por corrida; lo pendiente se baja en la siguiente
DIAS_REVISAR_VACIOS = 14   # un reporte reciente sin votaciones se vuelve a revisar (pueden cargarlas después)

CSV_VOTACIONES, CSV_PREGUNTAS, CSV_VOTOS = 'votaciones.csv', 'preguntas.csv', 'votos.csv'
JSON_VOTACIONES = 'votaciones.json'
JSON_METRICAS = 'votos_diputado.json'
JSON_MATRIZ = 'votos_matriz.json'
CARPETA_DETALLE = 'votaciones'
ESTADO = 'votaciones_estado.json'
CALIDAD = 'votaciones_calidad.json'

COLS_VOTACIONES = ['votacion_id', 'reporte_id', 'sesion_id', 'fecha', 'tipo', 'proyecto', 'ficha', 'debate',
                   'debate_inferido', 'objetado', 'titulo', 'descripcion', 'resultado',
                   'total_favor', 'total_contra', 'total_abst', 'n_preguntas', 'n_aprobadas', 'preside_id']
COLS_PREGUNTAS = ['question_id', 'votacion_id', 'orden', 'articulo', 'tipo_pregunta', 'resultado',
                  'votos_necesarios', 'total_favor', 'total_contra', 'total_abst', 'total_modificaciones']
COLS_VOTOS = ['votacion_id', 'question_id', 'articulo', 'deputy_id', 'diputado', 'principal', 'partido',
              'circuito', 'voto', 'respuesta_id', 'sentido', 'principal_id', 'slug']

# Diputados que ningún criterio automático resuelve: deputy_id de prensa507 → slug de Espacio Cívico
# (None = no asignar a propósito). Vacío hasta que se revise el log de calidad.
VINCULOS_MANUALES = {}

RESPUESTAS = {1: 'favor', 2: 'contra', 3: 'abstencion'}   # cualquier otro id es "Modificado por …" (a favor)


# ─────────────────────────────────────────────
# CLASIFICACIÓN DE TÍTULOS
# ─────────────────────────────────────────────
# Los títulos se escriben a mano ("Proyecto de Ley, Nº. 373", "Proyecto Ley No. 398", "proyecro de Ley N° 176",
# "Proyecto No. 77", "Nª 204", "Nº9"…). Todo lo demás se identifica por IDs y por plenarySession.date.
RX_PROYECTO = re.compile(r'proyec\w*\s+(?:de\s+)?(?:ley\s*)?[,.;:]?\s*(?:n[\s.oº°ª]*)?(\d+)', re.I)
RX_INFORME = re.compile(r'informe\s+de\s+minor', re.I)
RX_NOMBRAMIENTO = re.compile(r'ratifi|rafiti|nombramient|est[aá]\s+usted\s+a\s+favor', re.I)

def clasificar_votacion(titulo, tipos_pregunta, descripcion=''):
    """→ (tipo, proyecto, debate, debate_inferido, objetado). Si el título no trae el número, se busca en la descripción."""
    t = titulo or ''
    m = RX_PROYECTO.search(t) or RX_PROYECTO.search(descripcion or '')
    proyecto = str(int(m.group(1))) if m else None
    if RX_INFORME.search(t):
        return 'informe_minoria', proyecto, None, False, False
    if not proyecto:
        return ('nombramiento' if RX_NOMBRAMIENTO.search(t) else 'otra'), None, None, False, False
    debate = 'Segundo' if re.search(r'\bsegundo\b', t, re.I) else 'Tercer' if re.search(r'\btercer\b', t, re.I) else None
    inferido = False
    if not debate:
        # Sin la palabra en el título: en tercer debate se pregunta "¿Quiere la Asamblea que … sea Ley?";
        # en segundo debate se vota el título del proyecto.
        if 'final' in tipos_pregunta: debate, inferido = 'Tercer', True
        elif 'titulo' in tipos_pregunta: debate, inferido = 'Segundo', True
    return 'proyecto', proyecto, debate, inferido, bool(re.search(r'objetad', t, re.I))

def tipo_pregunta(titulo):
    t = (titulo or '').strip()
    if re.search(r'quieren?\s+(?:la\s+asamblea|el\s+pleno)', t, re.I): return 'final'
    if re.match(r't[ií]tulo\b', t, re.I): return 'titulo'
    if re.match(r'art[ií]culo\b', t, re.I): return 'articulo'
    return 'otra'

def limpiar(s):
    return re.sub(r'\s+', ' ', (s or '')).strip()


# ─────────────────────────────────────────────
# RESULTADO
# ─────────────────────────────────────────────
# Regla verificada con las 2.388 preguntas de la legislatura (coincide en el 100 %):
#   result = 1 (Aprobado) ⇔ la opción afirmativa más votada ("A favor" o una "Modificado por …") ≥ votesToPass
#   result = 2 (Rechazado) en caso contrario.
# votesToPass es 36 (mayoría absoluta de 71) o 48 (dos tercios, p. ej. insistencias).
def resultado_esperado(pregunta):
    afirm = [a['total'] for a in pregunta['answers'] if a['id'] not in (2, 3)]
    return 1 if max(afirm or [0]) >= pregunta['votesToPass'] else 2

NOMBRE_RESULTADO = {1: 'Aprobado', 2: 'Rechazado'}


# ─────────────────────────────────────────────
# DESCARGA
# ─────────────────────────────────────────────
class API507:
    def __init__(self):
        import requests
        self.s = requests.Session()
        self.s.headers['User-Agent'] = 'ObservatorioLegislativoPA/1.0 (+https://observatoriolegistalivopa.netlify.app)'
        self.ultimo = 0.0

    def get(self, ruta):
        ultimo_error = None
        for intento in range(REINTENTOS):
            espera = PAUSA - (time.time() - self.ultimo)
            if espera > 0: time.sleep(espera)
            try:
                r = self.s.get(API + ruta, timeout=TIMEOUT)
                self.ultimo = time.time()
                r.raise_for_status()
                return r.json()
            except Exception as e:
                self.ultimo = time.time()
                ultimo_error = e
                print(f"    {ruta}: intento {intento + 1} falló ({e})")
                time.sleep(3 * (intento + 1))
        raise RuntimeError(f"{ruta}: {ultimo_error}")


# ─────────────────────────────────────────────
# VINCULACIÓN DE DIPUTADOS
# ─────────────────────────────────────────────
class VinculadorVotantes:
    """
    Relaciona los diputados de prensa507 (id, nombre, circuito) con los de Espacio Cívico.
    1. Nombre (mismo emparejador que los proponentes) y circuito igual → 'nombre+circuito'.
    2. Nombre único pero circuito distinto o vacío → 'nombre' (se reporta para revisión).
    3. Sin coincidencia de nombre: un solo diputado de ese circuito comparte un apellido → 'circuito+apellido'.
    4. Sin nada de lo anterior: sus suplentes en prensa507 coinciden con el suplente publicado de un único
       diputado → 'suplente'.
    El suplente también confirma los criterios 2 y 3 ('+suplente'); un conflicto de circuito confirmado
    por el suplente no se reporta. Si dos ids de prensa507 caen en el mismo diputado, ninguno se asigna.
    Los suplentes heredan el vínculo de su principal.
    """
    def __init__(self, dips):
        self.dips = dips
        self.por_slug = {d['slug']: d for d in dips if d.get('slug')}
        self.emp = EmparejadorDiputados(dips)

    def _por_suplente(self, nombres):
        """Diputados cuyo suplente publicado coincide con alguno de estos nombres."""
        out = set()
        for n in nombres:
            hit = self.emp.buscar('H.D.S ' + n)
            if hit and hit[1]: out.add(hit[0]['slug'])
        return out

    def vincular(self, principales, suplentes):
        """principales: {deputy_id: deputy de la API}; suplentes: {deputy_id principal: {nombres}}
        → ({deputy_id: (slug, metodo)}, conflictos)"""
        res, conflictos = {}, []
        for did, dp in principales.items():
            if did in VINCULOS_MANUALES:
                slug = VINCULOS_MANUALES[did]
                if slug: res[did] = (slug, 'manual')
                continue
            nombre = f"{dp['user']['name']} {dp['user']['lastname']}"
            circ = dp.get('circuit')
            por_sup = self._por_suplente(suplentes.get(did, ()))
            hit = self.emp.buscar(nombre)
            if hit and not hit[1]:
                d = hit[0]
                if d.get('circuito') == circ:
                    res[did] = (d['slug'], 'nombre+circuito')
                elif d['slug'] in por_sup:
                    res[did] = (d['slug'], 'nombre+suplente')
                else:
                    res[did] = (d['slug'], 'nombre')
                    conflictos.append({'deputy_id': did, 'nombre': nombre, 'circuito_api': circ,
                                       'diputado': d['nombre'], 'circuito_ec': d.get('circuito')})
                continue
            if circ:
                apellidos = set(tokens_nombre(dp['user']['lastname']))
                cands = [d for d in self.dips if d.get('circuito') == circ
                         and apellidos & set(tokens_nombre(d['nombre']))]
                if len(cands) == 1:
                    s = cands[0]['slug']
                    res[did] = (s, 'circuito+apellido+suplente' if s in por_sup else 'circuito+apellido')
                    continue
            if len(por_sup) == 1:
                res[did] = (por_sup.pop(), 'suplente')
        # Un diputado de Espacio Cívico no puede corresponder a dos ids distintos
        usados = Counter(slug for slug, _ in res.values())
        for did in [k for k, (slug, _) in res.items() if usados[slug] > 1]:
            conflictos.append({'deputy_id': did, 'nombre': principales[did]['user']['name'],
                               'motivo': f"varios ids apuntan a {res[did][0]}"})
            del res[did]
        return res, conflictos


# ─────────────────────────────────────────────
# NORMALIZACIÓN
# ─────────────────────────────────────────────
def normalizar_reporte(rep):
    """Reporte público → (votaciones, preguntas, votos, diputados vistos). Sin vincular aún."""
    ses = rep.get('plenarySession') or {}
    fecha = (ses.get('date') or '')[:10]
    vots, pregs, votos, deps = [], [], [], {}
    for v in ses.get('votings') or []:
        if v.get('deletedAt'): continue
        qs = [q for q in v.get('questions') or [] if q.get('answers') is not None]
        if not qs: continue
        tipos = [tipo_pregunta(q.get('title')) for q in qs]
        tipo, proyecto, debate, inferido, objetado = clasificar_votacion(v.get('title'), set(tipos), v.get('description'))
        vots.append({'votacion_id': v['id'], 'reporte_id': rep['id'], 'sesion_id': ses.get('id'), 'fecha': fecha,
                     'tipo': tipo, 'proyecto': proyecto or '', 'ficha': '', 'debate': debate or '',
                     'debate_inferido': int(inferido), 'objetado': int(objetado),
                     'titulo': limpiar(v.get('title')), 'descripcion': limpiar(v.get('description')),
                     'preside_id': ses.get('presidentId') or ''})   # deputy_id de quien preside la sesión
        for orden, (q, tq) in enumerate(zip(qs, tipos), 1):
            tot = {a['id']: a['total'] for a in q['answers']}
            desc = {a['id']: limpiar(a['description']) for a in q['answers']}
            art = limpiar(q.get('title'))
            pregs.append({'question_id': q['id'], 'votacion_id': v['id'], 'orden': orden, 'articulo': art,
                          'tipo_pregunta': tq, 'resultado': q.get('result'), 'votos_necesarios': q.get('votesToPass'),
                          'total_favor': tot.get(1, 0), 'total_contra': tot.get(2, 0), 'total_abst': tot.get(3, 0),
                          'total_modificaciones': sum(n for k, n in tot.items() if k not in RESPUESTAS),
                          '_answers': q['answers'], '_esperado': resultado_esperado(q)})
            for vt in q.get('votes') or []:
                dp = vt['deputy']
                pr = dp.get('principal')
                deps[dp['id']] = dp
                if pr: deps.setdefault(pr['id'], pr)
                votos.append({'votacion_id': v['id'], 'question_id': q['id'], 'articulo': art,
                              'deputy_id': dp['id'], 'diputado': limpiar(f"{dp['user']['name']} {dp['user']['lastname']}"),
                              'principal': limpiar(f"{pr['user']['name']} {pr['user']['lastname']}") if pr else '',
                              'partido': (dp.get('politicalParty') or {}).get('code', ''),
                              'circuito': dp.get('circuit') or '',
                              'voto': desc.get(vt['answerId'], ''), 'respuesta_id': vt['answerId'],
                              'sentido': RESPUESTAS.get(vt['answerId'], 'favor'),
                              'principal_id': pr['id'] if pr else '', 'slug': ''})
    return vots, pregs, votos, deps


# ─────────────────────────────────────────────
# CSV
# ─────────────────────────────────────────────
def leer_csv(ruta):
    if not os.path.exists(ruta): return []
    with open(ruta, encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def escribir_csv(ruta, cols, filas):
    tmp = ruta + '.tmp'
    with open(tmp, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(filas)
    os.replace(tmp, ruta)

def _int(v):
    try: return int(v)
    except (TypeError, ValueError): return None


# ─────────────────────────────────────────────
# VOTO GLOBAL Y TOTALES
# ─────────────────────────────────────────────
# Voto global de un diputado en una votación:
#   1. su voto en la pregunta final ("¿Quiere la Asamblea que … sea Ley?"), si existe y votó en ella;
#   2. si no, su voto en la pregunta del título del proyecto;
#   3. si no, el sentido mayoritario de sus votos en los artículos (empate → sin voto global).
# "Modificado por …" cuenta como a favor (aprueba el artículo con cambios).
def pregunta_referencia(pregs):
    for t in ('final', 'titulo'):
        cand = [p for p in pregs if p['tipo_pregunta'] == t]
        if cand: return cand[-1]
    return None

def votos_globales(pregs, votos_v):
    """→ {deputy_id: 'favor'|'contra'|'abstencion'|None}"""
    ref = pregunta_referencia(pregs)
    por_dep = defaultdict(dict)
    for vt in votos_v:
        por_dep[vt['deputy_id']][vt['question_id']] = vt['sentido']
    orden_ref = [p['question_id'] for p in pregs if p['tipo_pregunta'] in ('final', 'titulo')][::-1]
    out = {}
    for did, qs in por_dep.items():
        g = next((qs[q] for q in orden_ref if q in qs), None)
        if g is None:
            c = Counter(qs.values()).most_common()
            g = c[0][0] if len(c) == 1 or c[0][1] > c[1][1] else None
        out[did] = g
    return out, ref

def totales_votacion(v, pregs, votos_v):
    """Resultado y totales de la votación. Con pregunta de referencia, son exactamente los de la API."""
    glob, ref = votos_globales(pregs, votos_v)
    if ref:
        res = NOMBRE_RESULTADO.get(_int(ref['resultado']), '')
        tf = _int(ref['total_favor']) + _int(ref['total_modificaciones'])
        tc, ta = _int(ref['total_contra']), _int(ref['total_abst'])
    else:
        rs = {_int(p['resultado']) for p in pregs}
        res = 'Aprobado' if rs == {1} else 'Rechazado' if rs == {2} else 'Mixto'
        c = Counter(glob.values())
        tf, tc, ta = c['favor'], c['contra'], c['abstencion']
    v.update({'resultado': res, 'total_favor': tf, 'total_contra': tc, 'total_abst': ta,
              'n_preguntas': len(pregs), 'n_aprobadas': sum(1 for p in pregs if _int(p['resultado']) == 1)})
    return glob


# ─────────────────────────────────────────────
# PROCESO
# ─────────────────────────────────────────────
def _ahora():
    return datetime.now(timezone(timedelta(hours=-5)))   # hora de Panamá

def obtener_reportes(api, estado, desde_carpeta=None):
    """Descarga los reportes nuevos. → (nuevos [(id, reporte)], resumen de la lista, fallidos, pendientes)"""
    if desde_carpeta:
        lista = json.load(open(os.path.join(desde_carpeta, '..', 'reports.json'), encoding='utf-8'))['reports']
    else:
        lista = api.get('/reports?paginated=false')['reports']
    hoy = _ahora().date()
    procesados = set(estado.get('procesados', []))
    leg = [r for r in lista if ((r.get('plenarySession') or {}).get('date') or '') >= INICIO_LEGISLATURA]
    vacios = [r for r in leg if not r.get('votings')]
    candidatos, nuevos_vacios = [], []
    for r in leg:
        if r['id'] in procesados: continue
        if r.get('votings'):
            candidatos.append(r['id'])
        else:
            dias = (hoy - datetime.fromisoformat(r['plenarySession']['date'][:10]).date()).days
            if dias > DIAS_REVISAR_VACIOS: nuevos_vacios.append(r['id'])   # sesión sin votación: no se vuelve a revisar
    nuevos, fallidos, inicio = [], [], time.time()
    candidatos.sort()
    for i, rid in enumerate(candidatos):
        if time.time() - inicio > MAX_MINUTOS * 60:
            print(f"  Presupuesto de {MAX_MINUTOS} min agotado: quedan {len(candidatos) - i} reportes para la próxima corrida.")
            break
        try:
            if desde_carpeta and os.path.exists(os.path.join(desde_carpeta, f'{rid}.json')):
                rep = json.load(open(os.path.join(desde_carpeta, f'{rid}.json'), encoding='utf-8'))['report']
            else:
                rep = api.get(f'/report/{rid}/public')['report']
            nuevos.append((rid, rep))
            print(f"  [{i + 1}/{len(candidatos)}] reporte {rid}: {len((rep.get('plenarySession') or {}).get('votings') or [])} votaciones")
        except Exception as e:
            fallidos.append(rid)
            print(f"  reporte {rid}: no se pudo descargar ({e})")
    pendientes = len(candidatos) - len(nuevos) - len(fallidos)
    info = {'reportes_api': len(lista), 'reportes_legislatura': len(leg), 'reportes_sin_votacion': len(vacios)}
    return nuevos, nuevos_vacios, fallidos, pendientes, info

def cargar_dips():
    return (_leer_json('diputados.json') or {}).get('diputados', [])

def fichas_por_proyecto():
    datos = (_leer_json('datos.json') or {}).get('datos', [])
    return {str(int(r['proyecto'])): r['ficha'] for r in datos if (r.get('proyecto') or '').strip().isdigit()}

def procesar(desde_carpeta=None, sin_descarga=False):
    ts = _ahora()
    estado = _leer_json(ESTADO) or {'procesados': []}
    calidad = {'fecha': ts.isoformat(timespec='seconds'), 'estado': 'ok'}

    vots = leer_csv(CSV_VOTACIONES)
    pregs = leer_csv(CSV_PREGUNTAS)
    votos = leer_csv(CSV_VOTOS)
    print(f"  Guardado: {len(vots)} votaciones, {len(pregs)} preguntas, {len(votos)} votos")

    nuevas_ids, api_deps = [], {}
    if not sin_descarga:
        try:
            api = API507()
            nuevos, vacios, fallidos, pendientes, info = obtener_reportes(api, estado, desde_carpeta)
            calidad.update(info)
        except Exception as e:
            # La lista no respondió: se conservan los datos anteriores tal cual
            print(f"  ADVERTENCIA: la API de prensa507 no respondió ({e}); se conservan las votaciones guardadas.")
            calidad.update({'estado': 'respaldo', 'error': str(e)})
            nuevos, vacios, fallidos, pendientes = [], [], [], 0
        ya = {_int(v['votacion_id']) for v in vots}
        for rid, rep in nuevos:
            nv, np_, nvt, deps = normalizar_reporte(rep)
            api_deps.update(deps)
            # La misma votación puede aparecer en dos reportes: se queda la primera
            aceptadas = {v['votacion_id'] for v in nv} - ya
            ya |= aceptadas
            nuevas_ids += sorted(aceptadas)
            vots += [v for v in nv if v['votacion_id'] in aceptadas]
            pregs += [p for p in np_ if p['votacion_id'] in aceptadas]
            votos += [x for x in nvt if x['votacion_id'] in aceptadas]
        # Un reporte con votaciones solo se marca como procesado si se descargó completo
        estado['procesados'] = sorted(set(estado.get('procesados', [])) | {rid for rid, _ in nuevos} | set(vacios))
        calidad.update({'reportes_nuevos': len(nuevos), 'reportes_fallidos': fallidos, 'reportes_pendientes': pendientes,
                        'votaciones_nuevas': len(nuevas_ids)})

    # Consistencia de lo recién descargado: totales de la API vs. votos individuales, y la regla de resultado
    inconsistentes, regla_falla = [], []
    ids_nuevas = set(nuevas_ids)
    cuenta = Counter((x['question_id'], x['respuesta_id']) for x in votos if x['votacion_id'] in ids_nuevas)
    for p in pregs:
        if '_answers' not in p: continue
        for a in p['_answers']:
            if cuenta[(p['question_id'], a['id'])] != a['total']:
                inconsistentes.append({'question_id': p['question_id'], 'respuesta': a['id'], 'api': a['total'],
                                       'votos': cuenta[(p['question_id'], a['id'])]})
        if p['_esperado'] != p['resultado']:
            regla_falla.append(p['question_id'])
    calidad['totales_inconsistentes'] = inconsistentes
    calidad['regla_resultado_no_cumple'] = regla_falla

    # Vinculación de diputados (se recalcula siempre con el diputados.json vigente)
    dips = cargar_dips()
    principales, circuitos, suplentes = {}, defaultdict(Counter), defaultdict(set)
    for x in votos:
        did = _int(x['deputy_id'])
        pid = _int(x['principal_id'])
        base = pid or did
        principales.setdefault(base, {'id': base, 'nombre': x['principal'] if pid else x['diputado']})
        if pid: suplentes[pid].add(x['diputado'])
        if x['circuito']: circuitos[base][x['circuito']] += 1
    # Si el principal no trae circuito, se usa el de sus suplentes (comparten curul)
    for base, p in principales.items():
        p['circuit'] = circuitos[base].most_common(1)[0][0] if circuitos[base] else None
    # El nombre en dos partes (nombre / apellido) se usa para el criterio circuito+apellido
    nombres_api = estado.get('nombres_api', {})
    for did, dp in api_deps.items():
        nombres_api[str(did)] = [dp['user']['name'], dp['user']['lastname'], dp.get('circuit')]
    estado['nombres_api'] = nombres_api
    for did, p in principales.items():
        n = nombres_api.get(str(did))
        p['user'] = {'name': n[0], 'lastname': n[1]} if n else {'name': p['nombre'], 'lastname': p['nombre']}
    vinc, conflictos = VinculadorVotantes(dips).vincular(principales, suplentes) if dips else ({}, [])
    for x in votos:
        base = _int(x['principal_id']) or _int(x['deputy_id'])
        x['slug'] = vinc.get(base, ('', ''))[0]

    # Vinculación con datos.json por número de proyecto
    fichas = fichas_por_proyecto()
    for v in vots:
        v['ficha'] = fichas.get(v['proyecto'], '') if v['proyecto'] else ''

    # Totales y resultado de cada votación
    pregs_por_v, votos_por_v = defaultdict(list), defaultdict(list)
    for p in pregs: pregs_por_v[_int(p['votacion_id'])].append(p)
    for x in votos:
        x['votacion_id'], x['question_id'], x['deputy_id'] = _int(x['votacion_id']), _int(x['question_id']), _int(x['deputy_id'])
        votos_por_v[x['votacion_id']].append(x)
    for v in vots:
        v['votacion_id'] = _int(v['votacion_id'])
        ps = sorted(pregs_por_v[v['votacion_id']], key=lambda p: _int(p['orden']))
        for p in ps: p['question_id'] = _int(p['question_id'])
        v['_globales'] = totales_votacion(v, ps, votos_por_v[v['votacion_id']])

    vots.sort(key=lambda v: (v['fecha'], v['votacion_id']), reverse=True)
    pregs.sort(key=lambda p: (-_int(p['votacion_id']), _int(p['orden'])))
    votos.sort(key=lambda x: (-x['votacion_id'], x['question_id'], x['deputy_id']))

    if calidad['estado'] == 'ok' and not sin_descarga:
        estado['ultima_extraccion'] = ts.isoformat(timespec='seconds')
    escribir_csv(CSV_VOTACIONES, COLS_VOTACIONES, vots)
    escribir_csv(CSV_PREGUNTAS, COLS_PREGUNTAS, pregs)
    escribir_csv(CSV_VOTOS, COLS_VOTOS, votos)
    generar_detalles(vots, pregs_por_v, votos_por_v, api_deps, estado)
    metricas = calcular_metricas(vots, pregs_por_v, votos_por_v, estado, ts)
    generar_lista(vots, estado, ts, metricas)

    # Log de calidad
    votos_sin = Counter()
    for x in votos:
        if not x['slug']:
            base = _int(x['principal_id']) or x['deputy_id']
            votos_sin[base] += 1
    calidad.update({
        'votaciones_total': len(vots), 'preguntas_total': len(pregs), 'votos_total': len(votos),
        'votaciones_por_tipo': dict(Counter(v['tipo'] for v in vots)),
        'sin_proyecto': [{'votacion_id': v['votacion_id'], 'fecha': v['fecha'], 'tipo': v['tipo'], 'titulo': v['titulo']}
                         for v in vots if v['tipo'] != 'proyecto'],
        'proyecto_sin_ficha': [{'votacion_id': v['votacion_id'], 'proyecto': v['proyecto'], 'titulo': v['titulo']}
                               for v in vots if v['proyecto'] and not v['ficha']],
        'debate_desconocido': [{'votacion_id': v['votacion_id'], 'titulo': v['titulo']}
                               for v in vots if v['tipo'] == 'proyecto' and not v['debate']],
        'diputados_vinculados': len(vinc),
        'diputados_sin_vincular': [{'deputy_id': did, 'nombre': principales[did]['nombre'],
                                    'circuito': principales[did].get('circuit'), 'votos': n}
                                   for did, n in votos_sin.most_common()],
        'conflictos_vinculacion': conflictos,
        'metodos_vinculacion': dict(Counter(m for _, m in vinc.values())),
    })
    hist = (_leer_json(CALIDAD) or {}).get('corridas', [])
    resumen_corrida = {k: calidad.get(k) for k in ('fecha', 'estado', 'reportes_nuevos', 'votaciones_nuevas',
                                                    'votaciones_total', 'reportes_pendientes')}
    resumen_corrida['sin_proyecto'] = len(calidad['sin_proyecto'])
    resumen_corrida['proyecto_sin_ficha'] = len(calidad['proyecto_sin_ficha'])
    resumen_corrida['diputados_sin_vincular'] = len(calidad['diputados_sin_vincular'])
    calidad['corridas'] = ([resumen_corrida] + hist)[:90]
    with open(CALIDAD, 'w', encoding='utf-8') as f:
        json.dump(calidad, f, ensure_ascii=False, indent=1)
    with open(ESTADO, 'w', encoding='utf-8') as f:
        json.dump(estado, f, ensure_ascii=False, separators=(',', ':'))

    print(f"  Votaciones: {len(vots)} ({len(nuevas_ids)} nuevas) · preguntas {len(pregs)} · votos {len(votos)}")
    print(f"  Sin proyecto: {len(calidad['sin_proyecto'])} · proyecto sin ficha en datos.json: {len(calidad['proyecto_sin_ficha'])}"
          f" · diputados sin vincular: {len(calidad['diputados_sin_vincular'])} · conflictos: {len(conflictos)}")
    if inconsistentes: print(f"  ADVERTENCIA: {len(inconsistentes)} totales de la API no cuadran con los votos individuales")
    if regla_falla: print(f"  ADVERTENCIA: {len(regla_falla)} preguntas no cumplen la regla de resultado")
    return calidad


# ─────────────────────────────────────────────
# MÉTRICAS (segmentadas por tipo de votación)
# ─────────────────────────────────────────────
SEGMENTOS = {'proyecto': 'Proyectos de ley', 'nombramiento': 'Nombramientos y ratificaciones',
             'informe_minoria': 'Informes de minoría', 'otra': 'Otras votaciones'}
# Unidad de decisión: en proyectos y "otras" cada votación es una decisión (voto global del diputado);
# en nombramientos e informes de minoría cada pregunta es una decisión (se vota persona por persona).
POR_PREGUNTA = {'nombramiento', 'informe_minoria'}
# Sin partido como tal: no tiene sentido medir cohesión ni disidencia respecto a una "mayoría" de independientes
SIN_PARTIDO = {'IND'}
N_RECIENTES = 12

def _division(f, c, a):
    """0 = unánime; 1 = mitad a favor, mitad en contra o abstención."""
    n = f + c + a
    return round(1 - abs(f - (c + a)) / n, 3) if n else None

def decisiones(vots, pregs_por_v, votos_por_v):
    """→ [{seg, fecha, votacion_id, question_id, favor, contra, abst, votos: [(fila de voto, sentido)]}]"""
    out = []
    for v in vots:
        vid = v['votacion_id']
        if v['tipo'] in POR_PREGUNTA:
            vq = defaultdict(list)
            for x in votos_por_v[vid]: vq[x['question_id']].append(x)
            for p in pregs_por_v[vid]:
                out.append({'seg': v['tipo'], 'fecha': v['fecha'], 'votacion_id': vid, 'question_id': p['question_id'],
                            'titulo': p['articulo'],
                            'favor': _int(p['total_favor']) + _int(p['total_modificaciones']),
                            'contra': _int(p['total_contra']), 'abst': _int(p['total_abst']),
                            'votos': [(x, x['sentido']) for x in vq[p['question_id']]]})
        else:
            una = {}
            for x in votos_por_v[vid]: una.setdefault(x['deputy_id'], x)   # una fila por diputado (datos personales)
            g = v['_globales']
            out.append({'seg': v['tipo'], 'fecha': v['fecha'], 'votacion_id': vid, 'question_id': None,
                        'titulo': v['descripcion'] or v['titulo'], 'favor': v['total_favor'], 'contra': v['total_contra'],
                        'abst': v['total_abst'],
                        'votos': [(una[did], s) for did, s in g.items() if s]})
    return out

def _pct(n, d):
    return round(100 * n / d, 1) if d else None

def calcular_metricas(vots, pregs_por_v, votos_por_v, estado, ts):
    decs = decisiones(vots, pregs_por_v, votos_por_v)
    por_v = {v['votacion_id']: v for v in vots}
    total_seg = Counter(d['seg'] for d in decs)
    partidos_api = estado.get('partidos', {})

    dip = defaultdict(lambda: {'seg': defaultdict(Counter), 'suplente': Counter(), 'recientes': [], 'nombre': '',
                               'partidos': Counter()})
    par = defaultdict(lambda: {'seg': defaultdict(Counter), 'mes': defaultdict(lambda: defaultdict(Counter)),
                               'slugs': Counter()})
    gen = defaultdict(lambda: {'decisiones': 0, 'unanimes': 0, 'por_mes': Counter()})
    acuerdo = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    votpart = defaultdict(lambda: defaultdict(Counter))

    for d in decs:
        seg, mes = d['seg'], d['fecha'][:7]
        g = gen[seg]
        g['decisiones'] += 1
        g['por_mes'][mes] += 1
        if d['contra'] + d['abst'] == 0: g['unanimes'] += 1
        # Mayoría de cada partido en esta decisión (principales y suplentes que votaron).
        # Cohesión: votos alineados con la opción más votada del partido (en un empate 1-1, la mitad).
        # Disidencia: solo cuando hay una mayoría estricta; en un empate nadie es disidente.
        por_partido = defaultdict(Counter)
        for x, s in d['votos']:
            if x['partido'] not in SIN_PARTIDO: por_partido[x['partido']][s] += 1
        for x, s in d['votos']:
            votpart[d['votacion_id']][x['partido']][s] += 1
        mayoria = {}
        for code, c in por_partido.items():
            n = sum(c.values())
            if n < 2: continue
            top = c.most_common(2)
            if len(top) == 1 or top[0][1] > top[1][1]:
                mayoria[code] = top[0][0]
            ali = top[0][1]
            for k in (seg, 'todas'):
                par[code]['seg'][k]['votos'] += n
                par[code]['seg'][k]['alineados'] += ali
                par[code]['seg'][k]['decisiones'] += 1
                par[code]['mes'][k][mes]['votos'] += n
                par[code]['mes'][k][mes]['alineados'] += ali
        # Acuerdo entre bancadas: decisiones en que las mayorías de dos partidos coinciden
        cods = sorted(mayoria)
        for i, a in enumerate(cods):
            for b in cods[i + 1:]:
                for k in (seg, 'todas'):
                    acuerdo[k][(a, b)][1] += 1
                    acuerdo[k][(a, b)][0] += int(mayoria[a] == mayoria[b])
        for x, s in d['votos']:
            slug = x['slug']
            if not slug: continue
            if x['principal_id'] not in ('', None):   # votó el suplente: se cuenta aparte, asociado al principal
                for k in (seg, 'todas'): dip[slug]['suplente'][k] += 1
                continue
            r = dip[slug]
            r['nombre'] = x['diputado']
            r['partidos'][x['partido']] += 1
            par[x['partido']]['slugs'][slug] += 1
            dis = None
            if x['partido'] in mayoria:
                dis = s != mayoria[x['partido']]
            for k in (seg, 'todas'):
                c = r['seg'][k]
                c['participo'] += 1
                c[s] += 1
                if dis is not None:
                    c['base_disidencia'] += 1
                    c['disidencias'] += int(dis)
                    if dis: par[x['partido']]['seg'][k]['disidencias'] += 1
            v = por_v[d['votacion_id']]
            r['recientes'].append({'votacion_id': d['votacion_id'], 'question_id': d['question_id'], 'fecha': d['fecha'],
                                   'tipo': seg, 'proyecto': v['proyecto'] or None, 'debate': v['debate'] or None,
                                   'titulo': (d['titulo'] or '')[:120], 'voto': s, 'disidente': bool(dis)})

    total_seg['todas'] = sum(total_seg.values())
    def resumen_seg(c, total):
        p = c['participo']
        return {'decisiones': total, 'participo': p, 'favor': c['favor'], 'contra': c['contra'],
                'abstencion': c['abstencion'], 'pct_favor': _pct(c['favor'], p), 'pct_contra': _pct(c['contra'], p),
                'pct_abstencion': _pct(c['abstencion'], p), 'disidencias': c['disidencias'],
                'base_disidencia': c['base_disidencia'], 'tasa_disidencia': _pct(c['disidencias'], c['base_disidencia'])}

    diputados = {}
    for slug, r in sorted(dip.items()):
        r['recientes'].sort(key=lambda e: (e['fecha'], e['votacion_id'], e['question_id'] or 0), reverse=True)
        diputados[slug] = {
            'nombre_api': r['nombre'],
            'partido_api': r['partidos'].most_common(1)[0][0] if r['partidos'] else None,
            'segmentos': {k: resumen_seg(r['seg'][k], total_seg[k]) for k in ['todas', *SEGMENTOS] if r['seg'][k]['participo']},
            'como_suplente': dict(r['suplente']),
            'recientes': r['recientes'][:N_RECIENTES],
        }

    # Nombre del partido en el resto del sitio (Espacio Cívico): el que tiene la mayoría de sus diputados
    dips = {d['slug']: d for d in cargar_dips() if d.get('slug')}
    partidos = {}
    for code, p in sorted(par.items()):
        sitio = Counter()
        for slug, n in p['slugs'].items():
            if slug in dips: sitio[dips[slug].get('partido')] += 1
        top = sitio.most_common(2)
        nombre_sitio = top[0][0] if top and (len(top) == 1 or top[0][1] > top[1][1]) else None
        info = partidos_api.get(code, {})
        segs = {}
        for k, c in p['seg'].items():
            if not c['votos']: continue
            segs[k] = {'decisiones': c['decisiones'], 'votos': c['votos'], 'alineados': c['alineados'],
                       'cohesion': _pct(c['alineados'], c['votos']), 'disidencias': c['disidencias'],
                       'mensual': {m: _pct(x['alineados'], x['votos']) for m, x in sorted(p['mes'][k].items())}}
        partidos[code] = {'nombre': info.get('nombre'), 'color': info.get('color'), 'partido_sitio': nombre_sitio,
                          'diputados': len(p['slugs']), 'segmentos': segs}

    generales = {}
    for seg, g in gen.items():
        generales[seg] = {'decisiones': g['decisiones'], 'unanimes': g['unanimes'],
                          'divididas': g['decisiones'] - g['unanimes'],
                          'pct_unanimes': _pct(g['unanimes'], g['decisiones']),
                          'por_mes': dict(sorted(g['por_mes'].items()))}
    # Proyectos más divididos: mayor división en cualquiera de sus debates
    div = {}
    for v in vots:
        if v['tipo'] != 'proyecto': continue
        dv = _division(v['total_favor'], v['total_contra'], v['total_abst'])
        if dv is not None and (v['proyecto'] not in div or dv > div[v['proyecto']]['division']):
            div[v['proyecto']] = {'proyecto': v['proyecto'], 'ficha': v['ficha'] or None, 'votacion_id': v['votacion_id'],
                                  'fecha': v['fecha'], 'debate': v['debate'] or None, 'descripcion': v['descripcion'][:160],
                                  'favor': v['total_favor'], 'contra': v['total_contra'], 'abst': v['total_abst'],
                                  'resultado': v['resultado'], 'division': dv}
    mas_divididos = sorted(div.values(), key=lambda x: (-x['division'], x['fecha']))[:15]

    etapas = {r['ficha']: r.get('etapa') for r in (_leer_json('datos.json') or {}).get('datos', [])}
    for v in vots:
        v['unanime'] = v['total_contra'] + v['total_abst'] == 0
        v['division'] = _division(v['total_favor'], v['total_contra'], v['total_abst'])
        # Votos por partido [a favor, en contra, abstención] (voto global; por pregunta en nombramientos e informes)
        v['por_partido'] = {code: [c['favor'], c['contra'], c['abstencion']]
                            for code, c in sorted(votpart[v['votacion_id']].items())}
        v['etapa_actual'] = etapas.get(v['ficha']) if v['ficha'] else None

    acuerdo_out = {k: {f'{a}|{b}': {'coinciden': c, 'decisiones': n, 'pct': _pct(c, n)} for (a, b), (c, n) in sorted(m.items())}
                   for k, m in acuerdo.items()}
    salida = {'actualizado': ts.isoformat(timespec='seconds'), 'desde': INICIO_LEGISLATURA,
              'segmentos': SEGMENTOS, 'unidad_por_pregunta': sorted(POR_PREGUNTA), 'sin_partido': sorted(SIN_PARTIDO),
              'diputados': diputados, 'partidos': partidos, 'generales': generales, 'mas_divididos': mas_divididos,
              'acuerdo_partidos': acuerdo_out}
    with open(JSON_METRICAS, 'w', encoding='utf-8') as f:
        json.dump(salida, f, ensure_ascii=False, separators=(',', ':'))
    generar_matriz(vots, votos_por_v)
    return salida

def generar_matriz(vots, votos_por_v):
    """
    votos_matriz.json: una cadena por diputado con un carácter por votación (de la más antigua a la más reciente).
    F/C/A = votó él a favor / en contra / abstención; f/c/a = votó su suplente; - = voto global sin definir;
    . = no registró voto (ni él ni su suplente).
    """
    orden = sorted(vots, key=lambda v: (v['fecha'], v['votacion_id']))
    letra = {'favor': 'F', 'contra': 'C', 'abstencion': 'A'}
    slugs = sorted({x['slug'] for x in votos_por_v.values() for x in x if x['slug']})
    filas = {s: [] for s in slugs}
    for v in orden:
        g = v['_globales']
        propio, suplente = {}, {}
        for x in votos_por_v[v['votacion_id']]:
            if not x['slug']: continue
            (suplente if x['principal_id'] not in ('', None) else propio)[x['slug']] = x['deputy_id']
        for s in slugs:
            if s in propio: c = letra.get(g.get(propio[s]), '-')
            elif s in suplente: c = letra.get(g.get(suplente[s]), '-').lower()
            else: c = '.'
            filas[s].append(c)
    with open(JSON_MATRIZ, 'w', encoding='utf-8') as f:
        json.dump({'votaciones': [v['votacion_id'] for v in orden], 'diputados': {s: ''.join(c) for s, c in filas.items()}},
                  f, ensure_ascii=False, separators=(',', ':'))


# ─────────────────────────────────────────────
# SALIDAS PARA EL SITIO
# ─────────────────────────────────────────────
def _partidos(estado):
    return estado.get('partidos', {})

def generar_detalles(vots, pregs_por_v, votos_por_v, api_deps, estado):
    """votaciones/{id}.json: preguntas y voto de cada diputado. Compacto: se carga al abrir una votación."""
    partidos = estado.setdefault('partidos', {})
    for dp in api_deps.values():
        pp = dp.get('politicalParty') or {}
        if pp.get('code'): partidos[pp['code']] = {'nombre': pp.get('name'), 'color': pp.get('color')}
    os.makedirs(CARPETA_DETALLE, exist_ok=True)
    slug_de = {x['deputy_id']: x['slug'] for l in votos_por_v.values() for x in l if x['slug']}
    for v in vots:
        vid = v['votacion_id']
        ruta = os.path.join(CARPETA_DETALLE, f'{vid}.json')
        ps = sorted(pregs_por_v[vid], key=lambda p: _int(p['orden']))
        idx = {p['question_id']: i for i, p in enumerate(ps)}
        opciones = [defaultdict(int) for _ in ps]
        textos = {}
        filas = {}
        for x in votos_por_v[vid]:
            i = idx.get(x['question_id'])
            if i is None: continue
            rid = _int(x['respuesta_id'])
            opciones[i][rid] += 1
            textos[rid] = x['voto']
            f = filas.setdefault(x['deputy_id'], {'d': x['deputy_id'], 'n': x['diputado'], 's': x['slug'] or None,
                                                  'p': x['partido'], 'c': x['circuito'],
                                                  'su': x['principal'] or None, 'v': [0] * len(ps)})
            f['v'][i] = rid
        for did, f in filas.items():
            f['g'] = {'favor': 'F', 'contra': 'C', 'abstencion': 'A'}.get(v['_globales'].get(did))
        det = {'id': vid,
               'preside': slug_de.get(_int(v.get('preside_id'))),   # curul de quien preside (se dibuja aparte)
               'preguntas': [{'id': p['question_id'], 't': p['articulo'], 'k': p['tipo_pregunta'],
                              'r': _int(p['resultado']), 'n': _int(p['votos_necesarios']),
                              'o': [[rid, textos.get(rid, ''), n] for rid, n in sorted(opciones[i].items(),
                                    key=lambda kv: (kv[0] > 3, kv[0]))]}
                             for i, p in enumerate(ps)],
               'votos': sorted(filas.values(), key=lambda f: (f['p'], f['n']))}
        with open(ruta, 'w', encoding='utf-8') as f:
            json.dump(det, f, ensure_ascii=False, separators=(',', ':'))

def generar_lista(vots, estado, ts, metricas):
    salida = {
        'actualizado': ts.isoformat(timespec='seconds'),
        'ultima_extraccion': estado.get('ultima_extraccion'),
        'fuente': API,
        'desde': INICIO_LEGISLATURA,
        'segmentos': SEGMENTOS,
        'resumen_segmentos': {seg: {'votaciones': sum(1 for v in vots if v['tipo'] == seg), **g}
                              for seg, g in metricas['generales'].items()},
        'partidos': _partidos(estado),
        'votaciones': [{**{k: v[k] for k in COLS_VOTACIONES if k not in ('reporte_id', 'sesion_id')},
                        'unanime': v['unanime'], 'division': v['division'], 'por_partido': v['por_partido'],
                        'etapa_actual': v['etapa_actual']} for v in vots],
    }
    for v in salida['votaciones']:
        for k in ('debate_inferido', 'objetado'): v[k] = bool(_int(v[k]))
        for k in ('proyecto', 'ficha', 'debate'): v[k] = v[k] or None
    with open(JSON_VOTACIONES, 'w', encoding='utf-8') as f:
        json.dump(salida, f, ensure_ascii=False, separators=(',', ':'))


def main():
    print("=" * 55)
    print(" VOTACIONES NOMINALES - prensa507 (legislatura 2024-2029)")
    print("=" * 55)
    carpeta = sys.argv[sys.argv.index('--desde-carpeta') + 1] if '--desde-carpeta' in sys.argv else None
    procesar(desde_carpeta=carpeta, sin_descarga='--sin-descarga' in sys.argv)

if __name__ == '__main__':
    main()
