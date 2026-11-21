"""
Observatorio Ciudadano de Panamá — actualización semanal de Aprobación, Sismo, Costo de vida, Salarios, Educación y Minería.

Lee y actualiza data/aprobacion.json, data/sismo.json, data/costo_vida.json y data/mineria.json. Hay un módulo por
fuente; cada uno valida lo que encuentra (número, rango razonable, fecha de corte no futura) y,
si falla, no rompe el job: se conserva el valor anterior y el problema queda en "advertencias"
dentro del JSON. Las series solo crecen: se agregan registros nuevos y se deduplican por período.

Uso:
  python scripts/actualizar_indicadores.py                 # todas las fuentes
  python scripts/actualizar_indicadores.py --solo cbfa,combustible
  python scripts/actualizar_indicadores.py --hoy 2026-11-23   # fecha de referencia (pruebas)
"""
import argparse
import html as html_lib
import io
import json
import re
import sys
import unicodedata
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree

RAIZ = Path(__file__).resolve().parent.parent
DATA = RAIZ / 'data'
ARCHIVOS = {'aprobacion': 'aprobacion.json', 'sismo': 'sismo.json', 'costo_vida': 'costo_vida.json', 'mineria': 'mineria.json', 'salarios': 'salarios.json', 'educacion': 'educacion.json'}

UA = 'Mozilla/5.0 (compatible; ObservatorioLegislativoPA/1.0; +https://observatoriolegistalivopa.netlify.app)'
TIMEOUT = 30
LITROS_POR_GALON = 3.785411784

# Fuentes de descubrimiento (RSS públicos). Los precios oficiales de combustible se publican como
# imagen, así que el período sale de la Secretaría Nacional de Energía y las cifras, de la prensa.
FEED_SNE = 'https://www.energia.gob.pa/feed/'
FEED_SINAPROC = 'https://www.sinaproc.gob.pa/feed/'
FEEDS_PRENSA = ['https://www.tvn-2.com/rss/', 'https://www.tvn-2.com/rss/nacionales/', 'https://www.tvn-2.com/rss/economia/',
                'https://www.panamaamerica.com.pa/rss.xml']
# Los RSS solo guardan uno o dos días de noticias y el job corre el lunes, cinco días después del
# anuncio de la SNE: las páginas de etiqueta de Telemetro conservan las notas de varias semanas.
ETIQUETAS_COMBUSTIBLE = ['https://www.telemetro.com/tags/combustible', 'https://www.telemetro.com/tags/gasolina']
SINAPROC_COMUNICADO = 'https://www.sinaproc.gob.pa/comunicado-oficial-{n}/'
MEF_CBFA = 'https://www.mef.gob.pa/wp-content/uploads/{y}/{mm:02d}/MEF-DAES-Canasta-Basica-Familiar-de-Alimentos-{mes}-{anio}.pdf'

MESES = {'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4, 'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
         'septiembre': 9, 'setiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12}
MESES_MAYUS = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
               'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']
PALABRAS_NUM = {'un': 1, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5, 'seis': 6,
                'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10}

# Rangos razonables por indicador: un valor fuera de rango se descarta y se registra.
RANGOS = {
    'combustible_gal': (2.0, 10.0),
    'cbfa': (200.0, 600.0),
    'porcentaje': (0.0, 100.0),
}


class ErrorValidacion(ValueError):
    pass


# ── UTILIDADES ───────────────────────────────────────────────────────────────

def sin_tildes(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '') if unicodedata.category(c) != 'Mn').lower()


def html_a_texto(html):
    s = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', html or '')
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    return re.sub(r'\s+', ' ', html_lib.unescape(s)).strip()


def a_entero(s):
    """'13,681' · '13.681' · '208317' · 'dos' → int"""
    s = (s or '').strip().lower()
    if s in PALABRAS_NUM:
        return PALABRAS_NUM[s]
    return int(re.sub(r'[.,\s]', '', s))


def a_decimal(s):
    """'17,9' · '1.231' · '366.98' → float (la coma decimal de la prensa se acepta)"""
    return float(str(s).strip().replace(',', '.'))


def validar_numero(v, nombre, rango=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ErrorValidacion(f'{nombre}: no es numérico ({v!r})')
    if rango and not (rango[0] <= v <= rango[1]):
        raise ErrorValidacion(f'{nombre}: {v} fuera del rango razonable {rango[0]}–{rango[1]}')
    return v


def validar_fecha(f, hoy, nombre):
    d = f if isinstance(f, date) else date.fromisoformat(str(f)[:10])
    if d > hoy:
        raise ErrorValidacion(f'{nombre}: fecha de corte futura ({d.isoformat()})')
    return d


def frescura(fecha_corte, hoy):
    """Misma regla que la interfaz: ≤7 días verde, 8–30 ámbar, >30 rojo."""
    if not fecha_corte:
        return ('sd', None)
    d = fecha_corte if isinstance(fecha_corte, date) else date.fromisoformat(str(fecha_corte)[:10])
    dias = (hoy - d).days
    if dias <= 7:
        return ('verde', dias)
    if dias <= 30:
        return ('ambar', dias)
    return ('rojo', dias)


def dedup_series(registros, clave='periodo'):
    """Un registro por período (gana el más reciente agregado), ordenado por período."""
    vistos = {}
    for r in registros or []:
        vistos[str(r.get(clave))] = r
    return [vistos[k] for k in sorted(vistos)]


def metrica(D, mid):
    return next((m for m in D.get('metricas', []) if m.get('id') == mid), None)


def fecha_mayor(D):
    fechas = [m['fecha_corte'] for m in D.get('metricas', []) if m.get('fecha_corte') and m.get('valor') is not None]
    return max(fechas) if fechas else None


# ── RED ──────────────────────────────────────────────────────────────────────

_BUNDLES = {}


def _bundle_con_intermedio(host):
    """Algunos servidores públicos (p. ej. meduca.gob.pa) no envían su certificado intermedio. Como hacen los
    navegadores, se descarga el intermedio desde la dirección 'CA Issuers' (AIA) del propio certificado y se
    valida la cadena completa contra las raíces de certifi. La verificación TLS nunca se desactiva."""
    if host in _BUNDLES:
        return _BUNDLES[host]
    import socket, ssl, tempfile, urllib.request, certifi
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE   # solo para leer el certificado, no para usarlo
    with socket.create_connection((host, 443), timeout=TIMEOUT) as s, ctx.wrap_socket(s, server_hostname=host) as t:
        der = t.getpeercert(binary_form=True)
    with tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False) as f:
        f.write(ssl.DER_cert_to_PEM_cert(der))
    info = ssl._ssl._test_decode_cert(f.name)   # noqa: SLF001 — lee la extensión AIA sin dependencias extra
    os_remove(f.name)
    emisores = [u for u in info.get('caIssuers', ()) if u.startswith('http')]
    if not emisores:
        raise ssl.SSLError(f'{host}: el certificado no indica dónde obtener su intermedio')
    with urllib.request.urlopen(emisores[0], timeout=TIMEOUT) as resp:   # el intermedio se sirve por HTTP (estándar AIA)
        inter = resp.read()
    pem = inter.decode() if inter.lstrip().startswith(b'-----BEGIN') else ssl.DER_cert_to_PEM_cert(inter)
    with tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False, encoding='utf-8') as f:
        f.write(open(certifi.where(), encoding='utf-8').read() + '\n' + pem)
    _BUNDLES[host] = f.name
    return f.name


def os_remove(ruta):
    import os
    try:
        os.remove(ruta)
    except OSError:
        pass


def http_get(url, binario=False):
    import requests
    cab = {'User-Agent': UA, 'Accept-Language': 'es-PA,es;q=0.9'}
    try:
        r = requests.get(url, headers=cab, timeout=TIMEOUT)
    except requests.exceptions.SSLError:
        host = re.sub(r'^https?://([^/:]+).*', r'\1', url)
        r = requests.get(url, headers=cab, timeout=TIMEOUT, verify=_bundle_con_intermedio(host))
    r.raise_for_status()
    if binario:
        return r.content
    r.encoding = r.encoding if r.encoding and r.encoding.lower() != 'iso-8859-1' else 'utf-8'
    return r.text


def existe(url):
    import requests
    try:
        r = requests.head(url, headers={'User-Agent': UA}, timeout=TIMEOUT, allow_redirects=True)
        return r.status_code == 200
    except requests.RequestException:
        return False


def leer_rss(xml):
    """→ [{titulo, url, fecha (date|None), descripcion}]"""
    items = []
    raiz = ElementTree.fromstring(xml.encode('utf-8') if isinstance(xml, str) else xml)
    for it in raiz.iter('item'):
        def campo(t):
            e = it.find(t)
            return (e.text or '').strip() if e is not None and e.text else ''
        f = None
        try:
            f = parsedate_to_datetime(campo('pubDate')).date() if campo('pubDate') else None
        except (TypeError, ValueError):
            f = None
        items.append({'titulo': html_lib.unescape(campo('title')), 'url': campo('link'), 'fecha': f,
                      'descripcion': html_a_texto(campo('description'))})
    return items


def pdf_a_texto(datos):
    from pypdf import PdfReader
    lector = PdfReader(io.BytesIO(datos))
    return '\n'.join((p.extract_text() or '') for p in lector.pages[:12])


# ── PARSERS (funciones puras, con pruebas en tests/) ─────────────────────────

