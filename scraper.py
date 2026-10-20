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
    # Abelardo "Lalo" Antonío: Espacio Cívico lo registra como suplente "Lalo' Antonio" de
    # Rogelio Revello (Colón 3-1). Fue suplente en el mismo circuito en 2019-2024.
    'ABELARDO ENRIQUE ANTONIO QUIJANO': 'Rogelio Revello',
    # Sin asignar a propósito: "H.D.S EDUARD ABDEL RANGEL GONZALEZ" (se le atribuye ser suplente de
    # Patsy Lee Rentería, pero Espacio Cívico registra como su suplente a Ezequiel Cedeño).
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

# Comisiones permanentes con su nombre oficial (como las publica Espacio Cívico). Varias llevan
# comas en el nombre, y la Asamblea separa a los proponentes también con comas: sin esta lista,
# "CREDENCIALES, REGLAMENTO, ETICA..." se partía en tres proponentes distintos.
COMISIONES_PERMANENTES = [
    'Credenciales, Reglamento, Ética Parlamentaria y Asuntos Judiciales',
    'Gobierno, Justicia y Asuntos Constitucionales',
    'Presupuesto',
    'Economía y Finanzas',
    'Comercio y Asuntos Económicos',
    'Comercio, Industrias y Asuntos Económicos',
    'Relaciones Exteriores',
    'Educación, Cultura y Deporte',
    'Educación, Cultura y Deportes',
    'Trabajo, Salud y Desarrollo Social',
    'Infraestructura Pública y Asuntos del Canal',
    'Comunicación y Transporte',
    'Asuntos Agropecuarios',
    'Asuntos Indígenas',
    'Población, Ambiente y Desarrollo',
    'Mujer, la Niñez, la Juventud y la Familia',
    'Asuntos Municipales',
]

def _clave_comision(s):
    """'COMISION DE LA EDUCACION, CULTURA Y DEPORTES' → 'EDUCACION CULTURA Y DEPORTES'."""
    n = normalizar(s)
    n = re.sub(r'^COMISION\s+(PERMANENTE\s+)?(DE\s+)?(LA\s+|LAS\s+|LOS\s+|EL\s+)?', '', n)
    n = re.sub(r'^DE LA\s+', '', n)
    return re.sub(r'[^A-Z ]', ' ', n).split()

_COMISIONES_CLAVE = [(_clave_comision(c), c) for c in COMISIONES_PERMANENTES]

def nombre_comision(s):
    """Nombre oficial de la comisión, si `s` corresponde a una; si no, None."""
    k = _clave_comision(s)
    for clave, oficial in _COMISIONES_CLAVE:
        if k == clave:
            return 'Comisión de ' + oficial
    return None

def _prefijo_de_comision(s):
    k = _clave_comision(s)
    return bool(k) and any(clave[:len(k)] == k for clave, _ in _COMISIONES_CLAVE)

def separar_proponentes(texto):
    """
    Divide el campo 'proponente' por comas, pero vuelve a unir los trozos que forman el
    nombre de una comisión (que también contiene comas).
    """
    partes = [p.strip() for p in (texto or '').split(',') if p.strip()]
    res = []
    for p in partes:
        if (res and not p.upper().startswith('H.D') and not res[-1].upper().startswith('H.D')
                and _prefijo_de_comision(res[-1]) and _prefijo_de_comision(res[-1] + ', ' + p)):
            res[-1] = res[-1] + ', ' + p
        else:
            res.append(p)
    return res

_PARTICULAS = {'de', 'del', 'la', 'las', 'los', 'y'}

def limpiar_nombre_otro(nombre, tipo):
    """Nombre uniforme para proponentes que no son diputados."""
    if tipo == 'comision':
        return nombre_comision(nombre) or nombre.strip().upper()
    n = re.sub(r'\s+', ' ', nombre).strip()
    if tipo == 'ciudadano':
        # "LORENA RÍOS CASTRO" y "Lorena Ríos Castro" → "Lorena Ríos Castro"
        palabras = n.lower().split()
        return ' '.join(w if (i and w in _PARTICULAS) else w.capitalize() for i, w in enumerate(palabras))
    return n.upper()


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
    """
    Espacio Cívico publica las comisiones en una sola línea separadas por " | " y con un emoji
    delante ("🌎 Relaciones Exteriores | 💰 Presupuesto"). Devuelve la lista de nombres limpios.
    """
    if isinstance(raw, list):
        partes = [x for item in raw for x in str(item).split('|')]
    else:
        raw = (raw or '').strip()
        quoted = re.findall(r'"([^"]+)"', raw)
        partes = quoted if quoted else ([] if raw in ('', '-') else raw.split('|'))
    res = []
    for p in partes:
        # Quitar emojis y símbolos al inicio (cualquier cosa antes de la primera letra)
        p = re.sub(r'^[^A-Za-zÁÉÍÓÚÑáéíóúñ]+', '', p).strip()
        if p and p not in res:
            res.append(p)
    return res

def limpiar_partido(p):
    return re.sub(r'\s*\|\s*', ' | ', (p or '').strip())

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

