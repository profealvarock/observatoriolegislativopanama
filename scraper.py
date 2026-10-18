"""
=============================================================
 SCRAPER COMPLETO - Observatorio Legislativo
 Asamblea Nacional de Panamá

 1. Extrae proyectos de sistemas.asamblea.gob.pa
 2. Extrae diputados de espaciocivico.org
 3. Cruza y genera resumen.json para el dashboard

INSTALACIÓN:
    pip install playwright
    playwright install chromium

EJECUCIÓN:
    python scraper.py                 # scraping completo
    python scraper.py --solo-resumen  # regenera resumen.json desde los JSON guardados
=============================================================
"""

import json, re, sys, time, unicodedata
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher

URL_LEG  = "https://sistemas.asamblea.gob.pa/segLegis/viewsPublico/SeguimientoLegislativo"
URL_DIPS = "https://espaciocivico.org/diputados"
URL_MONITOR = "https://espaciocivico.org/buscador/diputados-monitoreo?order=field_asistencia_comisiones_an&sort=asc"

# Fuentes que en esta ejecución usaron datos guardados en vez de datos frescos
RESPALDOS = []


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def normalizar(s):
    s = s.upper().strip()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    s = re.sub(r'^H\.D\.?S?\s+', '', s)
    return re.sub(r'\s+', ' ', s).strip()

_STOPWORDS = {'DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y', 'JR', 'SR'}

def tokens_nombre(s):
    s = normalizar(s)
    s = re.sub(r'["“”\'‘’][^"“”\'‘’]*["“”\'‘’]', ' ', s)   # apodos: Marcos "Lobo" Rangel, Bolivar 'Bolito' Escala
    s = re.sub(r'[^A-Z ]', ' ', s)
    return [w for w in s.split() if len(w) > 1 and w not in _STOPWORDS]

def _token_parecido(a, b):
    # Tolera variaciones de ortografía (JHONATAN/JHONATHAN, NIXON/NIXSON)
    if a == b: return True
    return (a[0] == b[0] and min(len(a), len(b)) >= 4
            and SequenceMatcher(None, a, b).ratio() >= 0.85)

def _cubre(cand, prop, exacto):
    """True si TODAS las palabras del nombre corto `cand` están en `prop` (palabras completas)."""
    libres = list(prop)
    for w in cand:
        hit = next((p for p in libres if (p == w if exacto else _token_parecido(w, p))), None)
        if hit is None: return False
        libres.remove(hit)
    return True

# Proponentes que ningún criterio automático resuelve: nombre normalizado → diputado principal.
ALIAS_PROPONENTES = {
    'CARLOS ISAEL HO SOLIS': 'Walkiria Chandler',   # suplente "Charlie Ho"
}

class EmparejadorDiputados:
    """
    Relaciona los nombres de proponentes de la Asamblea ("H.D JORGE ISAAC BLOISE IGLESIAS",
    "H.D.S ...") con los diputados de espaciocivico.org. Los suplentes se asignan a su principal.
    Compara palabras completas, no fragmentos de texto, y descarta coincidencias ambiguas.
    """
    def __init__(self, dips):
        self.por_nombre = {d['nombre']: d for d in dips}
        self.principales = [(normalizar(d['nombre']), tokens_nombre(d['nombre']), d) for d in dips]
        self.suplentes = [(normalizar(d['suplente']), tokens_nombre(d['suplente']), d)
                          for d in dips if (d.get('suplente') or '').strip()]
        self.cache, self.ambiguos = {}, {}

    def _etapa(self, pn, ptoks, lista, exacto):
        hits = {}
        for n, toks, d in lista:
            # Un nombre de una sola palabra (p. ej. suplente "Benchiman") solo vale si es exacto y largo
            valido = len(toks) >= 2 or (exacto and len(toks) == 1 and len(toks[0]) >= 6)
            if valido and _cubre(toks, ptoks, exacto):
                hits[d['nombre']] = max(hits.get(d['nombre'], 0), len(toks))
        if not hits: return None
        mejor = max(hits.values())
        top = [k for k, v in hits.items() if v == mejor]
        if len(top) > 1:
            self.ambiguos[pn] = top
            return None
        return self.por_nombre[top[0]]

    def buscar(self, raw):
        """Devuelve (diputado_principal, via_suplente) o None."""
        raw = raw.strip()
        if raw in self.cache: return self.cache[raw]
        pn, ptoks = normalizar(raw), tokens_nombre(raw)
        es_suplente = raw.upper().startswith('H.D.S')
        res = None
        if pn in ALIAS_PROPONENTES and ALIAS_PROPONENTES[pn] in self.por_nombre:
            res = (self.por_nombre[ALIAS_PROPONENTES[pn]], True)
        if not res:
            for n, _, d in self.principales:
                if n == pn: res = (d, False); break
        if not res:
            for n, _, d in self.suplentes:
                if n == pn: res = (d, True); break
        if not res:
            # A los firmantes "H.D.S" se les busca primero entre suplentes
            orden = [(self.principales, False), (self.suplentes, True)]
            if es_suplente: orden.reverse()
            for exacto in (True, False):
                for lista, via in orden:
                    d = self._etapa(pn, ptoks, lista, exacto)
                    if d: res = (d, via); break
                if res: break
        self.cache[raw] = res
        return res