def parse_periodo_sne(titulo):
    """'… del 13 al 27 de noviembre de 2026' · '… del 30 de octubre al 13 de noviembre de 2026'
    → (date inicio, date fin) o None"""
    t = sin_tildes(titulo)
    m = re.search(r'del\s+(\d{1,2})(?:\s+de\s+([a-z]+))?(?:\s+de\s+(\d{4}))?\s+al\s+(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})', t)
    if not m:
        return None
    d1, mes1, a1, d2, mes2, a2 = m.groups()
    m2 = MESES.get(mes2)
    m1 = MESES.get(mes1) if mes1 else m2
    if not m1 or not m2:
        return None
    a2 = int(a2)
    a1 = int(a1) if a1 else (a2 - 1 if m1 > m2 else a2)
    return date(a1, m1, int(d1)), date(a2, m2, int(d2))


_LITRO = r'(?:B/\.?|\$|USD)\s?(\d[.,]\d{2,3})'


def _precio_litro(seg, etiqueta):
    """Primer precio por litro (0.5–2.7) que sigue a la etiqueta del combustible; así se saltan
    las variaciones ('B/.0.093 menos por litro')."""
    # Entre la etiqueta y el precio puede haber texto con números ("bajará cerca de 9 centavos"),
    # pero no otra etiqueta de combustible: así un precio no se asigna al combustible equivocado.
    for m in re.finditer(etiqueta + r'(?:(?!octanos|di[ée]sel).){0,110}?' + _LITRO, seg, re.I):
        v = a_decimal(m.group(1))
        if 0.5 <= v <= 2.7:
            return v
    return None


def parse_combustible(texto):
    """Precios máximos por litro en Panamá y Colón, desde una nota de prensa.
    → {'g95': 1.231, 'g91': 1.102, 'diesel': 1.434} o None si falta alguno"""
    t = re.sub(r'\s+', ' ', texto or '')
    i = t.find('Panamá y Colón')
    segmentos = ([t[i:i + 700]] if i >= 0 else []) + [t]
    for seg in segmentos:
        r = {'g95': _precio_litro(seg, r'95\s*octanos'),
             'g91': _precio_litro(seg, r'91\s*octanos'),
             'diesel': _precio_litro(seg, r'di[ée]sel(?:\s+bajo\s+en\s+azufre)?')}
        if all(r.values()):
            return r
    return None


def litro_a_galon(v):
    return round(v * LITROS_POR_GALON, 2)


NOMBRE_MES = {v: k for k, v in MESES.items() if k != 'setiembre'}


def menciona_fecha(texto, d):
    """¿El texto nombra el día de inicio del período ('13 de noviembre')? Evita usar precios de otra quincena."""
    return re.search(rf'\b{d.day}\s+(?:de\s+)?{NOMBRE_MES[d.month]}', sin_tildes(texto)) is not None


def enlaces_combustible(html, d):
    """Enlaces de una página de etiqueta cuyo slug habla de combustible y del día de inicio del período."""
    dia = rf'(?:^|[-/]){d.day}-(?:de-)?{NOMBRE_MES[d.month]}'
    vistos = []
    for u in re.findall(r'href="(https?://[^"#?]+)"', html or ''):
        slug = sin_tildes(u)
        if re.search(r'gasolin|diesel|combustib', slug) and re.search(dia, slug) and u not in vistos:
            vistos.append(u)
    return vistos


def parse_cbfa(texto):
    """Resumen del informe mensual del MEF para Panamá y San Miguelito. La redacción cambia cada mes:
      '… San Miguelito, fue B/.366.98 en junio, … mes anterior (B/.367.00)'
      '… San Miguelito, se calculó a un costo de B/.367.03 en julio, … junio pasado (B/.366.98)'
    → {'mes': 6, 'valor': 366.98, 'previo': 367.00}. 'previo' es la cifra (quizá revisada) del mes anterior."""
    t = re.sub(r'\s+', ' ', texto or '')
    m = re.search(r'San\s+Miguelito,?[^()]{0,70}?B/\.?\s?(\d{3}[.,]\d{2})\s+en\s+([A-Za-zé]+)', t)
    if not m:
        return None
    mes = MESES.get(sin_tildes(m.group(2)))
    if not mes:
        return None
    prev = re.search(r'\(B/\.?\s?(\d{3}[.,]\d{2})\)', t[m.end():m.end() + 260])
    return {'mes': mes, 'valor': a_decimal(m.group(1)), 'previo': a_decimal(prev.group(1)) if prev else None}


_NUM = r'(\d{1,3}(?:[.,]\d{3})+|\d+)'


def parse_sinaproc_balance(texto):
    """Comunicado de Sinaproc → dict con los campos encontrados y 'fecha_corte' (date)."""
    t = re.sub(r'\s+', ' ', texto or '')
    pub = re.search(r'Panam[áa],\s+(\d{1,2})\s+de\s+([a-záé]+)\s+de\s+(\d{4})', t)
    anio = int(pub.group(3)) if pub else None
    r = {}
    pal = r'(\d[\d.,]*|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)'
    # Varias redacciones por campo (los comunicados cambian de forma). Cada patrón exige el contexto
    # completo: "48 toneladas de asistencia" de la cooperación internacional no es ayuda terrestre.
    patrones = {
        'viviendas_evaluadas': [_NUM + r'\s+viviendas\s+evaluadas', r'evaluado\s+' + _NUM + r'\s+viviendas'],
        'afectados': [_NUM + r'\s+personas\s+registradas', r'poblaci[óo]n\s+de\s+' + _NUM + r'\s+personas'],
        'heridos': [pal + r'\s+personas\s+lesionad[oa]s', r'fallecid[oa]s\s+y\s+' + pal + r'\s+lesionad[oa]s'],
        'fallecidos': [pal + r'\s+personas\s+fallecid[oa]s', pal + r'\s+fallecid[oa]s'],
        'escuelas': [_NUM + r'\s+centros\s+educativos\s+con\s+afectaciones', r'de\s+los\s+cuales\s+' + _NUM + r'\s+presentan\s+afectaciones'],
        'salud': [_NUM + r'\s+(?:centros|instalaciones)\s+de\s+salud\s+(?:con\s+)?afectad', r'salud[^.]{0,60}?' + _NUM + r'\s+(?:centros|instalaciones)\s+afectad[oa]s'],
        'albergues': [_NUM + r'\s+albergues\b'],
        'albergados': [r'albergues\s+con\s+' + _NUM + r'\s+personas', r'albergues,?\s+donde\s+permanecen\s+' + _NUM + r'\s+personas',
                       _NUM + r'\s+personas\s+(?:alojadas|albergadas)'],
        'ayuda_aire_lb': [_NUM + r'\s+libras\s+de\s+ayuda[^.]{0,40}?a[ée]rea'],
        'ayuda_tierra_t': [_NUM + r'\s+toneladas[^.]{0,30}?terrestre'],
        'comunidades_atendidas': [_NUM + r'\s+comunidades\s+atendidas'],
    }
    for k, lista in patrones.items():
        for p in lista:
            m = re.search(p, t, re.I)
            if m:
                r[k] = a_entero(m.group(1))
                break
    if not ('viviendas_evaluadas' in r or 'afectados' in r):
        return None
    corte = re.search(r'corte\s+a\s+las\s+\d{1,2}:\d{2}.{0,40}?(\d{1,2})\s+de\s+([a-záé]+)', t, re.I)
    if corte and anio:
        mes = MESES.get(sin_tildes(corte.group(2)))
        if mes:
            mes_pub = MESES.get(sin_tildes(pub.group(2)))
            r['fecha_corte'] = date(anio - 1 if mes_pub and mes > mes_pub else anio, mes, int(corte.group(1)))
    if 'fecha_corte' not in r and pub:
        r['fecha_corte'] = date(anio, MESES[sin_tildes(pub.group(2))], int(pub.group(1)))
    return r


def parse_replicas(texto):
    """'… se han contabilizado aproximadamente 1,690 réplicas' → {'localizadas': 1690, 'aproximado': True}"""
    t = re.sub(r'\s+', ' ', texto or '')
    m = re.search(r'(?:contabilizad[oa]s?|registrad[oa]s?|localizad[oa]s?|suman|acumulan?)\s+'
                  r'(aproximadamente\s+|m[áa]s\s+de\s+|cerca\s+de\s+|unas\s+)?' + _NUM + r'\s+r[ée]plicas', t, re.I)
    if not m:
        return None
    return {'localizadas': a_entero(m.group(2)), 'aproximado': bool(m.group(1))}


_PCT = r'(\d{1,2}(?:[.,]\d{1,2})?)\s?%'


def _pct_cerca(t, patron, despues=70, antes=160):
    m = re.search(patron, t, re.I)
    if not m:
        return None
    tras = re.search(_PCT, t[m.end():m.end() + despues])
    if tras:
        return a_decimal(tras.group(1))
    previos = list(re.finditer(_PCT, t[max(0, m.start() - antes):m.start()]))
    return a_decimal(previos[-1].group(1)) if previos else None