# ─────────────────────────────────────────────
# TEMAS DE LOS PROYECTOS
# ─────────────────────────────────────────────
# Clasificación por palabras clave en el título (sin tildes, en mayúsculas). Un proyecto puede
# tener varios temas; si no coincide con ninguno queda en "Otros". Las expresiones buscan el
# inicio de palabra (\b), así "EDUCA" cubre EDUCACION, EDUCATIVO, EDUCADORES…
TEMAS = [
    ('Conmemoraciones y festivales', [r'\bDECLARA (EL |LA |LOS |LAS )?(DIA|SEMANA|MES|ANO)\b', r'\bDIA NACIONAL\b',
        r'\bFESTIVAL', r'\bPATRONATO', r'\bFERIA\b', r'\bCONMEMORA', r'\bHIJ[OA]S? MERITORI', r'\bDENOMINA\b']),
    ('Tratados y relaciones exteriores', [r'\b(CONVENIO|TRATADO|CONVENCION|PROTOCOLO)\b', r'\bAPRUEBA\b.*\bACUERDO\b',
        r'\bRELACIONES EXTERIORES\b', r'\bDIPLOMATIC']),
    ('Salud', [r'\bSALUD', r'\bMEDIC', r'\bHOSPITAL', r'\bENFERMEDAD', r'\bCANCER', r'\bSANITARI', r'\bPACIENTE',
        r'\bVACUN', r'\bNUTRIC', r'\bDIABET', r'\bMENTAL\b', r'\bFARMAC', r'\bODONTOLOG', r'\bSANGRE', r'\bTRANSFUSION']),
    ('Seguridad social y pensiones', [r'\bJUBILA', r'\bPENSION', r'\bCAJA DE SEGURO SOCIAL', r'\bSEGURIDAD SOCIAL',
        r'\bINVALIDEZ', r'\b120 A LOS 65']),
    ('Educación', [r'\bEDUCA', r'\bESCOLAR', r'\bESCUELA', r'\bUNIVERSI', r'\bESTUDIANT', r'\bDOCENTE', r'\bBECA',
        r'\bENSENANZA', r'\bALFABETIZ', r'\bFORMACION\b', r'\bIFARHU', r'\bCAPACITACION']),
    ('Justicia y seguridad', [r'\bPENAL\b', r'\bDELITO', r'\bPOLICI', r'\bCARCEL', r'\bPENITENCIARI', r'\bVIOLENCIA',
        r'\bCRIMEN', r'\bCRIMINAL', r'\bPROCESAL', r'\bJUDICIAL', r'\bSEGURIDAD (CIUDADANA|PUBLICA)', r'\bARMAS\b',
        r'\bDROGA', r'\bJUSTICIA', r'\bFEMICIDIO', r'\bVICTIMA']),
    ('Economía, finanzas e impuestos', [r'\bIMPUEST', r'\bTRIBUT', r'\bFISCAL', r'\bPRESUPUEST', r'\bBANC', r'\bFINANCI',
        r'\bCREDITO', r'\bINVERSION', r'\bECONOMI', r'\bADUAN', r'\bCOMERCI', r'\bCONSUMIDOR', r'\bEMPRESA',
        r'\bMIPYME', r'\bPRESTAMO', r'\bDEUDA', r'\bFACTURACION', r'\bLOTERIA', r'\bALQUILER', r'\bGASTOS?\b']),
    ('Trabajo y empleo', [r'\bTRABAJ', r'\bLABORAL', r'\bEMPLEO', r'\bSALARI', r'\bSERVIDORES PUBLICOS',
        r'\bCARRERA ADMINISTRATIVA']),
    ('Ambiente y energía', [r'\bAMBIENT', r'\bAGUA\b', r'\bHIDRIC', r'\bBOSQUE', r'\bAREAS? PROTEGIDA', r'\bCLIMA',
        r'\bRESIDUO', r'\bRECICL', r'\bMINER', r'\bENERGI', r'\bELECTRIC', r'\bBIODIVERSIDAD', r'\bFAUNA',
        r'\bMANGLAR', r'\bCONTAMINA', r'\bSOSTENIBL', r'\bPLASTIC', r'\bAGUAS\b', r'\bPOLIESTIRENO', r'\bENVASES']),
    ('Agro y pesca', [r'\bAGROPECUARI', r'\bAGRICOL', r'\bAGRO', r'\bPRODUCTOR', r'\bGANAD', r'\bPESCA', r'\bACUICOL',
        r'\bALIMENTARI', r'\bCAFE\b', r'\bARROZ', r'\bTIERRAS\b', r'\bBANANER']),
    ('Infraestructura, transporte y vivienda', [r'\bTRANSPORT', r'\bVIAL', r'\bCARRETER', r'\bINFRAESTRUCTURA',
        r'\bTRANSITO', r'\bPUERTO', r'\bAEROPUERT', r'\bVIVIENDA', r'\bHABITACIONAL', r'\bURBAN',
        r'\bORDENAMIENTO TERRITORIAL', r'\bOBRAS? PUBLICAS', r'\bVEHICUL', r'\bSERVICIOS PUBLICOS']),
    ('Cultura, deporte y turismo', [r'\bCULTUR', r'\bDEPORT', r'\bPATRIMONIO', r'\bARTE\b', r'\bARTIST', r'\bARTESAN',
        r'\bFOLCLOR', r'\bMUSEO', r'\bTURIS', r'\bMUSICA']),
    ('Niñez, familia e inclusión', [r'\bNINE?Z', r'\bNIN[OA]S?\b', r'\bADOLESCEN', r'\bJUVENTUD', r'\bJOVEN',
        r'\bFAMILIA', r'\bMUJER', r'\bGENERO\b', r'\bDISCAPACI', r'\bADULTOS? MAYOR', r'\bPOBREZA', r'\bINDIGENA',
        r'\bAFRODESCEN', r'\bIGUALDAD', r'\bINCLUSION', r'\bETNIA']),
    ('Estado, gobierno y transparencia', [r'\bASAMBLEA', r'\bREGLAMENTO ORGANICO', r'\bELECTORAL', r'\bCONSTITUC',
        r'\bMUNICIP', r'\bDESCENTRALIZ', r'\bADMINISTRACION PUBLICA', r'\bTRANSPARENCIA', r'\bCORREGIMIENTO',
        r'\bDISTRITO\b', r'\bCONTRATACION', r'\bCONTRALORIA', r'\bCORRUPCION', r'\bCOMARCA', r'\bRENDICION DE CUENTAS',
        r'\bPARTIDOS? POLITICO', r'\bGABINETE', r'\bSECTOR PUBLICO', r'\bAUTORIDADES DEL ESTADO', r'\bREGLAMENTACION', r'\bPASAPORTE', r'\bPOLITICO ADMINISTRATIVA', r'\bMIGRA']),
    ('Tecnología y datos', [r'\bDIGITAL', r'\bTECNOLOG', r'\bINNOVAC', r'\bCIBER', r'\bINTERNET', r'\bDATOS PERSONALES',
        r'\bINTELIGENCIA ARTIFICIAL', r'\bTELECOMUNICA', r'\bELECTRONIC']),
]
TEMA_OTROS = 'Otros'
_TEMAS_RE = [(nombre, [re.compile(p) for p in pats]) for nombre, pats in TEMAS]