_INSTITUCIONES = ('MINISTERIO', 'PROCURADURIA', 'ORGANO EJECUTIVO', 'ORGANO JUDICIAL',
                  'PODER EJECUTIVO', 'PRESIDENCIA DE LA REPUBLICA', 'VICEPRESIDENCIA',
                  'TRIBUNAL', 'CONTRALORIA', 'CORTE SUPREMA',
                  'DEFENSORIA', 'AUTORIDAD', 'INSTITUTO', 'JUNTA', 'SECRETARIA',
                  'CAJA DE SEGURO SOCIAL', 'UNIVERSIDAD', 'BANCO', 'ALCALDIA', 'MUNICIPIO')

# Comisiones permanentes de la Asamblea (aparecen como proponente sin la palabra "COMISION")
_COMISIONES = ('COMISION', 'ASAMBLEA NACIONAL', 'CREDENCIALES', 'GOBIERNO, JUSTICIA',
               'PRESUPUESTO', 'ECONOMIA Y FINANZAS', 'COMERCIO', 'RELACIONES EXTERIORES',
               'EDUCACION', 'TRABAJO', 'SALUD', 'INFRAESTRUCTURA', 'COMUNICACION Y TRANSPORTE',
               'ASUNTOS AGROPECUARIOS', 'ASUNTOS INDIGENAS', 'AMBIENTE', 'ETICA', 'MUJER',
               'ASUNTOS MUNICIPALES')

def clasificar_proponente(nombre):
    # Chequear el prefijo H.D antes de normalizar (normalizar lo elimina)
    if nombre.strip().upper().startswith('H.D'):
        return 'diputado'
    n = normalizar(nombre)
    if any(n.startswith(k) for k in _INSTITUCIONES):
        return 'ejecutivo'
    if any(n.startswith(k) for k in _COMISIONES):
        return 'comision'
    return 'ciudadano'


# ─────────────────────────────────────────────
# SCRAPER 1: PROYECTOS LEGISLATIVOS
# ─────────────────────────────────────────────
def extraer_filas_leg(page):
    return page.evaluate(r"""
        () => {
            const filas = [];
            const tabla = document.querySelector('table');
            if (!tabla) return filas;
            tabla.querySelectorAll('tbody tr').forEach(tr => {
                const tds = [...tr.querySelectorAll('td')];
                if (tds.length < 7) return;
                const fecha = tds[2]?.innerText.trim() || "";
                if (!/^\d{2}-\d{2}-\d{4}$/.test(fecha)) return;
                filas.push({
                    fecha_presentacion: fecha,
                    ficha:         tds[3]?.innerText.trim() || "",
                    proyecto:      tds[4]?.innerText.trim() || "",
                    anteproyecto:  tds[5]?.innerText.trim() || "",
                    titulo:        tds[6]?.innerText.trim() || "",
                    etapa:         tds[7]?.innerText.trim() || "",
                    proponente:    tds[8]?.innerText.trim() || "",
                });
            });
            return filas;
        }
    """)