def parse_vea(texto):
    """Nota de La Estrella sobre una encuesta Vea Panamá → dict con buena, mala, mal_camino,
    campo (inicio, fin) y n. None si no es una medición completa."""
    t = re.sub(r'\s+', ' ', texto or '')
    if 'Vea Panam' not in t:
        return None
    q = r'["“”«»]?'
    buena = _pct_cerca(t, q + r'buena' + q + r'\s+y\s+' + q + r'muy\s+buena' + q)
    mala = _pct_cerca(t, q + r'mala' + q + r'\s+o\s+' + q + r'muy\s+mala' + q, despues=0)
    camino = re.search(r'mal\s+camino[^%]{0,40}?' + _PCT, t, re.I)
    campo = re.search(r'entre\s+el\s+(\d{1,2})\s+y\s+el\s+(\d{1,2})\s+de\s+([a-záé]+)\s+de\s+(\d{4})', t, re.I)
    n = re.search(r'(\d{1,2}[.,]\d{3})\s+entrevistas', t)
    if buena is None or mala is None or not campo:
        return None
    mes = MESES.get(sin_tildes(campo.group(3)))
    anio = int(campo.group(4))
    return {
        'buena': buena, 'mala': mala,
        'mal_camino': a_decimal(camino.group(1)) if camino else None,
        'campo': (date(anio, mes, int(campo.group(1))), date(anio, mes, int(campo.group(2)))),
        'n': a_entero(n.group(1)) if n else None,
    }


# ── MÓDULOS POR FUENTE ───────────────────────────────────────────────────────
# Cada módulo recibe el JSON de su pestaña, la fecha de referencia y la función de advertencias.

def _articulos_prensa(patron_titulo, desde=None, hasta=None):
    """Artículos de los RSS de prensa cuyo título coincide; ignora los feeds que no responden."""
    salida, errores = [], []
    for feed in FEEDS_PRENSA:
        try:
            for it in leer_rss(http_get(feed)):
                if not re.search(patron_titulo, sin_tildes(it['titulo'])):
                    continue
                if it['fecha'] and ((desde and it['fecha'] < desde) or (hasta and it['fecha'] > hasta)):
                    continue
                salida.append(it)
        except Exception as e:  # noqa: BLE001 — un feed caído no detiene el resto
            errores.append(f'{feed}: {e}')
    return salida, errores


def modulo_combustible(cv, hoy, avisar):
    serie = cv['series'].setdefault('combustible', [])
    conocidos = {r['periodo'] for r in serie}
    periodos = []
    for it in leer_rss(http_get(FEED_SNE)):
        if 'combustible' not in sin_tildes(it['titulo']):
            continue
        p = parse_periodo_sne(it['titulo'])
        if p:
            periodos.append((p, it))
    # Solo períodos posteriores al último conocido: los anteriores al inicio de la serie no se rellenan.
    ultimo_inicio = max((r['periodo'].split('/')[0] for r in serie), default='0000')
    nuevos = [(p, it) for p, it in sorted(periodos, key=lambda x: x[0])
              if f'{p[0]}/{p[1]}' not in conocidos and p[0].isoformat() > ultimo_inicio]
    if not nuevos:
        return False
    cambio = False
    for (ini, fin), it in nuevos:
        clave = f'{ini}/{fin}'
        try:
            validar_fecha(ini, hoy, f'combustible {clave}')
        except ErrorValidacion as e:
            avisar('combustible', f'{e}: el período aún no entra en vigencia; se tomará en la próxima corrida.')
            continue
        precios, fuente_url, fuente_nombre = None, None, None

        def probar(url):
            texto = html_a_texto(http_get(url))
            p = parse_combustible(texto)
            return p if p and menciona_fecha(texto, ini) else None
        # 1) el comunicado oficial (hoy sus cifras vienen en imagen; si algún día trae texto, se usa)
        try:
            precios = probar(it['url'])
            if precios:
                fuente_url, fuente_nombre = it['url'], 'Secretaría Nacional de Energía'
        except Exception as e:  # noqa: BLE001
            avisar('combustible', f'No se pudo leer el comunicado de la SNE ({e}).')
        # 2) notas de prensa: páginas de etiqueta de Telemetro y RSS publicados alrededor del anuncio
        if not precios:
            urls = []
            for pagina in ETIQUETAS_COMBUSTIBLE:
                try:
                    urls += enlaces_combustible(http_get(pagina), ini)
                except Exception as e:  # noqa: BLE001
                    avisar('combustible', f'Página de etiqueta no disponible: {pagina} ({e})')
            arts, errs = _articulos_prensa(r'combustible|gasolina|diesel', ini - timedelta(days=6), ini + timedelta(days=3))
            for err in errs:
                avisar('combustible', f'Feed de prensa no disponible: {err}')
            urls += [a['url'] for a in arts]
            for u in dict.fromkeys(urls):
                try:
                    precios = probar(u)
                except Exception:  # noqa: BLE001
                    precios = None
                if precios:
                    fuente_url, fuente_nombre = u, 'Secretaría Nacional de Energía (vía prensa)'
                    break
        if not precios:
            avisar('combustible', f'La SNE publicó el período {clave} ({it["url"]}), pero sus precios vienen en imagen '
                                  'y no se encontró una nota de prensa con las cifras. Se conserva el período anterior.')
            continue
        reg = {'periodo': clave}
        try:
            for k in ('g95', 'g91', 'diesel'):
                gal = validar_numero(litro_a_galon(precios[k]), f'combustible {k}', RANGOS['combustible_gal'])
                reg[k], reg[k + '_litro'] = gal, precios[k]
        except ErrorValidacion as e:
            avisar('combustible', str(e))
            continue
        reg.update({'fuente': fuente_nombre, 'url': fuente_url, 'comunicado': it['url']})
        serie.append(reg)
        cambio = True
    if cambio:
        cv['series']['combustible'] = dedup_series(serie)
        _actualizar_kpis_combustible(cv)
    return cambio


def _actualizar_kpis_combustible(cv):
    serie = cv['series']['combustible']
    ult, prev = serie[-1], (serie[-2] if len(serie) > 1 else None)
    ini = ult['periodo'].split('/')[0]
    for mid, k in (('gasolina_95_gal', 'g95'), ('gasolina_91_gal', 'g91'), ('diesel_gal', 'diesel')):
        m = metrica(cv, mid)
        if not m or ult.get(k) is None:
            continue
        m.update({'valor': ult[k], 'valor_litro': ult.get(k + '_litro'), 'fecha_corte': ini, 'periodo': ult['periodo'],
                  'variacion': round(ult[k] - prev[k], 2) if prev and prev.get(k) is not None else None,
                  'fuente': ult.get('fuente') or m.get('fuente'), 'url': ult.get('url') or m.get('url')})


def _url_cbfa(anio, mes):
    """Candidatos de URL del informe de un mes: el MEF lo sube 1–3 meses después."""
    nombres = [MESES_MAYUS[mes - 1]] + (['SETIEMBRE'] if mes == 9 else [])
    for desfase in (1, 2, 3, 4):
        y, mm = anio + (mes + desfase - 1) // 12, (mes + desfase - 1) % 12 + 1
        for nom in nombres:
            yield MEF_CBFA.format(y=y, mm=mm, mes=nom, anio=anio)


def modulo_cbfa(cv, hoy, avisar):
    serie = cv['series'].setdefault('cbfa', [])
    ultimo = max((r['periodo'] for r in serie), default='2026-01')
    y, m = int(ultimo[:4]), int(ultimo[5:7])
    cambio = False
    for _ in range(6):
        m += 1
        if m > 12:
            y, m = y + 1, 1
        if date(y, m, 1) >= date(hoy.year, hoy.month, 1):
            break
        url = next((u for u in _url_cbfa(y, m) if existe(u)), None)
        if not url:
            break  # aún no se publica; el rezago normal es de ~2 meses
        try:
            r = parse_cbfa(pdf_a_texto(http_get(url, binario=True)))
            if not r or r['mes'] != m:
                raise ErrorValidacion(f'el informe {url} no trae el costo de {MESES_MAYUS[m - 1].lower()} {y}')
            valor = validar_numero(r['valor'], 'cbfa', RANGOS['cbfa'])
        except Exception as e:  # noqa: BLE001
            avisar('cbfa', str(e))
            break
        # El MEF a veces revisa el mes anterior: se corrige el valor y se guarda el publicado primero.
        anterior = serie[-1] if serie else None
        if anterior and r.get('previo') and abs(r['previo'] - anterior['valor']) >= 0.005:
            try:
                validar_numero(r['previo'], 'cbfa previo', RANGOS['cbfa'])
                anterior.setdefault('valor_inicial', anterior['valor'])
                anterior.update({'valor': r['previo'], 'revisado_en': url})
                avisar('cbfa', f'El MEF revisó {anterior["periodo"]}: {anterior["valor_inicial"]} → {r["previo"]} (informe {url}).')
            except ErrorValidacion as e:
                avisar('cbfa', str(e))
        serie.append({'periodo': f'{y}-{m:02d}', 'valor': valor, 'url': url})
        cambio = True
    if cambio:
        cv['series']['cbfa'] = serie = dedup_series(serie)
        ult, prev = serie[-1], (serie[-2] if len(serie) > 1 else None)
        yy, mm = int(ult['periodo'][:4]), int(ult['periodo'][5:7])
        fin_mes = (date(yy + (mm == 12), mm % 12 + 1, 1) - timedelta(days=1)).isoformat()
        k = metrica(cv, 'cbfa')
        if k:
            k.update({'valor': ult['valor'], 'periodo': ult['periodo'], 'fecha_corte': fin_mes, 'url': ult['url'],
                      'variacion': round(ult['valor'] - prev['valor'], 2) if prev else None})
    return cambio