def _sin_tildes(s):
    s = unicodedata.normalize('NFD', (s or '').upper())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn')

def clasificar_temas(titulo):
    t = _sin_tildes(titulo)
    temas = [nombre for nombre, pats in _TEMAS_RE if any(p.search(t) for p in pats)]
    return temas or [TEMA_OTROS]


# ─────────────────────────────────────────────
# ÍNDICE DE EFECTIVIDAD LEGISLATIVA
# ─────────────────────────────────────────────
# El % crudo de proyectos que llegan a ley engaña por dos razones:
#  1) Antigüedad: un proyecto presentado hace dos meses casi nunca es ley todavía, así que
#     quien propuso mucho recientemente parece "inefectivo". Se corrige comparando cada
#     diputado con las leyes que ESPERARÍAMOS según el semestre en que presentó cada proyecto
#     (tasa de la Cámara en ese semestre).
#  2) Muestras pequeñas: 1 ley de 3 proyectos (33 %) no prueba nada. Se suaviza hacia el
#     promedio sumando SUAVIZADO_LEYES leyes "virtuales" a observadas y esperadas.
# Índice = (leyes + k) / (esperadas + k) × 100 → 100 = promedio de la Cámara.
# Se calcula por separado como autor y como co-patrocinador, cada uno con su propia tasa base
# (co-patrocinar proyectos con muchas firmas tiene una tasa de éxito distinta).
SUAVIZADO_LEYES = 1.5
EVIDENCIA_MINIMA = 1.0   # leyes esperadas por debajo de esto → evidencia baja

def _semestre(fecha):
    p = (fecha or '').split('-')
    return f"{p[2]}-S{1 if int(p[1]) <= 6 else 2}" if len(p) == 3 else ''

def calcular_efectividad(prod, datos):
    por_ficha = {r['ficha']: r for r in datos}
    es_ley = lambda f: por_ficha.get(f, {}).get('etapa') == 'Ley'
    sem = lambda f: _semestre(por_ficha.get(f, {}).get('fecha_presentacion'))

    roles = {}
    for nombre, p in prod.items():
        autor = [x['ficha'] for x in p['proyectos_detalle']]
        set_autor = set(autor)
        roles[nombre] = {'autor': autor, 'copat': [f for f in p['participaciones'] if f not in set_autor]}

    def tasas(rol):
        t = defaultdict(lambda: [0, 0])
        for r in roles.values():
            for f in r[rol]:
                t[sem(f)][1] += 1
                t[sem(f)][0] += es_ley(f)
        return {s: (l / n if n else 0) for s, (l, n) in t.items()}

    base = {'autor': tasas('autor'), 'copat': tasas('copat')}
    k = SUAVIZADO_LEYES
    res = {}
    for nombre, r in roles.items():
        item = {}
        for rol in ('autor', 'copat'):
            fichas = r[rol]
            leyes = sum(es_ley(f) for f in fichas)
            esperadas = sum(base[rol].get(sem(f), 0) for f in fichas)
            item[rol] = {
                'proyectos': len(fichas), 'leyes': leyes,
                'tasa': round(100 * leyes / len(fichas), 1) if fichas else None,
                'esperadas': round(esperadas, 2),
                'indice': round(100 * (leyes + k) / (esperadas + k)) if fichas else None,
                'evidencia': 'alta' if esperadas >= 2 * EVIDENCIA_MINIMA else ('media' if esperadas >= EVIDENCIA_MINIMA else 'baja'),
            }
        res[nombre] = item
    meta = {
        'suavizado_leyes': k, 'evidencia_minima': EVIDENCIA_MINIMA,
        'tasa_base': {rol: {s: round(100 * v, 1) for s, v in sorted(t.items())} for rol, t in base.items()},
    }
    return res, meta

