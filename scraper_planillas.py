"""
=============================================================
 SCRAPER SEMANAL DE PLANILLAS — Contraloría General de la República
 Observatorio Legislativo · Asamblea Nacional de Panamá

 Lee el portal "Consulta de Pagos de Planillas y Donaciones de la Asamblea Nacional"
 (https://www.contraloria.gob.pa/CGR.consultapagos/) y guarda, por diputado, el total pagado
 en su planilla: personas, número de pagos y monto, por tipo de planilla y por año.

 Sirve para VALIDAR la planilla de Espacio Cívico (que sigue siendo la base del costo
 legislativo). Solo se guardan totales por diputado: nunca nombres ni cédulas de funcionarios.

 Cada semana primero revisa la fecha de corte que publica la Contraloría ("Registros
 actualizados hasta"); solo si cambió hace la extracción completa (~130 consultas con pausas).

 EJECUCIÓN:
    python scraper_planillas.py            # revisa el corte y extrae solo si cambió
    python scraper_planillas.py --forzar   # extracción completa aunque el corte no cambie
=============================================================
"""
import html, json, re, sys, time, unicodedata
from collections import defaultdict
from datetime import datetime, timezone

import requests

URL = 'https://www.contraloria.gob.pa/CGR.consultapagos/'
SALIDA = 'planillas_cgr.json'
RESUMEN = 'resumen.json'
PERIODO = '3'          # valor del periodo 2024-2029 en el portal
PAUSA = 1.0            # segundos entre consultas, para no saturar el portal
REINTENTOS = 3
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

TIPOS = {'001': 'Personal fijo', '002': 'Personal transitorio por diputado', '004': 'Personal transitorio de inversión',
         '050': 'Décimo tercer mes', '080': 'Otros servicios personales', '172': 'Servicios profesionales'}

# Nombres de la Contraloría → slug del observatorio. La Contraloría usa a menudo el apellido de
# casada y tiene errores de tipeo. "verificado": coincide con el nombre completo con que la
# diputada firma proyectos en la Asamblea; "probable": única diputada con ese nombre de pila.
ALIAS_CGR = {
    'PASTSY DE HUANG': ('patsy-lee-renteria', 'verificado'),       # Patsy Cristina Lee Rentería de Huang
    'YUZAIDA DE AGUILAR': ('yuzaida-marin', 'verificado'),         # Yuzaida Andrea Marín Nateron de Aguilar
    'NIXSON RODRIGUEZ': ('nixon-andrade', 'verificado'),           # Nixson Andrade Rodríguez
    'AUGUSTO PALACIO': ('augusto-palacios', 'verificado'),
    'EDUARDO VAASQUEZ': ('eduardo-vasquez', 'verificado'),
    'JONATHAN VEGA': ('jhonatan-vega', 'verificado'),
    'MIGUEL CAMPO': ('miguel-angel-campos', 'verificado'),
    'ROBERTO ARCHIBOL': ('roberto-archibold', 'verificado'),
    'SHIRLEY CASTAÑEDA': ('shirley-castanedas', 'verificado'),
    'JOSE L VARELA': ('jose-luis-varela', 'verificado'),
    'ALEXANDRA DE VASQUEZ': ('alexandra-brenes', 'probable'),
    'LILIA DE GUERRA': ('lilia-batista', 'probable'),
    'YAMIRELIZ DE GARAY': ('yamireliz-chong', 'probable'),
}
# Entradas del portal que no son diputados
NO_DIPUTADOS = {'ASAMBLEA LEGISLATIVA', 'COMISION DE LEGISLACION', 'SIN DATOS'}


def _norm(s):
    s = unicodedata.normalize('NFD', (s or '').upper())
    return ' '.join(''.join(c for c in s if unicodedata.category(c) != 'Mn').split())


class Portal:
    """Formulario ASP.NET del portal: cada acción es un POST con el estado oculto de la página."""
    def __init__(self):
        self.s = requests.Session()
        self.s.headers['User-Agent'] = UA

    def _pedir(self, metodo, url, **kw):
        for intento in range(1, REINTENTOS + 1):
            try:
                r = self.s.request(metodo, url, timeout=60, **kw)
                r.raise_for_status()
                return r.text
            except requests.RequestException:
                if intento == REINTENTOS: raise
                time.sleep(5 * intento)

    def _postback(self, pagina, target, extra=None):
        datos = {m.group(1): html.unescape(m.group(2)) for m in
                 re.finditer(r'<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"', pagina)}
        datos.update({'__EVENTTARGET': target, '__EVENTARGUMENT': ''}, **(extra or {}))
        time.sleep(PAUSA)
        return self._pedir('POST', URL + 'index.aspx', data=datos)

    def abrir_periodo(self):
        h = self._pedir('GET', URL)
        h = self._postback(h, 'lbtnpordiputado')
        self.pagina_periodo = self._postback(h, 'ddlPeriodo', {'ddlPeriodo': PERIODO})
        sel = self.pagina_periodo.split('id="ddlDiputados"')[1].split('</select>')[0]
        return [(v, html.unescape(t).strip()) for v, t in re.findall(r'<option value="(\d+)">([^<]+)</option>', sel)]

    def consultar(self, id_dip):
        """Devuelve (fecha de corte, filas). Cada fila: cédula, nº de pagos, monto, tipo, año."""
        extra = {'ddlPeriodo': PERIODO, 'ddlDiputados': id_dip}
        h = self._postback(self.pagina_periodo, 'ddlDiputados', extra)
        casillas = re.findall(r'<input id="cblist\w+?_\d+" type="checkbox" name="([^"]+)"', h)
        h = self._postback(h, 'lbtnBuscar', {**extra, **{n: 'on' for n in casillas}})   # todos los años y tipos
        corte = re.search(r'actualizados hasta:\s*(\d{2})/(\d{2})/(\d{4})', h)
        corte = f'{corte.group(3)}-{corte.group(2)}-{corte.group(1)}' if corte else None
        filas = []
        if 'gv_resultadoprin_b2' in h:
            tabla = h.split('id="gv_resultadoprin_b2"')[1].split('</table>')[0]
            for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', tabla, re.S)[1:]:
                c = [html.unescape(re.sub(r'<[^>]+>', ' ', x)).strip() for x in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)]
                if len(c) < 7: continue
                clave = c[0].split('|')          # cédula|año|tipo|id diputado|periodo
                tipo = clave[2] if len(clave) > 2 and clave[2] else ('DON' if 'DONACION' in c[5].upper() else '')
                try:
                    filas.append({'cedula': c[3], 'pagos': int(c[1] or 0), 'monto': float(c[2].replace(',', '') or 0),
                                  'tipo': tipo, 'anio': c[6]})
                except ValueError:
                    continue
        return corte, filas