def modulo_pendientes(cv, hoy, avisar):
    """Electricidad, agua y gas: sin fuente que se pueda leer de forma automática y confiable.
    El módulo solo recuerda lo pendiente y avisa si una vigencia ya venció."""
    for mid, txt in (('electricidad_kwh', 'Precio por kWh pendiente: requiere calcularlo a mano desde el pliego tarifario de ASEP.'),
                     ('agua_idaan', 'Tarifa de agua pendiente: el pliego de ASEP/IDAAN localizado no tiene fecha de vigencia.')):
        m = metrica(cv, mid)
        if m and m.get('valor') is None:
            avisar(mid.split('_')[0], txt)
    gas = metrica(cv, 'gas_25lb')
    if gas and gas.get('periodo') and '/' in gas['periodo']:
        fin = date.fromisoformat(gas['periodo'].split('/')[1])
        if fin < hoy:
            avisar('gas', f'La vigencia del precio del gas de 25 lb terminó el {fin.isoformat()} (decreto de seis meses, prorrogable): '
                          'verificar la prórroga con Acodeco.')
    return False


def modulo_foto_costo(cv, hoy, avisar):
    """Cada semana se guarda una foto de todos los valores vigentes."""
    fotos = cv['series'].setdefault('fotos', [])
    foto = {'periodo': hoy.isoformat(), 'valores': {m['id']: m.get('valor') for m in cv.get('metricas', [])}}
    previa = next((f for f in fotos if f['periodo'] == foto['periodo']), None)
    if previa == foto:
        return False
    fotos.append(foto)
    cv['series']['fotos'] = dedup_series(fotos)
    return True


def _numero_comunicado(url):
    m = re.search(r'comunicado-oficial-(\d+)', url or '')
    return int(m.group(1)) if m else None


def modulo_sinaproc(sm, hoy, avisar):
    """Último balance de Sinaproc: prueba los comunicados numerados siguientes al conocido y los
    artículos recientes del feed que hablen de evaluaciones o afectados."""
    if sm.get('activo') is False:   # modo archivo histórico: no se revisa más
        return False
    fuente = sm.setdefault('fuentes', {}).setdefault('sinaproc', {})
    n0 = _numero_comunicado(fuente.get('url')) or 0
    candidatos = []
    fallos = 0
    # La numeración tiene huecos (existe el #29 pero no el #27 ni el #28): se toleran 4 seguidos.
    for n in range(n0 + 1, n0 + 25):
        url = SINAPROC_COMUNICADO.format(n=n)
        if existe(url):
            candidatos.append((f'Sinaproc, Comunicado #{n}', url))
            fallos = 0
        else:
            fallos += 1
            if fallos >= 4:
                break
    try:
        for it in leer_rss(http_get(FEED_SINAPROC)):
            if re.search(r'sismo|terremoto|afectad|evaluacion|albergue|balance', sin_tildes(it['titulo'])):
                candidatos.append((f'Sinaproc — {it["titulo"]}', it['url']))
    except Exception as e:  # noqa: BLE001
        avisar('sinaproc', f'Feed de Sinaproc no disponible ({e}).')
    balances = []
    for nombre, url in dict((u, (n, u)) for n, u in candidatos).values():
        try:
            r = parse_sinaproc_balance(html_a_texto(http_get(url)))
        except Exception:  # noqa: BLE001
            continue
        if not r or 'fecha_corte' not in r:
            continue
        try:
            validar_fecha(r['fecha_corte'], hoy, 'sinaproc')
        except ErrorValidacion as e:
            avisar('sinaproc', str(e))
            continue
        balances.append((r['fecha_corte'], r, nombre, url))
    if not candidatos:
        avisar('sinaproc', 'No se encontraron boletines; se conservan las cifras del último balance.')
    # Cada cifra toma el boletín más reciente que la trae: no todos los comunicados repiten todos los campos.
    cambio = False
    for corte_d, r, nombre, url in sorted(balances, key=lambda b: b[0]):
        corte = corte_d.isoformat()
        for k, v in r.items():
            m = metrica(sm, k)
            if k == 'fecha_corte' or not m or (m.get('fecha_corte') or '') >= corte:
                continue
            try:
                validar_numero(v, f'sinaproc {k}', (0, 5_000_000))
            except ErrorValidacion as e:
                avisar('sinaproc', str(e))
                continue
            m.update({'valor': v, 'fecha_corte': corte, 'fuente': nombre, 'url': url,
                      'periodo': f'2026-10-09/{corte}' if '/' in (m.get('periodo') or '') else corte})
            cambio = True
        if cambio and _numero_comunicado(url) and _numero_comunicado(url) > (_numero_comunicado(fuente.get('url')) or 0):
            fuente.update({'nombre': f'{nombre} (balance al {corte})', 'url': url})
    return cambio


def modulo_igc(sm, hoy, avisar):
    """Conteo de réplicas del IGC-UP, tomado de notas de prensa que lo citan."""
    if sm.get('activo') is False:
        return False
    serie = sm['series'].setdefault('replicas', [])
    ultimo = serie[-1] if serie else {'periodo': '0000', 'localizadas': 0}
    arts, errs = _articulos_prensa(r'replica|sismo|geociencias', desde=date.fromisoformat(ultimo['periodo'][:10]) + timedelta(days=1)
                                   if ultimo['periodo'] != '0000' else None)
    for err in errs:
        avisar('igc', f'Feed de prensa no disponible: {err}')
    nuevo = None
    for a in sorted(arts, key=lambda x: x['fecha'] or date.min, reverse=True):
        try:
            r = parse_replicas(html_a_texto(http_get(a['url'])))
        except Exception:  # noqa: BLE001
            continue
        if not r or not a['fecha']:
            continue
        try:
            validar_fecha(a['fecha'], hoy, 'igc')
            validar_numero(r['localizadas'], 'réplicas', (ultimo.get('localizadas') or 0, 100_000))
        except ErrorValidacion as e:
            avisar('igc', f'{e} ({a["url"]})')
            continue
        nuevo = {'periodo': a['fecha'].isoformat(), 'localizadas': r['localizadas'], 'aproximado': r['aproximado'],
                 'fuente': 'IGC-UP, vía prensa', 'url': a['url']}
        break
    if not nuevo:
        return False
    serie.append(nuevo)
    sm['series']['replicas'] = dedup_series(serie)
    m = metrica(sm, 'replicas_localizadas')
    if m:
        m.update({'valor': nuevo['localizadas'], 'fecha_corte': nuevo['periodo'], 'url': nuevo['url'],
                  'fuente': 'IGC-UP, vía prensa', 'calidad': 'media',
                  'notas': 'Cifra aproximada citada en la prensa.' if nuevo['aproximado'] else '',
                  'periodo': f'2026-10-09/{nuevo["periodo"]}'})
    return True


def modulo_encuestas(ap, hoy, avisar):
    """Busca mediciones nuevas de Vea Panamá. Si encuentra una completa (buena, mala y fechas de
    campo), agrega el punto; si solo ve una nota que parece encuesta, deja un aviso para revisar."""
    serie = ap['series'].setdefault('gestion', [])
    ultimo = max((r['periodo'] for r in serie), default='0000-00')
    arts, errs = _articulos_prensa(r'encuesta|vea panama|aprobacion|desaprobacion|latinobarometro|mulino')
    for err in errs:
        avisar('encuestas', f'Feed de prensa no disponible: {err}')
    cambio = False
    for a in arts:
        try:
            r = parse_vea(html_a_texto(http_get(a['url'])))
        except Exception:  # noqa: BLE001
            r = None
        if not r:
            if re.search(r'encuesta|latinobarometro', sin_tildes(a['titulo'])):
                avisar('encuestas', f'Posible medición nueva para revisar a mano: {a["titulo"]} — {a["url"]}')
            continue
        fin = r['campo'][1]
        periodo = f'{fin.year}-{fin.month:02d}'
        if periodo <= ultimo:
            continue
        try:
            validar_fecha(fin, hoy, 'encuesta')
            for k in ('buena', 'mala'):
                validar_numero(r[k], f'encuesta {k}', RANGOS['porcentaje'])
        except ErrorValidacion as e:
            avisar('encuestas', str(e))
            continue
        previo = serie[-1] if serie else {}
        serie.append({'periodo': periodo, 'buena': r['buena'], 'mala': r['mala'], 'fuente': 'vea', 'url': a['url']})
        campo = f'{r["campo"][0]}/{fin}'
        for mid, k in (('gestion_buena', 'buena'), ('gestion_mala', 'mala'), ('mal_camino', 'mal_camino')):
            m = metrica(ap, mid)
            if m and r.get(k) is not None:
                ant = previo.get(k)   # la serie solo guarda buena y mala: mal camino queda sin variación
                m.update({'valor': r[k], 'fecha_corte': fin.isoformat(), 'periodo': campo, 'url': a['url'],
                          'variacion': round(r[k] - ant, 1) if ant is not None else None,
                          'notas': f'n={r["n"]:,}' if r.get('n') else ''})
        ultimo = periodo
        cambio = True
    if cambio:
        ap['series']['gestion'] = dedup_series(serie)
    return cambio


# ── SALARIOS Y EMPLEO (INEC, Encuesta de Mercado Laboral) ───────────────────
INEC = 'https://www.inec.gob.pa'
INEC_LISTA_EML = INEC + '/publicaciones/Default2.aspx?ID_CATEGORIA=5&ID_SUBCATEGORIA=38'
INEC_PUB = INEC + '/publicaciones/Default3.aspx?ID_PUBLICACION={id}&ID_CATEGORIA=5&ID_SUBCATEGORIA=38'
# Subcategorías que el INEC desglosa dentro de una rama: no se muestran como sectores aparte
SUBRAMAS = ('articulos no durables', 'articulos durables', 'al por mayor', 'al por menor y reparacion')
PROVINCIAS_INEC = {'bocas del toro': 'Bocas del Toro', 'cocle': 'Coclé', 'colon': 'Colón', 'chiriqui': 'Chiriquí',
                   'darien': 'Darién', 'herrera': 'Herrera', 'los santos': 'Los Santos', 'panama': 'Panamá',
                   'panama oeste': 'Panamá Oeste', 'veraguas': 'Veraguas', 'comarca kuna yala': 'Comarca Guna Yala',
                   'comarca guna yala': 'Comarca Guna Yala', 'comarca gunayala': 'Comarca Guna Yala',
                   'comarca embera': 'Comarca Emberá', 'comarca ngabe bugle': 'Comarca Ngäbe Buglé',
                   'comarca ngobe bugle': 'Comarca Ngäbe Buglé'}


