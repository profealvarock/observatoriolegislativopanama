"""
Observatorio Legislativo — actualización semanal de las pestañas Aprobación, Sismo y Costo de vida.

Lee y actualiza data/aprobacion.json, data/sismo.json y data/costo_vida.json. Hay un módulo por
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
ARCHIVOS = {'aprobacion': 'aprobacion.json', 'sismo': 'sismo.json', 'costo_vida': 'costo_vida.json'}

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

def http_get(url, binario=False):
    import requests
    r = requests.get(url, headers={'User-Agent': UA, 'Accept-Language': 'es-PA,es;q=0.9'}, timeout=TIMEOUT)
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


MODULOS = [
    ('combustible', 'costo_vida', modulo_combustible),
    ('cbfa', 'costo_vida', modulo_cbfa),
    ('pendientes', 'costo_vida', modulo_pendientes),
    ('sinaproc', 'sismo', modulo_sinaproc),
    ('igc', 'sismo', modulo_igc),
    ('encuestas', 'aprobacion', modulo_encuestas),
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
            if isinstance(serie, list) and serie and isinstance(serie[0], dict) and 'periodo' in serie[0] and nombre_serie != 'cronologia':
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