def generar_resumen(datos, dips, ts, metricas=None, respaldos=None):
    dips = [{**d, 'partido': limpiar_partido(d.get('partido'))} for d in dips]
    emp = EmparejadorDiputados(dips)

    prod  = defaultdict(_prod_vacio)
    otros = {}                          # clave normalizada → {'nombre','tipo','proyectos','leyes'}
    firmantes = {}                      # ficha → diputados principales que participaron
    autor = {}                          # ficha → diputado autor principal (primer firmante), si lo hay
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
        proponentes = separar_proponentes(r['proponente'])

        vistos = []  # un diputado cuenta una sola vez por proyecto (p. ej. si firman él y su suplente)
        for i, p in enumerate(proponentes):
            tipo = clasificar_proponente(p)
            if tipo != 'diputado' and nombre_comision(p):
                tipo = 'comision'
            if tipo == 'diputado':
                m = emp.buscar(p)
                if not m:
                    sin_match[p] += 1
                    continue
                dip, via_suplente = m
                # Quien firma "H.D.S" es suplente aunque su nombre se parezca al del principal
                # (p. ej. BENISIO ENISIO ROBINSON, suplente de Benicio Robinson)
                via_suplente = via_suplente or p.strip().upper().startswith('H.D.S')
                key = dip['nombre']
                if key in vistos: continue
                vistos.append(key)
                prod[key]['participaciones'].append(r['ficha'])
                if i == 0:  # proponente principal
                    autor[r['ficha']] = dip
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
                nombre = limpiar_nombre_otro(p, tipo)
                o = otros.setdefault(normalizar(nombre), {'nombre': nombre, 'tipo': tipo, 'proyectos': 0, 'leyes': 0})
                o['proyectos'] += 1
                if es_ley: o['leyes'] += 1
        firmantes[r['ficha']] = [emp.por_nombre[k] for k in vistos]

    efectividad, efectividad_meta = calcular_efectividad(prod, datos)

    # Temas: por proyecto (índices de la lista `temas` para que el JSON sea compacto),
    # totales por tema y los temas que más trabaja cada diputado como autor.
    nombres_temas = [n for n, _ in TEMAS] + [TEMA_OTROS]
    temas_ficha = {r['ficha']: clasificar_temas(r['titulo'] or r['anteproyecto'] or r['proyecto']) for r in datos}
    por_tema = {n: {'proyectos': 0, 'leyes': 0} for n in nombres_temas}
    for r in datos:
        for t in temas_ficha[r['ficha']]:
            por_tema[t]['proyectos'] += 1
            por_tema[t]['leyes'] += r['etapa'] == 'Ley'

    # Redes de co-patrocinio. Para cada proyecto: quiénes firmaron juntos (pares de diputados) y,
    # desde el partido del autor, de qué partidos vienen los co-firmantes.
    pares = defaultdict(lambda: defaultdict(int))     # nombre → {otro nombre: proyectos juntos}
    matriz = defaultdict(lambda: defaultdict(int))    # partido del autor → {partido co-firmante: firmas}
    for r in datos:
        grupo = firmantes.get(r['ficha'], [])
        for a in grupo:
            for b in grupo:
                if a['nombre'] != b['nombre']:
                    pares[a['nombre']][b['nombre']] += 1
        a = autor.get(r['ficha'])
        if a:
            for b in grupo:
                if b['nombre'] != a['nombre']:
                    matriz[a['partido']][b['partido']] += 1
    partido_de = {d['nombre']: d['partido'] for d in dips}
    tam_partido = defaultdict(int)
    for d in dips: tam_partido[d['partido']] += 1

    def red_de(nombre):
        otros = pares.get(nombre, {})
        total = sum(otros.values())
        cruzan = sum(n for o, n in otros.items() if partido_de.get(o) != partido_de.get(nombre))
        top = sorted(otros.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
        # Lo esperado si firmara al azar con cualquier diputado: depende del tamaño de su partido
        # (quien es el único de su partido tendrá 100 % de co-firmas con otros partidos sí o sí).
        esperada = 100 * (len(dips) - tam_partido[partido_de.get(nombre)]) / max(len(dips) - 1, 1)
        return {'aliados': [{'nombre': o, 'partido': partido_de.get(o, ''), 'proyectos': n} for o, n in top],
                'transversalidad': round(100 * cruzan / total, 1) if total else None,
                'transversalidad_esperada': round(esperada, 1)}

    # Temas que propone cada partido y cada provincia (como autor principal)
    temas_partido = defaultdict(lambda: defaultdict(int))
    temas_provincia = defaultdict(lambda: defaultdict(int))
    for f, a in autor.items():
        for t in temas_ficha.get(f, []):
            temas_partido[a['partido']][t] += 1
            temas_provincia[a['provincia']][t] += 1

    # Enriquecer diputados
    diputados_enriq = []
    for d in dips:
        p = prod.get(d['nombre']) or _prod_vacio()
        ef = efectividad.get(d['nombre'])
        temas_dip = defaultdict(int)
        for x in p['proyectos_detalle']:
            for t in temas_ficha.get(x['ficha'], []):
                if t != TEMA_OTROS: temas_dip[t] += 1
        p = {**p, 'leyes_copatrocinio': ef['copat']['leyes'] if ef else 0, 'efectividad_ley': ef,
             'temas_autor': dict(sorted(temas_dip.items(), key=lambda kv: (-kv[1], kv[0]))[:5]),
             **red_de(d['nombre'])}
        m = (metricas or {}).get(d.get('slug')) or (metricas or {}).get(slug_from_href(d.get('perfil', ''))) or {}
        m = {k:v for k,v in m.items() if k not in ('nombre','partido_monitoreo')}
        if 'comisiones' in m:   # también corrige datos guardados con el formato anterior
            m['comisiones'] = parse_commissions(m['comisiones'])
            m['comisiones_cantidad'] = len(m['comisiones'])
        diputados_enriq.append({**d, **p, **m})
    diputados_enriq.sort(key=lambda x: x['proyectos'], reverse=True)

    # Otros proponentes ordenados por proyectos desc
    otros_proponentes = sorted(otros.values(), key=lambda v: (-v['proyectos'], v['nombre']))

    # Etapa groups for map filter aggregations
    ETAPA_GROUPS = {
        'Ley':       {'Ley'},
        'debate':    {'Primer Debate','Segundo Debate','Tercer Debate','Enviado al Ejecutivo',
                      'Objetado por Ejecutivo','Segundo Debate(Objetado)','Tercer Debate(Objetado)'},
        'analisis':  {'Preliminar','Prohijado','Enviado a subcomisión para analisis'},
        'sinAvance': {'Archivado','Negado','Retirado por proponente','Suspendido'},
    }
    YEARS = sorted({r['fecha_presentacion'].split('-')[-1] for r in datos
                    if len(r['fecha_presentacion'].split('-')) == 3})

    def get_etapa_group(etapa):
        for g, vals in ETAPA_GROUPS.items():
            if etapa in vals: return g
        return 'sinAvance'

    # Por partido y provincia, cada proyecto se atribuye UNA vez: al partido (y provincia) de su
    # autor principal, igual que en la tabla de diputados, de modo que los totales cuadran con
    # el número de proyectos. Aparte se cuenta 'participaciones': proyectos en los que firmó al
    # menos un diputado del partido/provincia (como autor o co-patrocinador).
    vacio = lambda: {'diputados':0,'proyectos':set(),'leyes':set(),'participaciones':set(),'leyes_participacion':set()}
    por_partido, por_provincia = defaultdict(vacio), defaultdict(vacio)
    # por_provincia_filtros[prov][year_key][etapa_group] = {fichas} (por autor principal)
    pv_filtros = defaultdict(lambda: {
        y: {eg: set() for eg in list(ETAPA_GROUPS.keys())+['all']} for y in YEARS+['all']
    })

    for r in datos:
        ficha, es_ley = r['ficha'], r['etapa'] == 'Ley'
        for d in firmantes.get(ficha, []):
            for agg, k in ((por_partido, d['partido']), (por_provincia, d['provincia'])):
                agg[k]['participaciones'].add(ficha)
                if es_ley: agg[k]['leyes_participacion'].add(ficha)
        a = autor.get(ficha)
        if not a:
            continue
        for agg, k in ((por_partido, a['partido']), (por_provincia, a['provincia'])):
            agg[k]['proyectos'].add(ficha)
            if es_ley: agg[k]['leyes'].add(ficha)
        yr = r['fecha_presentacion'].split('-')
        yr = yr[2] if len(yr) == 3 else ''
        eg = get_etapa_group(r['etapa'])
        prov = a['provincia']
        pv_filtros[prov]['all']['all'].add(ficha)
        pv_filtros[prov]['all'][eg].add(ficha)
        if yr in YEARS:
            pv_filtros[prov][yr]['all'].add(ficha)
            pv_filtros[prov][yr][eg].add(ficha)

    for d in dips:
        por_partido[d['partido']]['diputados'] += 1
        por_provincia[d['provincia']]['diputados'] += 1

    def _final(agg):
        return {k: {'diputados': v['diputados'], 'proyectos': len(v['proyectos']), 'leyes': len(v['leyes']),
                    'participaciones': len(v['participaciones']), 'leyes_participacion': len(v['leyes_participacion'])}
                for k, v in sorted(agg.items(), key=lambda x: (-len(x[1]['proyectos']), x[0]))}
    pp_final, pv_final = _final(por_partido), _final(por_provincia)
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
        'efectividad_meta': efectividad_meta,
        'temas': nombres_temas,
        'por_tema': por_tema,
        'temas_por_ficha': {f: [nombres_temas.index(t) for t in ts] for f, ts in temas_ficha.items()},
        'temas_por_partido': {p: dict(v) for p, v in temas_partido.items()},
        'temas_por_provincia': {p: dict(v) for p, v in temas_provincia.items()},
        'red_partidos': {a: dict(v) for a, v in matriz.items()},
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

# ─────────────────────────────────────────────
# HISTORIAL DE ETAPAS Y NOVEDADES
# ─────────────────────────────────────────────
# etapas_historico.json guarda, por proyecto, cada cambio de etapa con la fecha en que se
# DETECTÓ (la fecha de extracción, no la de la Asamblea, que no se publica). A partir de ahí
# se generan novedades.json (lo que cambió) y novedades.xml (feed RSS).
ETAPAS_HIST = 'etapas_historico.json'
NOVEDADES_JSON = 'novedades.json'
NOVEDADES_RSS = 'novedades.xml'
# Orden real observado en los datos: el anteproyecto se "prohíja" (la comisión lo adopta), pasa a
# primer debate y desde ahí puede ir a subcomisión antes del segundo debate.
ORDEN_TRAMITE = ['Preliminar', 'Prohijado', 'Primer Debate', 'Enviado a subcomisión para analisis',
                 'Segundo Debate', 'Tercer Debate', 'Enviado al Ejecutivo', 'Ley']
ETAPAS_DETENIDO = {'Archivado', 'Negado', 'Retirado por proponente', 'Suspendido'}
PRECISION_DIAS = 7   # solo se mide el tiempo hasta ley si se detectó a menos de 7 días de ocurrir

def _fecha_iso(ts):
    return f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"

def actualizar_etapas(datos, ts, ruta=ETAPAS_HIST):
    """Registra la etapa de cada proyecto si cambió desde la última extracción."""
    hist = _leer_json(ruta) or {}
    fecha = _fecha_iso(ts)
    hist.setdefault('desde', fecha)
    fechas = hist.setdefault('fechas', [])
    if not fechas or fechas[-1] != fecha:
        if fechas and fecha < fechas[-1]:
            return hist          # extracción más vieja que la última registrada: no se mezcla
        fechas.append(fecha)
    proy = hist.setdefault('proyectos', {})
    vistos = set()
    for r in datos:
        f = r['ficha']
        vistos.add(f)
        h = proy.setdefault(f, [])
        if not h or h[-1][1] != r['etapa']:
            if h and h[-1][0] == fecha:
                h[-1][1] = r['etapa']          # segunda corrida del mismo día: se corrige
            else:
                h.append([fecha, r['etapa']])
    # Proyectos que la fuente dejó de publicar (salvo que la extracción venga claramente incompleta)
    publicados = sum(1 for h in proy.values() if h and h[-1][1] is not None and h[-1][0] != fecha)
    if len(datos) >= 0.8 * publicados:
        for f, h in proy.items():
            if f not in vistos and h and h[-1][1] is not None:
                h.append([fecha, None])
    with open(ruta, 'w', encoding='utf-8') as fh:
        json.dump(hist, fh, ensure_ascii=False, separators=(',', ':'))
    return hist

def _tipo_evento(de, a):
    if de is None: return 'nuevo'
    if a == 'Ley': return 'ley'
    if a in ETAPAS_DETENIDO: return 'detenido'
    if 'Objetado' in (a or ''): return 'objetado'
    if de in ORDEN_TRAMITE and a in ORDEN_TRAMITE and ORDEN_TRAMITE.index(a) > ORDEN_TRAMITE.index(de):
        return 'avance'
    if 'Objetado' in de and a in ('Enviado al Ejecutivo', 'Ley'):
        return 'avance'                          # superó la objeción y vuelve al Ejecutivo
    return 'cambio'

def _fecha_pres(r):
    p = (r.get('fecha_presentacion') or '').split('-')
    return f"{p[2]}-{p[1]}-{p[0]}" if len(p) == 3 else None

def generar_novedades(hist, datos):
    from datetime import date
    por_ficha = {r['ficha']: r for r in datos}
    desde, fechas = hist.get('desde'), hist.get('fechas', [])
    eventos = []
    for f, h in hist.get('proyectos', {}).items():
        r = por_ficha.get(f, {})
        titulo = r.get('titulo') or r.get('anteproyecto') or ''
        for i, (fecha, etapa) in enumerate(h):
            if etapa is None: continue
            if i == 0 and fecha == desde: continue    # estado inicial, no es una novedad
            # Etapa anterior conocida (si el proyecto dejó de publicarse un tiempo, la de antes)
            de = next((x[1] for x in reversed(h[:i]) if x[1] is not None), None)
            if de == etapa: continue                  # reapareció igual que antes: no es novedad
            if de is None and i > 0: continue         # sin etapa previa conocida
            eventos.append({'fecha': fecha, 'tipo': _tipo_evento(de, etapa), 'ficha': f,
                            'de': de, 'a': etapa, 'titulo': titulo[:220]})
    eventos.sort(key=lambda e: (e['fecha'], int(e['ficha']) if e['ficha'].isdigit() else 0), reverse=True)

    # Tiempo desde la presentación hasta ley, solo para leyes detectadas con poca demora
    dias = []
    for e in eventos:
        if e['tipo'] != 'ley': continue
        idx = fechas.index(e['fecha']) if e['fecha'] in fechas else -1
        previa = fechas[idx - 1] if idx > 0 else None
        pres = _fecha_pres(por_ficha.get(e['ficha'], {}))
        if not previa or not pres: continue
        d_ley, d_prev = date.fromisoformat(e['fecha']), date.fromisoformat(previa)
        if (d_ley - d_prev).days <= PRECISION_DIAS:
            dias.append({'ficha': e['ficha'], 'dias': (d_ley - date.fromisoformat(pres)).days})
    # Huecos entre extracciones: los cambios detectados al final de un hueco pueden ser anteriores
    huecos = [{'desde': a, 'hasta': b} for a, b in zip(fechas, fechas[1:])
              if (date.fromisoformat(b) - date.fromisoformat(a)).days > PRECISION_DIAS]
    vals = sorted(x['dias'] for x in dias)
    cuantil = lambda q: vals[min(len(vals) - 1, int(round(q * (len(vals) - 1))))] if vals else None
    return {
        'desde': desde, 'actualizado': fechas[-1] if fechas else None, 'precision_dias': PRECISION_DIAS,
        'huecos': huecos,
        'eventos': eventos,
        'tiempo_ley': {'n': len(vals), 'mediana': cuantil(.5), 'p25': cuantil(.25), 'p75': cuantil(.75), 'casos': dias},
    }

def generar_rss(nov, limite=60):
    from html import escape as e
    from email.utils import format_datetime
    from datetime import datetime as dt, timezone
    etiqueta = {'nuevo': 'Nuevo proyecto', 'ley': 'Nueva ley', 'avance': 'Avanza a {a}', 'objetado': '{a}',
                'detenido': '{a}', 'cambio': 'Cambia a {a}'}
    items = []
    for ev in nov['eventos'][:limite]:
        tit = etiqueta[ev['tipo']].format(a=ev['a']) + f": {ev['titulo'][:140]}"
        fecha = format_datetime(dt.fromisoformat(ev['fecha']).replace(hour=12, tzinfo=timezone.utc))
        desc = f"Ficha {ev['ficha']}. " + (f"De «{ev['de']}» a «{ev['a']}»." if ev['de'] else f"Etapa: {ev['a']}.")
        items.append(f"""  <item>
    <title>{e(tit)}</title>
    <link>{SITE_URL}/#proyecto={ev['ficha']}</link>
    <guid isPermaLink="false">{ev['ficha']}-{ev['fecha']}-{e(ev['a'])}</guid>
    <pubDate>{fecha}</pubDate>
    <description>{e(desc)}</description>
  </item>""")
    with open(NOVEDADES_RSS, 'w', encoding='utf-8') as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Observatorio Legislativo — Novedades</title>
  <link>{SITE_URL}/#novedades</link>
  <atom:link href="{SITE_URL}/{NOVEDADES_RSS}" rel="self" type="application/rss+xml"/>
  <description>Proyectos nuevos, avances de etapa y nuevas leyes en la Asamblea Nacional de Panamá.</description>
  <language>es-pa</language>
{chr(10).join(items)}
</channel>
</rss>
""")

def actualizar_novedades(datos, ts):
    hist = actualizar_etapas(datos, ts)
    nov = generar_novedades(hist, datos)
    with open(NOVEDADES_JSON, 'w', encoding='utf-8') as f:
        json.dump(nov, f, ensure_ascii=False, separators=(',', ':'))
    generar_rss(nov)
    print(f"  Novedades: {len(nov['eventos'])} eventos desde {nov['desde']} · leyes con tiempo medido: {nov['tiempo_ley']['n']}")
    return nov


# ─────────────────────────────────────────────
# PÁGINAS PARA COMPARTIR (una por diputado)
# ─────────────────────────────────────────────
# El sitio es una sola página: un enlace #diputado=... siempre mostraría la vista previa genérica.
# Estas páginas estáticas llevan título, descripción y cifras de cada diputado (lo que leen
# WhatsApp, X, Facebook y Google) y redirigen a las personas a la ficha completa del sitio.
SITE_URL = 'https://observatoriolegistalivopa.netlify.app'
CARPETA_DIPUTADOS = 'diputado'

def _fmt_num(v):
    return f"{int(round(v)):,}" if isinstance(v, (int, float)) else '—'

def _lectura_indice(ef):
    indice = ef.get('indice')
    if indice is None: return None
    if ef.get('evidencia') == 'baja': return 'pocos datos'
    return 'sobre el promedio' if indice >= 120 else 'bajo el promedio' if indice <= 80 else 'en el promedio'

def _imagen_diputado(d, ruta):
    """
    Dibuja la imagen de vista previa (1200×630) de un diputado. Devuelve True si se escribió.
    No lleva fecha ni foto: así el archivo solo cambia cuando cambian sus cifras y el repositorio
    no crece cada día (las fotos son de Espacio Cívico).
    """
    try:
        from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
    except ImportError:
        return False
    import io, os, hashlib
    # Firma de lo que muestra la imagen (y de esta función): si no cambió, no se redibuja. Se compara
    # la firma y no los píxeles porque Windows y Linux dibujan las fuentes con diferencias mínimas.
    ef0 = (d.get('efectividad_ley') or {}).get('autor') or {}
    datos_img = [d['nombre'], d.get('partido'), d.get('provincia'), d.get('circuito'), d.get('proyectos', 0),
                 d.get('leyes', 0), d.get('co_patrocinios', 0), ef0.get('indice'), ef0.get('evidencia'), 'v1']
    firma = hashlib.sha1(json.dumps(datos_img, ensure_ascii=False).encode('utf-8')).hexdigest()
    if os.path.exists(ruta):
        try:
            if Image.open(ruta).info.get('firma') == firma:
                return False
        except Exception:
            pass
    W, H = 1200, 630
    BG, TXT, MUTED, ACC, BORDE, VERDE = '#080c14', '#e2e8f0', '#7a8fb0', '#3b82f6', '#1a2940', '#34d399'
    fd = lambda size, peso='ExtraBold': _fuente('fonts/Syne-Variable.ttf', size, peso)
    fm = lambda size, medio=False: _fuente('fonts/DMMono-Medium.ttf' if medio else 'fonts/DMMono-Regular.ttf', size)
    im = Image.new('RGB', (W, H), BG)
    dr = ImageDraw.Draw(im)
    for x in range(0, W, 48): dr.line([(x, 0), (x, H)], fill='#0c1322')
    for y in range(0, H, 48): dr.line([(0, y), (W, y)], fill='#0c1322')
    if os.path.exists('img/logo-512.png'):
        logo = Image.open('img/logo-512.png').convert('RGBA').resize((84, 84), Image.LANCZOS)
        im.paste(logo, (70, 56), logo)
    dr.text((172, 70), 'OBSERVATORIO LEGISLATIVO', font=fm(22, True), fill=ACC)
    dr.text((172, 104), 'Asamblea Nacional de Panamá', font=fm(20), fill=MUTED)

    # Nombre: se reduce la letra hasta que quepa en dos líneas como máximo
    nombre = d['nombre']
    for size in (80, 72, 64, 56, 50):
        f = fd(size)
        palabras, lineas, actual = nombre.split(), [], ''
        for p in palabras:
            prueba = (actual + ' ' + p).strip()
            if dr.textlength(prueba, font=f) <= W - 140: actual = prueba
            else: lineas.append(actual); actual = p
        lineas.append(actual)
        if len(lineas) <= 2: break
    y = 186
    for linea in lineas:
        dr.text((70, y), linea, font=f, fill=TXT); y += int(size * 1.08)
    lugar = ' · '.join(x for x in (d.get('partido'), d.get('provincia'), d.get('circuito')) if x)
    dr.text((70, y + 8), lugar[:70], font=fm(24), fill=MUTED)

    ef = (d.get('efectividad_ley') or {}).get('autor') or {}
    cifras = [('Proyectos propuestos', _fmt_num(d.get('proyectos', 0)), TXT),
              ('Leyes aprobadas', _fmt_num(d.get('leyes', 0)), VERDE),
              ('Co-patrocinios', _fmt_num(d.get('co_patrocinios', 0)), TXT),
              ('Efectividad', str(ef['indice']) if ef.get('indice') is not None else '—',
               MUTED if ef.get('evidencia') == 'baja' else ACC)]
    x0, ancho, gap, yb = 70, 245, 20, 440
    for i, (lbl, val, color) in enumerate(cifras):
        x = x0 + i * (ancho + gap)
        dr.rounded_rectangle([x, yb, x + ancho, yb + 112], radius=16, fill='#0e1623', outline=BORDE, width=2)
        dr.text((x + 20, yb + 16), lbl.upper(), font=fm(15, True), fill=MUTED)
        dr.text((x + 20, yb + 42), val, font=fd(46), fill=color)
    if ef.get('indice') is not None:
        dr.text((x0 + 3 * (ancho + gap) + 20, yb + 120), f"{_lectura_indice(ef)} (100 = promedio)", font=fm(15), fill=MUTED)
    dr.text((70, H - 50), 'Observatorio Legislativo · por @profealvarock', font=fm(18), fill=MUTED)

    meta = PngImagePlugin.PngInfo()
    meta.add_text('firma', firma)
    im.save(ruta, 'PNG', optimize=True, pnginfo=meta)
    return True

_FUENTES = {}
def _fuente(ruta, size, peso=None):
    from PIL import ImageFont
    clave = (ruta, size, peso)
    if clave not in _FUENTES:
        f = ImageFont.truetype(ruta, size)
        if peso:
            try: f.set_variation_by_name(peso)
            except Exception: pass
        _FUENTES[clave] = f
    return _FUENTES[clave]

def _pagina_diputado(d, fecha, imagen=None):
    from html import escape as e
    slug = d['slug']
    url = f"{SITE_URL}/{CARPETA_DIPUTADOS}/{slug}/"
    destino = f"/#diputado={slug}"
    ef = (d.get('efectividad_ley') or {}).get('autor') or {}
    indice = ef.get('indice')
    lectura = _lectura_indice(ef)
    lugar = ' · '.join(x for x in (d.get('provincia'), d.get('circuito')) if x)
    partes = [f"{d.get('proyectos', 0)} proyectos propuestos", f"{d.get('leyes', 0)} leyes",
              f"{d.get('co_patrocinios', 0)} co-patrocinios"]
    if indice is not None:
        partes.append(f"efectividad {indice} ({lectura}; 100 = promedio)")
    if d.get('asistencia_pleno') is not None:
        partes.append(f"asistencia al pleno {d['asistencia_pleno']:g}/5")
    descripcion = f"{d.get('partido') or 'Diputado'} · {lugar}. " + ', '.join(partes) + '.'
    temas = ', '.join(list((d.get('temas_autor') or {}).keys())[:3])
    filas = [
        ('Proyectos propuestos', d.get('proyectos', 0)), ('Co-patrocinios', d.get('co_patrocinios', 0)),
        ('Leyes aprobadas', d.get('leyes', 0)),
        ('Índice de efectividad', f"{indice} · {lectura}" if indice is not None else '—'),
        ('Asistencia al pleno', f"{d['asistencia_pleno']:g} / 5" if d.get('asistencia_pleno') is not None else '—'),
        ('Planilla (Espacio Cívico)', f"B/. {_fmt_num(d.get('planilla_valor'))}" if d.get('planilla_valor') is not None else '—'),
    ]
    persona = {'@context': 'https://schema.org', '@type': 'Person', 'name': d['nombre'],
               'jobTitle': 'Diputado de la Asamblea Nacional de Panamá', 'url': url}
    if d.get('partido'): persona['affiliation'] = {'@type': 'Organization', 'name': d['partido']}
    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{e(d['nombre'])} — Observatorio Legislativo</title>
<meta name="description" content="{e(descripcion)}">
<link rel="canonical" href="{url}">
<link rel="icon" type="image/svg+xml" href="/img/logo.svg">
<meta property="og:type" content="profile">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{e(d['nombre'])} — Observatorio Legislativo">
<meta property="og:description" content="{e(descripcion)}">
<meta property="og:image" content="{imagen or SITE_URL + '/img/og-card.png'}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@profealvarock">
<script type="application/ld+json">{json.dumps(persona, ensure_ascii=False)}</script>
<style>
body{{margin:0;background:#080c14;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:32px 16px}}
main{{max-width:560px;width:100%}} a{{color:#60a5fa}} h1{{margin:.2em 0 .1em;font-size:1.7rem}}
.sub{{color:#7a8fb0;margin:0 0 18px}} table{{width:100%;border-collapse:collapse;margin:12px 0 18px}}
td{{padding:8px 0;border-bottom:1px solid #1a2940}} td+td{{text-align:right;font-weight:600}}
.btn{{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600}}
.pie{{color:#7a8fb0;font-size:.8rem;margin-top:22px}}
</style>
</head>
<body>
<main>
  <a href="/"><img src="/img/logo.svg" alt="Observatorio Legislativo" width="44" height="44"></a>
  <h1>{e(d['nombre'])}</h1>
  <p class="sub">{e(d.get('partido') or '')} · {e(lugar)}</p>
  <table>{''.join(f'<tr><td>{e(k)}</td><td>{e(str(v))}</td></tr>' for k, v in filas)}</table>
  {f'<p>Temas que más propone: {e(temas)}.</p>' if temas else ''}
  <a class="btn" href="{destino}">Ver la ficha completa en el observatorio →</a>
  <p class="pie">Datos al {e(fecha)} · Fuentes: Asamblea Nacional y Espacio Cívico · Observatorio Legislativo por @profealvarock</p>
</main>
<script>location.replace({json.dumps(destino)});</script>
</body>
</html>
"""

def generar_paginas_diputados(resumen):
    import os, shutil
    ts = resumen.get('fecha_extraccion', '')
    fecha = f"{ts[6:8]}/{ts[4:6]}/{ts[:4]}" if len(ts) >= 8 else ''
    os.makedirs(CARPETA_DIPUTADOS, exist_ok=True)
    slugs, nuevas = set(), 0
    for d in resumen.get('diputados', []):
        if not d.get('slug'): continue
        slugs.add(d['slug'])
        carpeta = os.path.join(CARPETA_DIPUTADOS, d['slug'])
        os.makedirs(carpeta, exist_ok=True)
        ruta_img = os.path.join(carpeta, 'og.png')
        if _imagen_diputado(d, ruta_img): nuevas += 1
        imagen = f"{SITE_URL}/{CARPETA_DIPUTADOS}/{d['slug']}/og.png" if os.path.exists(ruta_img) else None
        with open(os.path.join(carpeta, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(_pagina_diputado(d, fecha, imagen))
    # Quitar páginas de diputados que ya no están
    for nombre in os.listdir(CARPETA_DIPUTADOS):
        if nombre not in slugs and os.path.isdir(os.path.join(CARPETA_DIPUTADOS, nombre)):
            shutil.rmtree(os.path.join(CARPETA_DIPUTADOS, nombre))
    hoy = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}" if len(ts) >= 8 else ''
    urls = [f"{SITE_URL}/"] + [f"{SITE_URL}/{CARPETA_DIPUTADOS}/{s}/" for s in sorted(slugs)]
    with open('sitemap.xml', 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        f.writelines(f"  <url><loc>{u}</loc><lastmod>{hoy}</lastmod></url>\n" for u in urls)
        f.write('</urlset>\n')
    print(f"  Páginas para compartir: {len(slugs)} diputados ({nuevas} imágenes actualizadas) + sitemap.xml")

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
    generar_paginas_diputados(resumen)
    hist = _leer_json(ETAPAS_HIST)
    if hist:   # sin extracción nueva no se registran etapas; solo se recalculan las novedades
        nov = generar_novedades(hist, datos)
        with open(NOVEDADES_JSON, 'w', encoding='utf-8') as f:
            json.dump(nov, f, ensure_ascii=False, separators=(',', ':'))
        generar_rss(nov)
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
    try:
        generar_paginas_diputados(resumen)
    except Exception as e:
        print(f"  ADVERTENCIA: no se pudieron generar las páginas de diputados: {e}")
    try:
        actualizar_novedades(datos, resumen['fecha_extraccion'])
    except Exception as e:
        print(f"  ADVERTENCIA: no se pudieron actualizar las novedades: {e}")

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