def _etiqueta_inec(s):
    """'Suministro de agua; alcantarilla-\\n  do,  gestión…' → 'Suministro de agua; alcantarillado, gestión…'"""
    s = re.sub(r'-\s*\n\s*', '', str(s or ''))
    return re.sub(r'\s+', ' ', s).strip()


def periodo_eml(texto):
    """'… ENCUESTA DE MERCADO LABORAL: AGOSTO 2026' → '2026-08'"""
    m = re.search(r'(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(\d{4})',
                  sin_tildes(texto or ''))
    return f'{m.group(2)}-{MESES[m.group(1)]:02d}' if m else None


def parse_mediana_inec(datos_xlsx):
    """Cuadro del INEC 'MEDIANA DE SALARIO MENSUAL … SEGÚN SEXO Y <dimensión>' (Excel).
    Las etiquetas largas ocupan varias filas: el texto se acumula hasta la fila que trae los números.
    → {'titulo', 'periodo',
       'grupos': {'Total'|'Hombres'|'Mujeres': {'mediana', 'empleados', 'filas': [{etiqueta, mediana, empleados}]}},
       'provincias': [{'provincia', 'Total'|'Hombres'|'Mujeres': {'mediana', 'empleados'}}]}   (cuadro por provincia)"""
    import openpyxl
    ws = openpyxl.load_workbook(io.BytesIO(datos_xlsx), data_only=True, read_only=True).worksheets[0]
    filas = [list(r) for r in ws.iter_rows(values_only=True)]
    titulo = ' '.join(_etiqueta_inec(c) for r in filas[:6] for c in r if isinstance(c, str))
    if 'MEDIANA DE SALARIO' not in titulo.upper():
        return None
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    grupos, provincias, sexo, prov, buffer = {}, [], None, None, []
    for r in filas[4:]:
        celdas = [c for c in r if c is not None and c != '']
        if not celdas:
            buffer = []
            continue
        if isinstance(celdas[0], str) and (len(celdas) < 3 or not num(celdas[1])):
            buffer.append(celdas[0])           # parte de una etiqueta de varias filas
            continue
        if not (isinstance(celdas[0], str) and len(celdas) >= 3 and num(celdas[1])):
            buffer = []
            continue
        etq = _etiqueta_inec('\n'.join(buffer + [celdas[0]]))   # con salto de línea: une "alcantarilla-\ndo"
        buffer = []
        med = round(float(celdas[1]), 2)
        emp = int(celdas[2]) if num(celdas[2]) else None
        clave = sin_tildes(etq).strip()
        if clave in PROVINCIAS_INEC:
            prov = {'provincia': PROVINCIAS_INEC[clave], 'Total': {'mediana': med, 'empleados': emp}}
            provincias.append(prov)
            sexo = 'Total'
            continue
        if clave in ('total', 'hombres', 'mujeres'):
            sexo = {'total': 'Total', 'hombres': 'Hombres', 'mujeres': 'Mujeres'}[clave]
            if prov is not None:
                prov[sexo] = {'mediana': med, 'empleados': emp}
            elif sexo not in grupos:
                grupos[sexo] = {'mediana': med, 'empleados': emp, 'filas': []}
            continue
        if prov is None and sexo in grupos and not clave.startswith(SUBRAMAS):
            grupos[sexo]['filas'].append({'etiqueta': etq, 'mediana': med, 'empleados': emp})
    if not grupos:
        return None
    return {'titulo': titulo, 'periodo': periodo_eml(titulo), 'grupos': grupos, 'provincias': provincias}


def parse_desempleo(texto):
    """Comentario del INEC: 'La tasa de desempleo nacional disminuyó 1.9 puntos … pasando de 10.4% a 8.5%'
    → {'tasa': 8.5, 'anterior': 10.4, 'jovenes_20_24': 22.6}"""
    t = re.sub(r'\s+', ' ', texto or '')
    m = re.search(r'tasa de desempleo nacional.{0,120}?pasando de (\d{1,2}[.,]\d)\s?% a (\d{1,2}[.,]\d)\s?%', t, re.I)
    if not m:
        return None
    r = {'anterior': a_decimal(m.group(1)), 'tasa': a_decimal(m.group(2))}
    j = re.search(r'20 a 24 años presentó una tasa de desocupación de (\d{1,2}[.,]\d)\s?%', t, re.I)
    if j:
        r['jovenes_20_24'] = a_decimal(j.group(1))
    return r


def parse_informalidad_csv(texto):
    """Cuadro 'EMPLEO INFORMAL EN LA REPÚBLICA … SEGÚN AÑO' (CSV con ';') → [(año, %)]"""
    salida = []
    for linea in (texto or '').splitlines():
        partes = [p.strip() for p in linea.split(';')]
        m = re.match(r'(\d{4})', partes[0]) if partes else None
        if m and len(partes) >= 6 and re.match(r'^\d{1,2}([.,]\d)?$', partes[-1]):
            salida.append((int(m.group(1)), a_decimal(partes[-1])))
    return salida


def _publicaciones_eml(html):
    """Lista de publicaciones del INEC → [(id, titulo)] de boletines de la Encuesta de Mercado Laboral y de
    Situación de la población ocupada, en el orden de la página (más reciente primero)."""
    salida = []
    for pid, tit in re.findall(r'ID_PUBLICACION=(\d+)[^"]*"[^>]*>([^<]+)<', html or ''):
        tit = html_lib.unescape(tit).strip()
        if re.search(r'Encuesta (de )?Mercado Laboral|Situaci[oó]n de la [Pp]oblaci[oó]n [Oo]cupada', tit) and 'Confiabilidad' not in tit:
            salida.append((int(pid), tit))
    return salida


def _archivos_publicacion(html):
    """Filas de una publicación del INEC → [(titulo_cuadro, {ext: url})]"""
    salida = []
    for fila in re.findall(r'<tr.*?</tr>', re.sub(r'\s+', ' ', html or ''), re.I):
        links = re.findall(r'href="([^"]*archivos[^"]+)"', fila)
        if not links:
            continue
        texto = re.sub(r'\s+', ' ', html_lib.unescape(re.sub(r'<[^>]+>', ' ', fila))).strip()
        urls = {}
        for l in links:
            l = html_lib.unescape(l).replace('../', '')
            url = l if l.startswith('http') else f'{INEC}/{l.lstrip("/")}'
            urls[url.rsplit('.', 1)[-1].lower()] = url.replace(' ', '%20')
        salida.append((texto, urls))
    return salida


def modulo_salarios(sa, hoy, avisar):
    """Medianas salariales y empleo de la última Encuesta de Mercado Laboral del INEC. Cada cuadro se busca
    por su título (la numeración cambia entre boletines) y se lee del Excel oficial."""
    series = sa.setdefault('series', {})
    cambio = False
    pubs = _publicaciones_eml(http_get(INEC_LISTA_EML))
    if not pubs:
        avisar('salarios', 'No se pudo leer la lista de publicaciones del INEC.')
        return False
    hechos = set()   # dimensiones ya actualizadas en esta corrida (se toma la publicación más reciente de cada una)
    for pid, titulo in pubs[:6]:
        if {'sector', 'ocupacion', 'provincia', 'desempleo', 'informalidad'} <= hechos:
            break
        try:
            archivos = _archivos_publicacion(http_get(INEC_PUB.format(id=pid)))
        except Exception as e:  # noqa: BLE001
            avisar('salarios', f'No se pudo abrir «{titulo}» ({e}).')
            continue
        url_pub = INEC_PUB.format(id=pid)
        for texto, urls in archivos:
            T = sin_tildes(texto)
            dim = ('provincia' if 'provincia' in T else 'sector' if 'categoria en la actividad' in T else
                   'ocupacion' if 'ocupacion' in T else None) if 'mediana de salario' in T else None
            try:
                if dim and dim not in hechos and 'xlsx' in urls:
                    r = parse_mediana_inec(http_get(urls['xlsx'], binario=True))
                    if not r or not r['periodo']:
                        raise ErrorValidacion(f'cuadro sin datos legibles: {texto[:80]}')
                    validar_fecha(r['periodo'] + '-01', hoy, 'salarios')
                    for g in r['grupos'].values():
                        validar_numero(g['mediana'], 'mediana salarial', (100, 5000))
                    if dim == 'provincia' and not r['provincias']:
                        raise ErrorValidacion(f'el cuadro por provincia no trae provincias: {texto[:80]}')
                    registro = {'periodo': r['periodo'], 'fuente': titulo, 'url': url_pub, 'cuadro': urls['xlsx']}
                    if dim == 'provincia':
                        registro['nacional'] = {k: {'mediana': v['mediana'], 'empleados': v['empleados']} for k, v in r['grupos'].items()}
                        registro['provincias'] = r['provincias']
                    else:
                        registro['grupos'] = r['grupos']
                    serie = series.setdefault(dim, [])
                    if not any(x['periodo'] == registro['periodo'] and x == registro for x in serie):
                        series[dim] = dedup_series(serie + [registro])
                        cambio = True
                    hechos.add(dim)
                    if dim == 'sector':   # la mediana nacional sale del mismo cuadro
                        tot = r['grupos'].get('Total', {})
                        hist = series.setdefault('mediana_historica', [])
                        if tot.get('mediana') and not any(h['periodo'] == r['periodo'] for h in hist):
                            series['mediana_historica'] = dedup_series(hist + [{'periodo': r['periodo'], 'valor': tot['mediana'], 'url': url_pub}])
                            cambio = True
                elif 'empleo informal' in T and 'informalidad' not in hechos and 'csv' in urls:
                    b = http_get(urls['csv'], binario=True)
                    pares = parse_informalidad_csv(b.decode('utf-8-sig', errors='replace'))
                    if pares:
                        nueva = [{'periodo': str(a), 'valor': v} for a, v in pares if a >= 2015]
                        if series.get('informalidad') != nueva:
                            series['informalidad'] = nueva
                            cambio = True
                        hechos.add('informalidad')
                elif T.startswith('comentario') and 'desempleo' not in hechos and 'mercado laboral' in sin_tildes(titulo) and 'pdf' in urls:
                    d = parse_desempleo(pdf_a_texto(http_get(urls['pdf'], binario=True)))
                    per = periodo_eml(titulo)
                    if d and per:
                        validar_numero(d['tasa'], 'desempleo', RANGOS['porcentaje'])
                        reg = {'periodo': per, 'tasa': d['tasa'], 'anterior': d['anterior'], 'jovenes_20_24': d.get('jovenes_20_24'), 'url': urls['pdf']}
                        serie = series.setdefault('desempleo', [])
                        if reg not in serie:
                            series['desempleo'] = dedup_series(serie + [reg])
                            cambio = True
                        hechos.add('desempleo')
            except Exception as e:  # noqa: BLE001
                avisar('salarios', f'{titulo}: {e}')
    faltan = {'sector', 'ocupacion', 'provincia', 'desempleo', 'informalidad'} - hechos
    if faltan:
        avisar('salarios', 'No se encontraron en las publicaciones recientes del INEC: ' + ', '.join(sorted(faltan)) + '. Se conservan los datos anteriores.')
    if cambio:
        _actualizar_kpis_salarios(sa)
    return cambio