def resumir(filas):
    """Totales sin datos personales."""
    por_tipo, por_anio = defaultdict(float), defaultdict(float)
    for f in filas:
        por_tipo[f['tipo']] += f['monto']
        por_anio[f['anio']] += f['monto']
    return {'personas': len({f['cedula'] for f in filas}), 'pagos': sum(f['pagos'] for f in filas),
            'total': round(sum(f['monto'] for f in filas), 2),
            'por_tipo': {k: round(v, 2) for k, v in sorted(por_tipo.items())},
            'por_anio': {k: round(v, 2) for k, v in sorted(por_anio.items())}}


def emparejar(nombre_cgr, diputados):
    """Slug del observatorio para un nombre de la Contraloría, y la confianza de la coincidencia."""
    n = _norm(nombre_cgr)
    for alias, (slug, conf) in ALIAS_CGR.items():
        if _norm(alias) == n: return slug, conf
    tok = set(n.split())
    cand = [d for d in diputados if set(_norm(d['nombre']).split()) <= tok or tok <= set(_norm(d['nombre']).split())]
    return (cand[0]['slug'], 'verificado') if len(cand) == 1 else (None, None)


def main():
    forzar = '--forzar' in sys.argv
    try:
        previo = json.load(open(SALIDA, encoding='utf-8'))
    except Exception:
        previo = {}
    diputados = json.load(open(RESUMEN, encoding='utf-8'))['diputados']
    hoy = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    print('=' * 55, '\n PLANILLAS — Contraloría General de la República\n' + '=' * 55)
    portal = Portal()
    lista = portal.abrir_periodo()
    print(f'  Diputados/entidades en el portal: {len(lista)}')

    # 1) ¿Cambió la fecha de corte? (una sola consulta)
    muestra = next((v for v, t in lista if _norm(t) not in NO_DIPUTADOS), lista[0][0])
    corte, _ = portal.consultar(muestra)
    print(f'  Corte publicado: {corte} · corte guardado: {previo.get("corte")}')
    if previo.get('corte') == corte and previo.get('diputados') and not forzar:
        previo['verificado'] = hoy
        json.dump(previo, open(SALIDA, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('  Sin cambios en la Contraloría: no se repite la extracción.')
        return

    # 2) Extracción completa
    anteriores = {d['nombre_cgr']: d for d in previo.get('diputados', [])}
    salida_dips, entidades, fallidos = [], [], []
    for i, (id_dip, nombre) in enumerate(lista, 1):
        try:
            _, filas = portal.consultar(id_dip)
        except requests.RequestException as e:
            fallidos.append(nombre)
            print(f'  ADVERTENCIA: {nombre}: {e}')
            if nombre in anteriores: salida_dips.append(anteriores[nombre])
            continue
        datos = {'nombre_cgr': nombre, **resumir(filas)}
        if _norm(nombre) in NO_DIPUTADOS:
            entidades.append(datos)
        else:
            slug, conf = emparejar(nombre, diputados)
            salida_dips.append({**datos, 'slug': slug, 'coincidencia': conf})
        if i % 10 == 0: print(f'  {i}/{len(lista)}')

    asignados = {d['slug'] for d in salida_dips if d.get('slug')}
    resultado = {
        'fuente': URL, 'periodo': '2024-2029', 'corte': corte, 'extraido': hoy, 'verificado': hoy,
        'tipos': TIPOS,
        'diputados': sorted(salida_dips, key=lambda d: -d['total']),
        'entidades': entidades,
        'no_publicados': sorted(d['slug'] for d in diputados if d['slug'] not in asignados),
        'sin_identificar': sorted(d['nombre_cgr'] for d in salida_dips if not d.get('slug')),
        'fallidos': fallidos,
    }
    json.dump(resultado, open(SALIDA, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    total = sum(d['total'] for d in salida_dips)
    print(f'  {len(salida_dips)} diputados · B/. {total:,.2f} · sin publicar en la CGR: {len(resultado["no_publicados"])}'
          f' · sin identificar: {resultado["sin_identificar"]} · fallidos: {len(fallidos)}')


if __name__ == '__main__':
    main()