def navegar_pagina_leg(page, numero, ficha_actual):
    page.evaluate(f"__doPostBack('dataTable','Page${numero}')")
    page.wait_for_load_state("networkidle")
    for _ in range(20):
        page.wait_for_timeout(400)
        filas = extraer_filas_leg(page)
        if filas and filas[0]["ficha"] != ficha_actual:
            return True
    return False

def scrape_proyectos(page):
    print(f"\n[1/2] Extrayendo proyectos de {URL_LEG}")
    page.goto(URL_LEG, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(2000)
    page.click("#btnMostrarTodo")
    page.wait_for_selector("table tbody tr td", timeout=20000)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1000)

    todos, fichas_vistas, pagina_num, sin_nuevos = [], set(), 1, 0

    while True:
        filas = extraer_filas_leg(page)
        if not filas: break

        primera = filas[0]["ficha"]
        if primera in fichas_vistas:
            print(f"  Pág {pagina_num}: repetido — fin.")
            break

        nuevas = [f for f in filas if f["ficha"] not in fichas_vistas]
        print(f"  Pág {pagina_num}: {len(filas)} registros ({len(nuevas)} nuevos)")

        for f in filas:
            if f["ficha"] not in fichas_vistas:
                f["pagina"] = pagina_num
                fichas_vistas.add(f["ficha"])
                todos.append(f)

        if not nuevas:
            sin_nuevos += 1
            if sin_nuevos >= 3: break
        else:
            sin_nuevos = 0

        if not navegar_pagina_leg(page, pagina_num+1, primera): break
        pagina_num += 1

    print(f"  Total: {len(todos)} proyectos")
    return todos


# ─────────────────────────────────────────────
# SCRAPER 2: DIPUTADOS
# ─────────────────────────────────────────────
def extraer_tarjetas_dips(page):
    return page.evaluate("""
        () => {
            const cards = [...document.querySelectorAll('a[href*="/diputados/"]')]
                .filter(a => a.querySelector('img') && a.querySelector('h3'));
            return cards.map(card => {
                const lines = card.innerText.trim().split('\\n').map(l=>l.trim()).filter(Boolean);
                const href  = card.getAttribute('href') || '';
                const cp    = (lines[2]||'').split(' - ');
                const sLine = lines.find(l=>l.toLowerCase().includes('suplente'))||'';
                return {
                    nombre:   card.querySelector('h3')?.innerText.trim()||lines[0]||'',
                    partido:  lines[1]||'',
                    circuito: cp[0]?.trim()||'',
                    provincia:cp.slice(1).join(' - ').trim()||'',
                    suplente: sLine.replace(/suplente:\\s*/i,'').trim(),
                    foto:     card.querySelector('img')?.src||'',
                    perfil:   href.startsWith('http')?href:'https://espaciocivico.org'+href,
                    slug:     href.replace('/diputados/','').replace(/\\/+$/,''),
                };
            });
        }
    """)

def scrape_diputados(page):
    print(f"\n[2/2] Extrayendo diputados de {URL_DIPS}")
    page.goto(URL_DIPS, wait_until="domcontentloaded", timeout=60000)
    try:
        page.wait_for_selector('a[href*="/diputados/"] h3', timeout=20000)
    except Exception: pass
    time.sleep(2)

    todos, slugs = [], set()

    # Intentar "Todos"
    try:
        page.select_option('select', label='Todos')
        time.sleep(3)
        dips = extraer_tarjetas_dips(page)
        if len(dips) >= 50:
            for d in dips:
                if d['slug'] not in slugs and d['nombre']:
                    slugs.add(d['slug']); todos.append(d)
            print(f"  Cargados con 'Todos': {len(todos)}")
            return todos
    except Exception: pass

    # Paginar
    page.goto(URL_DIPS, wait_until="domcontentloaded", timeout=60000)
    try: page.wait_for_selector('a[href*="/diputados/"] h3', timeout=20000)
    except Exception: pass
    time.sleep(2)

    for num in range(1, 10):
        dips = extraer_tarjetas_dips(page)
        if not dips: break
        nuevos = 0
        for d in dips:
            if d['slug'] not in slugs and d['nombre']:
                slugs.add(d['slug']); todos.append(d); nuevos += 1
        print(f"  Pág {num}: {len(dips)} tarjetas, {nuevos} nuevos")
        if not nuevos: break
        try:
            page.locator(f'a:text-is("{num+1}")').first.click(timeout=5000)
            page.wait_for_selector('a[href*="/diputados/"] h3', timeout=15000)
            time.sleep(1)
        except Exception:
            print(f"  No hay página {num+1} — fin.")
            break

    # Fallback: leer diputados.json guardado
    if len(todos) < 50:
        try:
            with open('diputados.json', encoding='utf-8') as f:
                raw = json.load(f)
            todos = raw if isinstance(raw, list) else raw.get('diputados', [])
            RESPALDOS.append('diputados')
            print(f"  Usando diputados.json guardado: {len(todos)}")
        except Exception as e:
            print(f"  No se pudo cargar diputados.json: {e}")

    print(f"  Total: {len(todos)} diputados")
    return todos