def _actualizar_kpis_salarios(sa):
    s = sa['series']
    fin = lambda p: (date(int(p[:4]) + (p[5:7] == '12'), int(p[5:7]) % 12 + 1, 1) - timedelta(days=1)).isoformat()
    hist = s.get('mediana_historica') or []
    if hist and metrica(sa, 'mediana_salario'):
        u, a = hist[-1], (hist[-2] if len(hist) > 1 else None)
        metrica(sa, 'mediana_salario').update({'valor': u['valor'], 'fecha_corte': fin(u['periodo']), 'periodo': u['periodo'],
                                               'url': u.get('url'), 'variacion': round(u['valor'] - a['valor'], 2) if a else None})
    des = (s.get('desempleo') or [])[-1:]
    if des:
        d = des[0]
        for mid, k, var in (('desempleo', 'tasa', True), ('desempleo_jovenes', 'jovenes_20_24', False)):
            m = metrica(sa, mid)
            if m and d.get(k) is not None:
                m.update({'valor': d[k], 'fecha_corte': fin(d['periodo']), 'periodo': d['periodo'], 'url': d['url'],
                          'variacion': round(d['tasa'] - d['anterior'], 1) if var and d.get('anterior') is not None else None})
    inf = s.get('informalidad') or []
    if inf and metrica(sa, 'informalidad'):
        u, a = inf[-1], (inf[-2] if len(inf) > 1 else None)
        mes = (s.get('desempleo') or [{}])[-1].get('periodo', '')
        corte = fin(mes) if mes.startswith(u['periodo']) else f"{u['periodo']}-12-31"
        metrica(sa, 'informalidad').update({'valor': u['valor'], 'fecha_corte': corte, 'periodo': u['periodo'],
                                            'variacion': round(u['valor'] - a['valor'], 1) if a else None})


# ── EDUCACIÓN (Censo 2023, MEDUCA, INEC) ─────────────────────────────────────
INEC_LISTA_EDU = INEC + '/publicaciones/Default2.aspx?ID_CATEGORIA=6&ID_SUBCATEGORIA=41'
INEC_PUB_EDU = INEC + '/publicaciones/Default3.aspx?ID_PUBLICACION={id}&ID_CATEGORIA=6&ID_SUBCATEGORIA=41'
INEC_PUB_CENSO_EDU = INEC + '/publicaciones/Default3.aspx?ID_PUBLICACION=1212&ID_CATEGORIA=19&ID_SUBCATEGORIA=71'
MEDUCA_ESTADISTICAS = 'https://www.meduca.gob.pa/transparencia/estadisticas/'
NIVELES_MEDUCA = {'2-12': 'primaria', '3-12': 'premedia', '4-12': 'media'}
# Columnas del cuadro 20 del Censo 2023 (población de 4 y más años por nivel de instrucción)
COLS_INSTRUCCION = ['total', 'sin_grado', 'preescolar', 'primaria', 'secundaria', 'universitaria', 'postgrado', 'maestria',
                    'doctorado', 'superior_no_univ', 'vocacional', 'especial', 'no_declarado', 'promedio_anios']


def filas_excel(datos):
    """Filas de la primera hoja de un Excel .xlsx (openpyxl) o .xls antiguo (xlrd), como listas de valores."""
    if datos[:4] == b'PK\x03\x04':
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(datos), data_only=True, read_only=True).worksheets[0]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    import xlrd
    sh = xlrd.open_workbook(file_contents=datos).sheet_by_index(0)
    return [sh.row_values(i) for i in range(sh.nrows)]


def _num(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str) and re.fullmatch(r'-?\d+(\.\d+)?', v.strip()):
        return float(v)
    return None


def _prov_censo(texto):
    c = sin_tildes(_etiqueta_inec(texto)).replace('hererra', 'herrera')
    c = re.sub(r'\s*\(\d+\)$', '', c).strip()
    return PROVINCIAS_INEC.get(c)


def parse_censo_analfabetismo(datos_c12, datos_c14, datos_c19):
    """Censo 2023 → {'nacional': {Total|Hombres|Mujeres: {tasa, analfabetas, poblacion}},
                      'historico': [{anio, tasa}], 'provincias': [{provincia, Total|Hombres|Mujeres: {tasa, analfabetas}, '2000','2010'}]}"""
    nac, hist = {}, []
    for r in filas_excel(datos_c12):
        etq = next((str(c).strip() for c in r if isinstance(c, str) and c.strip()), '')
        nums = [_num(c) for c in r if _num(c) is not None]
        if etq.upper() in ('TOTAL', 'HOMBRES', 'MUJERES') and len(nums) >= 8:
            sexo = etq.capitalize() if etq.upper() != 'TOTAL' else 'Total'
            nac[sexo] = {'poblacion': int(nums[4]), 'analfabetas': int(nums[6]), 'tasa': round(nums[7], 2)}
            if sexo == 'Total':
                hist.append({'anio': 2010, 'tasa': round(nums[3], 1)})
    provs = {}
    for r in filas_excel(datos_c14):
        etq = next((c for c in r if isinstance(c, str) and c.strip()), '')
        nums = [_num(c) for c in r[1:]]
        if etq.strip().upper() == 'TOTAL' and len(nums) >= 6 and nums[1] is not None:
            hist.insert(0, {'anio': 2000, 'tasa': round(nums[1], 1)})
            hist.append({'anio': 2023, 'tasa': round(nums[5], 2)})
        p = _prov_censo(etq) if etq else None
        if p and len(nums) >= 6 and nums[5] is not None:
            provs[p] = {'provincia': p, 'Total': {'analfabetas': int(nums[4]), 'tasa': round(nums[5], 2)},
                        '2000': round(nums[1], 1) if nums[1] is not None else None, '2010': round(nums[3], 1) if nums[3] is not None else None}
    vistos = set()
    for r in filas_excel(datos_c19):   # la primera aparición de cada nombre es la fila de la provincia (después vienen distritos)
        etq = r[0] if r and isinstance(r[0], str) else ''
        p = _prov_censo(etq) if etq else None
        nums = [n for n in (_num(c) if str(c).strip() != '-' else 0.0 for c in r[1:]) if n is not None]   # se saltan celdas vacías
        if not p or p in vistos or len(nums) < 7:
            continue
        vistos.add(p)
        _tot, _alf, alf_h, alf_m, _an, an_h, an_m = nums[:7]
        if p in provs:
            provs[p]['Hombres'] = {'analfabetas': int(an_h), 'tasa': round(an_h / (alf_h + an_h) * 100, 2) if alf_h + an_h else None}
            provs[p]['Mujeres'] = {'analfabetas': int(an_m), 'tasa': round(an_m / (alf_m + an_m) * 100, 2) if alf_m + an_m else None}
    if not nac or not provs:
        return None
    return {'nacional': nac, 'historico': sorted(hist, key=lambda h: h['anio']), 'provincias': list(provs.values())}


def parse_censo_instruccion(datos_c20, edad_min=25):
    """Censo 2023, cuadro 20 → nivel de instrucción de la población de 25 y más años (estándar internacional para el
    nivel alcanzado) y promedio de años aprobados (4 y más años), para el país y cada provincia, por sexo."""
    salida, actual, sexo = {}, None, None
    for r in filas_excel(datos_c20):
        textos = [str(c).strip() for c in r[1:4] if isinstance(c, str) and str(c).strip()]
        etq = textos[0] if textos else ''
        vals = [_num(c) if _num(c) is not None else (0.0 if str(c).strip() == '-' else None) for c in r[4:18]]
        if not etq or vals[0] is None:
            continue
        clave = sin_tildes(etq)
        p = _prov_censo(etq)
        if clave == 'total':
            actual, sexo = 'República', 'Total'
        elif p:
            actual, sexo = p, 'Total'
        elif clave in ('hombres', 'mujeres'):
            sexo = clave.capitalize()
        elif actual:
            m = re.match(r'(\d+)\s*-\s*\d+|(\d+) y mas', clave)
            if m and int(m.group(1) or m.group(2)) >= edad_min:
                acc = salida.setdefault(actual, {}).setdefault(sexo, {'_suma': [0.0] * 13})
                acc['_suma'] = [a + (v or 0) for a, v in zip(acc['_suma'], vals[:13])]
            continue
        else:
            continue
        reg = salida.setdefault(actual, {}).setdefault(sexo, {'_suma': [0.0] * 13})
        if vals[13] is not None:
            reg['promedio_anios'] = round(vals[13], 2)
    res = {}
    for lugar, sexos in salida.items():
        res[lugar] = {}
        for sx, d in sexos.items():
            s = dict(zip(COLS_INSTRUCCION[:13], d['_suma']))
            base = s['total'] - s['no_declarado']
            if base <= 0:
                continue
            pct = lambda *ks: round(sum(s[k] for k in ks) / base * 100, 2)
            res[lugar][sx] = {
                'poblacion_25': int(s['total']), 'promedio_anios': d.get('promedio_anios'),
                'sin_grado': pct('sin_grado', 'preescolar', 'especial'), 'primaria': pct('primaria'), 'secundaria': pct('secundaria'),
                'tecnica': pct('superior_no_univ', 'vocacional'), 'universitaria': pct('universitaria', 'postgrado', 'maestria', 'doctorado'),
                'posgrado': pct('postgrado', 'maestria', 'doctorado')}
    return res or None


def parse_meduca_tasas(texto):
    """Cuadro de MEDUCA 'Tasa de aprobados, (aplazados,) reprobados y desertores … en la República, por sexo, según área y
    región educativa'. Cada fila: región, matrícula (total, H, M), 100.00 y tasas (subtotal, H, M) de cada condición;
    las tres últimas son los desertores.  → [{region, matricula, aprobados, reprobados, desertores: {Total, Hombres, Mujeres}}]"""
    filas = []
    for linea in (texto or '').splitlines():
        m = re.match(r'^\s*([^\W\d_][^\d]*?)\s+([\d,].*)$', linea)   # la región puede llevar tildes o diéresis (Ngäbe-Buglé)
        if not m:
            continue
        toks = m.group(2).split()
        nums = []
        for t in toks:
            if t == '-':
                nums.append(0.0)
            elif re.fullmatch(r'\d{1,3}(,\d{3})+|\d+(\.\d+)?', t):
                nums.append(float(t.replace(',', '')))
            else:
                nums = []
                break
        if len(nums) < 13 or abs(nums[3] - 100) > 0.01:
            continue
        filas.append({'region': m.group(1).strip(), 'matricula': int(nums[0]), 'aprobados': nums[4], 'reprobados': nums[-6],
                      'desertores': {'Total': nums[-3], 'Hombres': nums[-2], 'Mujeres': nums[-1]}})
    return filas


def parse_inec_sector_estudio(datos_xlsx):
    """INEC Educación, cuadro de matrícula o graduados universitarios 'por sexo, según sector de estudio y dependencia':
    filas del bloque TOTAL (antes de 'Oficial') → {'total': {..}, 'sectores': [{sector, total, hombres, mujeres}]}"""
    filas, total, buffer = [], None, []
    for r in filas_excel(datos_xlsx)[4:]:
        celdas = [c for c in r if c not in (None, '')]
        if not celdas:
            buffer = []
            continue
        if isinstance(celdas[0], str) and (len(celdas) < 4 or _num(celdas[1]) is None):
            buffer.append(celdas[0])
            continue
        if not (isinstance(celdas[0], str) and len(celdas) >= 5):
            continue
        etq = _etiqueta_inec('\n'.join(buffer + [celdas[0]]))
        buffer = []
        clave = sin_tildes(etq)
        if clave.startswith(('oficial', 'particular')):
            break
        t, h, m = _num(celdas[1]), _num(celdas[3]), _num(celdas[4])
        if t is None:
            continue
        reg = {'sector': etq, 'total': int(t), 'hombres': int(h or 0), 'mujeres': int(m or 0)}
        if clave == 'total':
            total = reg
        else:
            filas.append(reg)
    return {'total': total, 'sectores': filas} if total and filas else None


def parse_inec_costo_alumno(datos_xlsx):
    """INEC Educación, 'Gastos … y costo por alumno … según nivel de educación' → (año, {nivel: costo})"""
    filas = filas_excel(datos_xlsx)
    anios = next(([str(c).strip() for c in r if c not in (None, '')] for r in filas[:8]
                  if sum(bool(re.match(r'\d{4}', str(c).strip())) for c in r if c not in (None, '')) >= 3), [])
    nivel, res = 'Total', {}
    for r in filas:
        celdas = [c for c in r if c not in (None, '')]
        if not celdas or not isinstance(celdas[0], str):
            continue
        etq = celdas[0].strip()
        if etq.endswith(':'):
            nivel = etq.rstrip(':').strip()
        elif etq.upper() == 'TOTAL':
            nivel = 'Total'
        elif etq.lower().startswith('costo por alumno') and _num(celdas[-1]) is not None:
            res[nivel] = round(_num(celdas[-1]), 2)
    anio = re.match(r'\d{4}', anios[-1]).group(0) if anios else None
    return (anio, res) if res and anio else None


def _enlaces(html):
    return [(re.sub(r'\s+', ' ', html_lib.unescape(re.sub(r'<[^>]+>', ' ', t))).strip(), html_lib.unescape(u))
            for u, t in re.findall(r'href="([^"]+)"[^>]*>(.*?)</a>', html or '', re.S)]


def modulo_educacion(ed, hoy, avisar):
    """Educación: Censo 2023 (una vez), tasas de MEDUCA por nivel (último año publicado) y educación universitaria y
    costo por alumno del último anuario de Educación del INEC."""
    s = ed.setdefault('series', {})
    cambio = False
    # 1) Censo 2023: estático hasta el próximo censo; solo se carga si falta
    if not ed.get('censo'):
        try:
            arch = {}
            for texto, urls in _archivos_publicacion(http_get(INEC_PUB_CENSO_EDU)):
                n = re.match(r'(\d+)\s', texto)
                if n and n.group(1) in ('12', '14', '19', '20'):
                    arch[n.group(1)] = (urls.get('xlsx') or urls.get('xls'), texto)
            datos = {k: http_get(u, binario=True) for k, (u, _) in arch.items()}
            alf = parse_censo_analfabetismo(datos['12'], datos['14'], datos['19'])
            ins = parse_censo_instruccion(datos['20'])
            if not alf or not ins:
                raise ErrorValidacion('no se pudieron leer los cuadros de alfabetismo o instrucción del Censo 2023')
            validar_numero(alf['nacional']['Total']['tasa'], 'analfabetismo', (0, 50))
            ed['censo'] = {'fecha_corte': '2023-09-30', 'url': INEC_PUB_CENSO_EDU,
                           'cuadros': {k: {'titulo': t, 'url': u} for k, (u, t) in arch.items()},
                           'analfabetismo': alf, 'instruccion': ins}
            cambio = True
        except Exception as e:  # noqa: BLE001
            avisar('educacion', f'Censo 2023: {e}')
    # 2) MEDUCA: tasas de deserción por nivel (cuadros 2-12, 3-12 y 4-12, el año más reciente publicado)
    try:
        cands = {}
        for texto, url in _enlaces(http_get(MEDUCA_ESTADISTICAS)):
            m = re.search(r'[_-]((?:2|3|4)-12)[_-](?:primaria|premedia|media)[_-](\d{4})\.pdf$', url, re.I)
            if m and 'republica' in sin_tildes(texto) or (m and 'Rep' in texto):
                nivel, anio = NIVELES_MEDUCA[m.group(1)], int(m.group(2))
                if anio > cands.get(nivel, (0,))[0]:
                    cands[nivel] = (anio, url, texto)
        for nivel, (anio, url, texto) in cands.items():
            serie = s.setdefault('desercion_' + nivel, [])
            if any(x['periodo'] == str(anio) for x in serie):
                continue
            filas = parse_meduca_tasas(pdf_a_texto(http_get(url, binario=True)))
            tot = next((f for f in filas if f['region'].lower() == 'total'), None)
            if not tot:
                avisar('educacion', f'MEDUCA {nivel} {anio}: el cuadro no trae la fila Total.')
                continue
            validar_numero(tot['desertores']['Total'], f'deserción {nivel}', (0, 50))
            s['desercion_' + nivel] = dedup_series(serie + [{'periodo': str(anio), 'titulo': texto, 'url': url,
                                                             'nacional': tot, 'regiones': [f for f in filas if f is not tot]}])
            cambio = True
        if len(cands) < 3:
            avisar('educacion', 'MEDUCA: faltan cuadros de tasas por nivel (' + ', '.join(sorted(set(NIVELES_MEDUCA.values()) - set(cands))) + ').')
    except Exception as e:  # noqa: BLE001
        avisar('educacion', f'MEDUCA: {e}')
    # 3) INEC, anuario de Educación más reciente: universidad por sector de estudio y costo por alumno
    try:
        pubs = [(int(pid), html_lib.unescape(t).strip()) for pid, t in re.findall(r'ID_PUBLICACION=(\d+)[^"]*"[^>]*>([^<]+)<', http_get(INEC_LISTA_EDU))
                if re.match(r'Educaci[oó]n: a[ñn]o \d{4}', html_lib.unescape(t).strip())]
        pid, titulo = pubs[0]
        anio = re.search(r'\d{4}', titulo).group(0)
        if not any(x.get('periodo') == anio for x in s.get('universidad', [])):
            reg = {'periodo': anio, 'titulo': titulo, 'url': INEC_PUB_EDU.format(id=pid)}
            for texto, urls in _archivos_publicacion(http_get(INEC_PUB_EDU.format(id=pid))):
                T = sin_tildes(texto)
                if 'xlsx' not in urls:
                    continue
                if 'educacion universitaria' in T and 'sector de estudio' in T and T.split(' ', 2)[1].startswith(('matricula', 'graduados')):
                    clave = 'matricula' if 'matricula' in T.split(' ', 3)[1] else 'graduados'
                    r = parse_inec_sector_estudio(http_get(urls['xlsx'], binario=True))
                    if r:
                        reg[clave] = r
                        reg[clave + '_cuadro'] = urls['xlsx']
                elif 'costo por alumno' in T:
                    r = parse_inec_costo_alumno(http_get(urls['xlsx'], binario=True))
                    if r:
                        reg['costo_alumno'] = {'anio': r[0], 'niveles': r[1], 'cuadro': urls['xlsx']}
            if 'matricula' in reg:
                s['universidad'] = dedup_series(s.get('universidad', []) + [reg])
                cambio = True
            else:
                avisar('educacion', f'INEC «{titulo}»: no se encontró la matrícula universitaria por sector de estudio.')
    except Exception as e:  # noqa: BLE001
        avisar('educacion', f'INEC Educación: {e}')
    if cambio:
        _actualizar_kpis_educacion(ed)
    return cambio