def parse_num(s):
    if not s or s.strip() == '-':
        return None
    m = re.search(r'-?\d+(?:\.\d+)?', s)
    return float(m.group(0)) if m else None

def parse_money(s):
    m = re.search(r'([\d,]+(?:\.\d+)?)', s or '')
    return float(m.group(1).replace(',', '')) if m else None

def slug_from_href(href):
    return (href or '').rstrip('/').split('/')[-1]

def parse_commissions(raw):
    raw = (raw or '').strip()
    quoted = re.findall(r'"([^"]+)"', raw)
    if quoted:
        return [q.strip() for q in quoted if q.strip()]
    if not raw or raw == '-':
        return []
    return [raw]

def scrape_metricas_diputados(page):
    print(f"\n[3/3] Extrayendo monitoreo de {URL_MONITOR}")
    try:
        page.goto(URL_MONITOR, wait_until="networkidle", timeout=60000)
        page.wait_for_selector("tbody tr", timeout=20000)
    except Exception as e:
        print(f"  ADVERTENCIA: no se pudo cargar la página de monitoreo ({e})")
        return _fallback_metricas()

    try:
        page.locator("select").nth(3).select_option("100")
        page.wait_for_timeout(1200)
    except Exception:
        pass

    rows = page.evaluate("""
        () => [...document.querySelectorAll('tbody tr')].map(tr => {
            const tds = [...tr.querySelectorAll('td')];
            const link = tds[0]?.querySelector('a');
            const txt = i => (tds[i]?.innerText || '').trim();
            return {
                nombre: link?.innerText?.trim() || '',
                href: link?.href || '',
                partido_monitoreo: tds[0]?.querySelector('.text-sm.text-gray-500')?.innerText?.trim() || '',
                provincia_monitoreo: tds[1]?.querySelector('.text-sm')?.innerText?.trim() || '',
                circuito_monitoreo: tds[1]?.querySelector('.text-xs')?.innerText?.trim() || '',
                planilla_texto: txt(2),
                asistencia_pleno_texto: txt(3),
                asistencia_comisiones_texto: txt(4),
                viajes_ponderacion_texto: txt(5),
                declaracion_intereses_texto: txt(6),
                declaracion_patrimonio_texto: txt(7),
                calificacion_texto: txt(8),
            };
        })
    """)

    metricas = {}
    for i, r in enumerate(rows, 1):
        slug = slug_from_href(r.get('href'))
        item = {
            'nombre': r.get('nombre', ''),
            'partido_monitoreo': r.get('partido_monitoreo', ''),
            'provincia_monitoreo': r.get('provincia_monitoreo', ''),
            'circuito_monitoreo': r.get('circuito_monitoreo', ''),
            'perfil_monitoreo': r.get('href', ''),
            'planilla_texto': r.get('planilla_texto', ''),
            'planilla_valor': parse_money(r.get('planilla_texto', '')),
            'asistencia_pleno': parse_num(r.get('asistencia_pleno_texto', '')),
            'asistencia_comisiones': parse_num(r.get('asistencia_comisiones_texto', '')),
            'viajes_ponderacion': parse_num(r.get('viajes_ponderacion_texto', '')),
            'declaracion_intereses': parse_num(r.get('declaracion_intereses_texto', '')),
            'declaracion_patrimonio': parse_num(r.get('declaracion_patrimonio_texto', '')),
            'calificacion': parse_num(r.get('calificacion_texto', '')),
            'comisiones': [],
            'comisiones_cantidad': 0,
        }
        try:
            page.goto(item['perfil_monitoreo'], wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(250)
            lines = [x.strip() for x in page.locator('body').inner_text(timeout=10000).splitlines() if x.strip()]
            raw_commissions = ''
            for label in ('Comisiones:', 'Comisión Principal:', 'Comision Principal:'):
                if label in lines:
                    idx = lines.index(label)
                    for value in lines[idx + 1:idx + 6]:
                        if value not in ('Documentos y Transparencia:', 'Calificación de Desempeño', 'Comisiones', 'Declaraciones Voluntarias'):
                            raw_commissions = value
                            break
                if raw_commissions:
                    break
            item['comisiones'] = parse_commissions(raw_commissions)
            item['comisiones_cantidad'] = len(item['comisiones'])
        except Exception as e:
            item['error_perfil'] = str(e)
        metricas[slug] = item
        if i % 10 == 0:
            print(f"  Perfiles: {i}/{len(rows)}")

    if len(metricas) < 50:
        print(f"  ADVERTENCIA: solo {len(metricas)} registros — usando datos guardados.")
        return _fallback_metricas()

    print(f"  Total monitoreo: {len(metricas)} diputados")
    return metricas


def _fallback_metricas():
    try:
        with open('metricas_diputados.json', encoding='utf-8') as f:
            raw = json.load(f)
        lista = raw.get('diputados', [])
        metricas = {slug_from_href(d.get('perfil_monitoreo', '')): d for d in lista if d.get('nombre')}
        RESPALDOS.append('metricas')
        print(f"  Usando metricas_diputados.json guardado: {len(metricas)} registros")
        return metricas
    except Exception as e:
        print(f"  No se pudo cargar metricas_diputados.json: {e}")
        return {}


# ─────────────────────────────────────────────
# GENERAR RESUMEN.JSON
# ─────────────────────────────────────────────
def _prod_vacio():
    return {'proyectos':0,'leyes':0,'co_patrocinios':0,'proyectos_suplente':0,'etapas':{},
            'leyes_detalle':[],'proyectos_detalle':[],'participaciones':[]}

def generar_resumen(datos, dips, ts, metricas=None, respaldos=None):
    emp = EmparejadorDiputados(dips)

    prod  = defaultdict(_prod_vacio)
    otros = defaultdict(lambda: {'tipo':'','proyectos':0,'leyes':0})
    firmantes = {}                      # ficha → diputados principales que participaron
    sin_match = defaultdict(int)        # firma "H.D" sin diputado → nº de firmas
    meses, etapas = {}, {}

    for r in datos:
        # Timeline
        parts = r['fecha_presentacion'].split('-')
        if len(parts) == 3:
            k = f"{parts[2]}-{parts[1]}"
            meses[k] = meses.get(k, 0) + 1
        # Etapas
        etapas[r['etapa']] = etapas.get(r['etapa'], 0) + 1

        es_ley = r['etapa'] == 'Ley'
        proponentes = [p.strip() for p in r['proponente'].split(',') if p.strip()]

        vistos = []  # un diputado cuenta una sola vez por proyecto (p. ej. si firman él y su suplente)
        for i, p in enumerate(proponentes):
            tipo = clasificar_proponente(p)
            if tipo == 'diputado':
                m = emp.buscar(p)
                if not m:
                    sin_match[p] += 1
                    continue
                dip, via_suplente = m
                key = dip['nombre']
                if key in vistos: continue
                vistos.append(key)
                prod[key]['participaciones'].append(r['ficha'])
                if i == 0:  # proponente principal
                    prod[key]['proyectos'] += 1
                    if via_suplente: prod[key]['proyectos_suplente'] += 1
                    titulo = r['titulo'] or r['anteproyecto'] or r['proyecto']
                    prod[key]['proyectos_detalle'].append({
                        'ficha': r['ficha'],
                        'titulo': titulo,
                        'fecha':  r['fecha_presentacion'],
                        'etapa':  r['etapa'],
                    })
                    if es_ley:
                        prod[key]['leyes'] += 1
                        prod[key]['leyes_detalle'].append({
                            'ficha': r['ficha'],
                            'titulo': titulo,
                            'fecha':  r['fecha_presentacion'],
                        })
                    et = prod[key]['etapas']
                    et[r['etapa']] = et.get(r['etapa'], 0) + 1
                else:  # co-patrocinador
                    prod[key]['co_patrocinios'] += 1
            elif i == 0:  # ministerio, comisión o ciudadano como proponente principal
                otros[p]['tipo']      = tipo
                otros[p]['proyectos'] += 1
                if es_ley: otros[p]['leyes'] += 1
        firmantes[r['ficha']] = [emp.por_nombre[k] for k in vistos]

    # Enriquecer diputados
    diputados_enriq = []
    for d in dips:
        p = prod.get(d['nombre']) or _prod_vacio()
        m = (metricas or {}).get(d.get('slug')) or (metricas or {}).get(slug_from_href(d.get('perfil', ''))) or {}
        diputados_enriq.append({**d, **p, **{k:v for k,v in m.items() if k not in ('nombre','partido_monitoreo')}})
    diputados_enriq.sort(key=lambda x: x['proyectos'], reverse=True)

    # Otros proponentes ordenados por proyectos desc
    otros_proponentes = [
        {'nombre': k, 'tipo': v['tipo'], 'proyectos': v['proyectos'], 'leyes': v['leyes']}
        for k, v in sorted(otros.items(), key=lambda x: -x[1]['proyectos'])
    ]

    # Etapa groups for map filter aggregations
    ETAPA_GROUPS = {
        'Ley':       {'Ley'},
        'debate':    {'Primer Debate','Segundo Debate','Tercer Debate','Enviado al Ejecutivo',
                      'Objetado por Ejecutivo','Segundo Debate(Objetado)','Tercer Debate(Objetado)'},
        'analisis':  {'Preliminar','Enviado a subcomisión para analisis'},
        'sinAvance': {'Archivado','Negado','Retirado por proponente','Suspendido'},
    }
    YEARS = sorted({r['fecha_presentacion'].split('-')[-1] for r in datos
                    if len(r['fecha_presentacion'].split('-')) == 3})

    def get_etapa_group(etapa):
        for g, vals in ETAPA_GROUPS.items():
            if etapa in vals: return g
        return 'sinAvance'

    # Por partido y provincia: cada proyecto cuenta UNA vez por partido
    # aunque lo firmen 19 diputados del mismo partido
    por_partido  = defaultdict(lambda: {'diputados':0,'proyectos':set(),'leyes':set()})
    por_provincia = defaultdict(lambda: {'diputados':0,'proyectos':set(),'leyes':set()})
    # por_provincia_filtros[prov][year_key][etapa_group] = {fichas}
    pv_filtros = defaultdict(lambda: {
        y: {eg: set() for eg in list(ETAPA_GROUPS.keys())+['all']} for y in YEARS+['all']
    })

    for r in datos:
        partidos_proy  = {d['partido'] for d in firmantes.get(r['ficha'], [])}
        provincias_proy = {d['provincia'] for d in firmantes.get(r['ficha'], [])}
        for partido in partidos_proy:
            por_partido[partido]['proyectos'].add(r['ficha'])
            if r['etapa'] == 'Ley': por_partido[partido]['leyes'].add(r['ficha'])
        yr = (r['fecha_presentacion'].split('-') or ['','',''])
        yr = yr[2] if len(yr) == 3 else ''
        eg = get_etapa_group(r['etapa'])
        for prov in provincias_proy:
            por_provincia[prov]['proyectos'].add(r['ficha'])
            if r['etapa'] == 'Ley': por_provincia[prov]['leyes'].add(r['ficha'])
            pv_filtros[prov]['all']['all'].add(r['ficha'])
            pv_filtros[prov]['all'][eg].add(r['ficha'])
            if yr in YEARS:
                pv_filtros[prov][yr]['all'].add(r['ficha'])
                pv_filtros[prov][yr][eg].add(r['ficha'])

    for d in dips:
        por_partido[d['partido']]['diputados'] += 1
        por_provincia[d['provincia']]['diputados'] += 1

    pp_final = {k: {'diputados':v['diputados'],'proyectos':len(v['proyectos']),'leyes':len(v['leyes'])}
                for k,v in sorted(por_partido.items(), key=lambda x:-len(x[1]['proyectos']))}
    pv_final = {k: {'diputados':v['diputados'],'proyectos':len(v['proyectos']),'leyes':len(v['leyes'])}
                for k,v in sorted(por_provincia.items(), key=lambda x:-len(x[1]['proyectos']))}
    pv_filtros_final = {
        prov: {yr: {eg: len(s) for eg, s in egs.items()} for yr, egs in yrs.items()}
        for prov, yrs in pv_filtros.items()
    }

    if sin_match:
        print(f"  Firmas 'H.D' sin diputado asociado: {sum(sin_match.values())} "
              f"({len(sin_match)} nombres) — ver 'proponentes_sin_match' en resumen.json")
    if emp.ambiguos:
        print(f"  Nombres ambiguos (no asignados): {emp.ambiguos}")

    return {
        'fecha_extraccion': ts,
        'respaldos': sorted(set(respaldos or [])),
        'fuente': URL_LEG,
        'fuente_metricas': URL_MONITOR,
        'total_proyectos': len(datos),
        'total_leyes': sum(1 for r in datos if r['etapa']=='Ley'),
        'total_diputados': len(dips),
        'etapas': etapas,
        'timeline': dict(sorted(meses.items())),
        'diputados': diputados_enriq,
        'otros_proponentes': otros_proponentes,
        'por_partido': pp_final,
        'por_provincia': pv_final,
        'por_provincia_filtros': pv_filtros_final,
        'proponentes_sin_match': [{'nombre': k, 'firmas': v}
                                  for k, v in sorted(sin_match.items(), key=lambda x: -x[1])],
    }


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def _leer_json(ruta):
    try:
        with open(ruta, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None

# Campos por diputado que se guardan cada día en historico.json (en este orden), para que el
# sitio pueda graficar tendencias. Formato compacto: {slug: [planilla, pleno, ...]}.
CAMPOS_HISTORICO = [
    ('planilla', 'planilla_valor'), ('pleno', 'asistencia_pleno'),
    ('comisiones', 'asistencia_comisiones'), ('calificacion', 'calificacion'),
    ('proyectos', 'proyectos'), ('leyes', 'leyes'),
]
CAMPOS_METRICAS = {'planilla', 'pleno', 'comisiones', 'calificacion'}

def actualizar_historico(resumen, respaldos, ruta='historico.json'):
    """Agrega (o reemplaza) la foto del día de extracción en historico.json."""
    hist = _leer_json(ruta) or {}
    ts = resumen.get('fecha_extraccion', '')
    fecha = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"
    # Si Espacio Cívico no respondió, las métricas son las de un día anterior: no se registran.
    metricas_frescas = 'metricas' not in (respaldos or [])
    dips = {}
    for d in resumen.get('diputados', []):
        if not d.get('slug'):
            continue
        dips[d['slug']] = [d.get(k) if (metricas_frescas or c not in CAMPOS_METRICAS) else None
                           for c, k in CAMPOS_HISTORICO]
    foto = {'fecha': fecha, 'total_proyectos': resumen.get('total_proyectos'),
            'total_leyes': resumen.get('total_leyes'), 'diputados': dips}
    snaps = [s for s in hist.get('snapshots', []) if s.get('fecha') != fecha] + [foto]
    snaps.sort(key=lambda s: s['fecha'])
    with open(ruta, 'w', encoding='utf-8') as f:
        json.dump({'campos': [c for c, _ in CAMPOS_HISTORICO], 'snapshots': snaps},
                  f, ensure_ascii=False, separators=(',', ':'))
    print(f"  historico.json: {len(snaps)} fotos (última {fecha})")

def solo_resumen():
    """Regenera resumen.json a partir de los JSON ya guardados (sin navegador)."""
    raw = _leer_json('datos.json') or {}
    datos = raw.get('datos', [])
    dips = (_leer_json('diputados.json') or {}).get('diputados', [])
    metricas = _fallback_metricas()
    RESPALDOS.clear()
    ts = raw.get('fecha_extraccion') or datetime.now().strftime("%Y%m%d_%H%M%S")
    resumen = generar_resumen(datos, dips, ts, metricas, (_leer_json('resumen.json') or {}).get('respaldos'))
    with open("resumen.json", "w", encoding="utf-8") as f:
        json.dump(resumen, f, ensure_ascii=False, indent=2)
    print(f"resumen.json regenerado: {len(datos)} proyectos, {len(dips)} diputados (extracción {ts})")

def main():
    from playwright.sync_api import sync_playwright

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    print("=" * 55)
    print(" SCRAPER - Observatorio Legislativo Panamá")
    print("=" * 55)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        )
        datos = scrape_proyectos(page)
        dips  = scrape_diputados(page)
        metricas = scrape_metricas_diputados(page)
        browser.close()

    # Si la extracción de proyectos falló (o trajo muchos menos que la vez anterior),
    # conservar datos.json en vez de sobrescribirlo con datos incompletos.
    previo = _leer_json('datos.json') or {}
    n_previo = len(previo.get('datos', []))
    if n_previo and len(datos) < n_previo * 0.9:
        print(f"  ADVERTENCIA: solo {len(datos)} proyectos (antes {n_previo}) — usando datos.json guardado.")
        datos = previo['datos']
        ts = previo.get('fecha_extraccion', ts)
        RESPALDOS.append('proyectos')
    else:
        with open("datos.json", "w", encoding="utf-8") as f:
            json.dump({"fecha_extraccion":ts,"fuente":URL_LEG,"total_registros":len(datos),"datos":datos},
                      f, ensure_ascii=False, indent=2)

    with open("diputados.json", "w", encoding="utf-8") as f:
        dips_metricas = []
        for d in dips:
            m = metricas.get(d.get('slug')) or metricas.get(slug_from_href(d.get('perfil', ''))) or {}
            dips_metricas.append({**d, **{k:v for k,v in m.items() if k not in ('nombre','partido_monitoreo')}})
        json.dump({"fuente":URL_DIPS,"fuente_metricas":URL_MONITOR,"total":len(dips_metricas),"diputados":dips_metricas},
                  f, ensure_ascii=False, indent=2)

    # Solo sobreescribir métricas si se obtuvieron datos frescos (>= 50 registros)
    if len(metricas) >= 50:
        with open("metricas_diputados.json", "w", encoding="utf-8") as f:
            json.dump({"fuente":URL_MONITOR,"total":len(metricas),"diputados":list(metricas.values())},
                      f, ensure_ascii=False, indent=2)
    else:
        print("  metricas_diputados.json conservado (datos insuficientes del sitio).")

    # Generar resumen
    resumen = generar_resumen(datos, dips, ts, metricas, RESPALDOS)
    with open("resumen.json", "w", encoding="utf-8") as f:
        json.dump(resumen, f, ensure_ascii=False, indent=2)
    try:
        actualizar_historico(resumen, RESPALDOS)
    except Exception as e:
        print(f"  ADVERTENCIA: no se pudo actualizar historico.json: {e}")

    print(f"\n{'='*55}")
    print(f" COMPLETADO")
    print(f"  Proyectos : {len(datos)}")
    print(f"  Leyes     : {resumen['total_leyes']}")
    print(f"  Diputados : {len(dips)}")
    print(f"{'='*55}")
    if RESPALDOS:
        print(f"  Fuentes con datos de respaldo: {', '.join(RESPALDOS)}")
    print("Archivos generados: datos.json · diputados.json · resumen.json")

if __name__ == "__main__":
    if '--solo-resumen' in sys.argv:
        solo_resumen()
    else:
        main()