def _actualizar_kpis_educacion(ed):
    c, s = ed.get('censo') or {}, ed.get('series') or {}
    alf = (c.get('analfabetismo') or {}).get('nacional', {})
    ins = (c.get('instruccion') or {}).get('República', {})
    def poner(mid, valor, fecha, periodo, url, variacion=None):
        m = metrica(ed, mid)
        if m and valor is not None:
            m.update({'valor': valor, 'fecha_corte': fecha, 'periodo': periodo, 'url': url, 'variacion': variacion})
    hist = (c.get('analfabetismo') or {}).get('historico', [])
    prev = next((h['tasa'] for h in hist if h['anio'] == 2010), None)
    if alf.get('Total'):
        poner('analfabetismo', alf['Total']['tasa'], c['fecha_corte'], '2023', c['url'],
              round(alf['Total']['tasa'] - prev, 2) if prev is not None else None)
    if ins.get('Total'):
        poner('universitaria_25', ins['Total']['universitaria'], c['fecha_corte'], '2023', c['url'])
        poner('promedio_anios', ins['Total']['promedio_anios'], c['fecha_corte'], '2023', c['url'])
    for nivel in ('primaria', 'premedia', 'media'):
        serie = s.get('desercion_' + nivel) or []
        if serie:
            u, a = serie[-1], (serie[-2] if len(serie) > 1 else None)
            v = u['nacional']['desertores']['Total']
            poner('desercion_' + nivel, v, f"{u['periodo']}-12-31", u['periodo'], u['url'],
                  round(v - a['nacional']['desertores']['Total'], 2) if a else None)
    uni = (s.get('universidad') or [])[-1:]
    if uni and uni[0].get('costo_alumno'):
        ca = uni[0]['costo_alumno']
        poner('costo_alumno', ca['niveles'].get('Total'), f"{ca['anio']}-12-31", ca['anio'], ca['cuadro'])


_PATRON_MINERO = re.compile(r'\bmina\b|\bminas\b|miner[ia]|minero|cobre panama|first quantum|donoso|recursos minerales|moratoria minera')
_PATRON_NO_MINERO = re.compile(r'\bminas? antipersonal|mina de sal|minas? de oro de|minsa\b')


def es_noticia_minera(titulo):
    """¿El titular trata de minería en Panamá? (filtro simple sobre el texto sin tildes)"""
    t = sin_tildes(titulo)
    return bool(_PATRON_MINERO.search(t)) and not _PATRON_NO_MINERO.search(t)


def modulo_noticias_mineria(mi, hoy, avisar):
    """Guarda los titulares sobre minería de los RSS de prensa (enlace y fecha), sin interpretar cifras.
    Las encuestas nuevas se avisan para revisarlas a mano antes de cargarlas."""
    previas = mi['series'].setdefault('noticias', [])
    conocidas = {n['url'] for n in previas}
    arts, errs = _articulos_prensa(r'.', desde=hoy - timedelta(days=21), hasta=hoy)
    for err in errs:
        avisar('noticias', f'Feed de prensa no disponible: {err}')
    nuevas = []
    for a in arts:
        if not es_noticia_minera(a['titulo']) or a['url'] in conocidas or not a['fecha']:
            continue
        medio = re.sub(r'^www\.', '', re.sub(r'^https?://([^/]+).*', r'\1', a['url']))
        nuevas.append({'periodo': a['fecha'].isoformat(), 'titulo': a['titulo'], 'url': a['url'], 'medio': medio})
        conocidas.add(a['url'])
        if re.search(r'encuesta|sondeo|referend', sin_tildes(a['titulo'])):
            avisar('encuestas', f'Posible encuesta sobre minería para revisar a mano: {a["titulo"]} — {a["url"]}')
    if not nuevas:
        return False
    # Las más recientes primero; se conservan las últimas 40 para que el archivo no crezca sin límite.
    mi['series']['noticias'] = sorted(previas + nuevas, key=lambda n: (n['periodo'], n['url']), reverse=True)[:40]
    return True


MODULOS = [
    ('combustible', 'costo_vida', modulo_combustible),
    ('cbfa', 'costo_vida', modulo_cbfa),
    ('pendientes', 'costo_vida', modulo_pendientes),
    ('sinaproc', 'sismo', modulo_sinaproc),
    ('igc', 'sismo', modulo_igc),
    ('encuestas', 'aprobacion', modulo_encuestas),
    ('noticias_mineria', 'mineria', modulo_noticias_mineria),
    ('salarios', 'salarios', modulo_salarios),
    ('educacion', 'educacion', modulo_educacion),
    ('foto', 'costo_vida', modulo_foto_costo),   # al final: la foto lleva los valores ya actualizados
]


# ── PRINCIPAL ────────────────────────────────────────────────────────────────

def _sin_generado(D):
    return json.dumps({k: v for k, v in D.items() if k != 'generado'}, ensure_ascii=False, sort_keys=True)


def ejecutar(hoy, solo=None, data_dir=DATA):
    datos = {k: json.loads((data_dir / f).read_text(encoding='utf-8')) for k, f in ARCHIVOS.items()}
    originales = {k: _sin_generado(v) for k, v in datos.items()}
    advertencias = {k: [] for k in datos}

    for nombre, pestana, fn in MODULOS:
        if solo and nombre not in solo:
            continue
        def avisar(modulo, mensaje, _p=pestana):
            advertencias[_p].append({'fecha': hoy.isoformat(), 'modulo': modulo, 'mensaje': mensaje})
            print(f'  ⚠ [{modulo}] {mensaje}')
        try:
            cambio = fn(datos[pestana], hoy, avisar)
            print(f'  {"✓" if cambio else "·"} {nombre}: {"datos nuevos" if cambio else "sin cambios"}')
        except Exception as e:  # noqa: BLE001 — un módulo caído no rompe el job
            avisar(nombre, f'El módulo falló y se conservaron los valores anteriores: {type(e).__name__}: {e}')

    escritos = []
    for k, D in datos.items():
        if solo and not any(p == k and n in solo for n, p, _ in MODULOS):
            continue
        D['advertencias'] = advertencias[k]
        for nombre_serie, serie in list((D.get('series') or {}).items()):
            if isinstance(serie, list) and serie and isinstance(serie[0], dict) and 'periodo' in serie[0] and nombre_serie not in ('cronologia', 'noticias', 'encuestas', 'referendo'):
                D['series'][nombre_serie] = dedup_series(serie)
        D['fecha_corte'] = fecha_mayor(D) or D.get('fecha_corte')
        if _sin_generado(D) != originales[k]:
            D['generado'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            (data_dir / ARCHIVOS[k]).write_text(json.dumps(D, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            escritos.append(ARCHIVOS[k])
    return escritos


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--hoy', help='fecha de referencia AAAA-MM-DD (por defecto, hoy en Panamá)')
    ap.add_argument('--solo', help='módulos separados por coma: ' + ','.join(n for n, _, _ in MODULOS))
    a = ap.parse_args(argv)
    hoy = date.fromisoformat(a.hoy) if a.hoy else (datetime.now(timezone.utc) - timedelta(hours=5)).date()
    solo = set(a.solo.split(',')) if a.solo else None
    print(f'Actualizando indicadores al {hoy.isoformat()}…')
    escritos = ejecutar(hoy, solo)
    print('Archivos actualizados: ' + (', '.join(escritos) if escritos else 'ninguno'))
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
