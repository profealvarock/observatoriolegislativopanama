"""Pruebas de los parsers y reglas de scripts/actualizar_indicadores.py.

Los fixtures de tests/fixtures/ son extractos de las páginas reales (descargadas el 20 nov 2026).
Correr con:  python -m pytest tests
"""
import json
import shutil
import sys
from datetime import date
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / 'scripts'))
import actualizar_indicadores as ai  # noqa: E402

FIX = Path(__file__).resolve().parent / 'fixtures'


def leer(nombre):
    return (FIX / nombre).read_text(encoding='utf-8')


# ── Frescura ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize('corte,esperado', [
    ('2026-11-23', ('verde', 0)),
    ('2026-11-16', ('verde', 7)),
    ('2026-11-15', ('ambar', 8)),
    ('2026-10-24', ('ambar', 30)),
    ('2026-10-23', ('rojo', 31)),
    (None, ('sd', None)),
])
def test_frescura_umbrales(corte, esperado):
    assert ai.frescura(corte, date(2026, 11, 23)) == esperado


# ── Validación ───────────────────────────────────────────────────────────────

def test_validar_numero_rechaza_fuera_de_rango_y_no_numericos():
    assert ai.validar_numero(4.66, 'g95', ai.RANGOS['combustible_gal']) == 4.66
    with pytest.raises(ai.ErrorValidacion):
        ai.validar_numero(1.23, 'g95', ai.RANGOS['combustible_gal'])   # precio por litro, no por galón
    with pytest.raises(ai.ErrorValidacion):
        ai.validar_numero('4.66', 'g95')
    with pytest.raises(ai.ErrorValidacion):
        ai.validar_numero(True, 'g95')


def test_validar_fecha_rechaza_futuras():
    hoy = date(2026, 11, 20)
    assert ai.validar_fecha('2026-11-13', hoy, 'x') == date(2026, 11, 13)
    with pytest.raises(ai.ErrorValidacion):
        ai.validar_fecha('2026-11-27', hoy, 'x')


def test_dedup_series_conserva_el_ultimo_y_ordena():
    serie = [{'periodo': '2026-02', 'valor': 1}, {'periodo': '2026-01', 'valor': 2}, {'periodo': '2026-02', 'valor': 3}]
    assert ai.dedup_series(serie) == [{'periodo': '2026-01', 'valor': 2}, {'periodo': '2026-02', 'valor': 3}]


# ── Combustible ──────────────────────────────────────────────────────────────

def test_periodos_del_feed_de_la_sne():
    items = ai.leer_rss(leer('sne_feed.xml'))
    periodos = [ai.parse_periodo_sne(i['titulo']) for i in items]
    assert (date(2026, 11, 13), date(2026, 11, 27)) in periodos
    assert (date(2026, 10, 30), date(2026, 11, 13)) in periodos
    assert all(p for p in periodos)


def test_periodo_que_cruza_el_anio():
    assert ai.parse_periodo_sne('del 25 de diciembre al 8 de enero de 2027') == (date(2026, 12, 25), date(2027, 1, 8))


def test_combustible_la_estrella_salta_las_variaciones():
    # La nota menciona primero las rebajas (B/.0.093 por litro); deben ignorarse.
    r = ai.parse_combustible(ai.html_a_texto(leer('laestrella_combustible_13nov.html')))
    assert r == {'g95': 1.231, 'g91': 1.102, 'diesel': 1.434}
    assert [ai.litro_a_galon(r[k]) for k in ('g95', 'g91', 'diesel')] == [4.66, 4.17, 5.43]


def test_combustible_la_prensa_con_dos_decimales():
    r = ai.parse_combustible(ai.html_a_texto(leer('prensa_combustible_13nov.html')))
    assert r == {'g95': 1.23, 'g91': 1.10, 'diesel': 1.43}


def test_combustible_lista_por_provincia_toma_panama_y_colon():
    # Telemetro lista todas las localidades; Arraiján (B/.1.234) viene justo después de Panamá y Colón.
    texto = ai.html_a_texto(leer('telemetro_combustible_provincias.html'))
    assert ai.parse_combustible(texto) == {'g95': 1.231, 'g91': 1.102, 'diesel': 1.434}
    assert ai.menciona_fecha(texto, date(2026, 11, 13))


def test_menciona_fecha_evita_precios_de_otra_quincena():
    texto = ai.html_a_texto(leer('laestrella_combustible_13nov.html'))
    assert ai.menciona_fecha(texto, date(2026, 11, 13))
    assert not ai.menciona_fecha(texto, date(2026, 10, 30))


def test_enlaces_de_la_pagina_de_etiqueta():
    enlaces = ai.enlaces_combustible(leer('telemetro_tag_gasolina.html'), date(2026, 11, 13))
    assert enlaces and all('13-noviembre' in u for u in enlaces)
    assert ai.enlaces_combustible(leer('telemetro_tag_gasolina.html'), date(2026, 12, 11)) == []


def test_combustible_sin_cifras_devuelve_none():
    assert ai.parse_combustible('La Secretaría informa que los precios se actualizan cada 14 días.') is None


# ── CBFA (PDF del MEF) ───────────────────────────────────────────────────────

def test_cbfa_desde_el_pdf_del_mef():
    texto = ai.pdf_a_texto((FIX / 'mef_cbfa_junio_2026_p7.pdf').read_bytes())
    assert ai.parse_cbfa(texto) == {'mes': 6, 'valor': 366.98, 'previo': 367.00}


def test_cbfa_otra_redaccion_y_mes_previo_revisado():
    # Agosto: "se calculó a un costo de B/.369.21 en agosto … mes previo (B/.368.24)".
    # El informe de julio había publicado 367.03: el de agosto lo revisa.
    texto = ai.pdf_a_texto((FIX / 'mef_cbfa_agosto_2026_p7.pdf').read_bytes())
    assert ai.parse_cbfa(texto) == {'mes': 8, 'valor': 369.21, 'previo': 368.24}


def test_url_cbfa_prueba_meses_de_publicacion_siguientes():
    urls = list(ai._url_cbfa(2026, 9))
    assert urls[0].endswith('/2026/10/MEF-DAES-Canasta-Basica-Familiar-de-Alimentos-SEPTIEMBRE-2026.pdf')
    assert any('SETIEMBRE' in u for u in urls)
    assert any('/2027/01/' in u for u in ai._url_cbfa(2026, 12))


# ── Sismo ────────────────────────────────────────────────────────────────────

def test_balance_sinaproc_comunicado_23():
    r = ai.parse_sinaproc_balance(ai.html_a_texto(leer('sinaproc_comunicado_23.html')))
    assert r['fecha_corte'] == date(2026, 10, 26)
    assert r['viviendas_evaluadas'] == 13681
    assert r['afectados'] == 44885
    assert r['heridos'] == 27
    assert r['fallecidos'] == 2
    assert r['escuelas'] == 619
    assert r['salud'] == 120
    assert r['albergues'] == 152
    assert r['albergados'] == 5642
    assert r['ayuda_aire_lb'] == 208317
    assert r['ayuda_tierra_t'] == 365
    assert r['comunidades_atendidas'] == 175


def test_balance_sinaproc_ignora_cifras_provinciales():
    # El comunicado también trae el balance de Chiriquí (318 viviendas afectadas): no debe confundirse.
    r = ai.parse_sinaproc_balance(ai.html_a_texto(leer('sinaproc_comunicado_23.html')))
    assert 318 not in r.values()


def test_balance_sinaproc_otra_redaccion_comunicado_26():
    r = ai.parse_sinaproc_balance(ai.html_a_texto(leer('sinaproc_comunicado_26.html')))
    assert r['fecha_corte'] == date(2026, 10, 30)          # sin "corte a las": fecha de publicación
    assert (r['viviendas_evaluadas'], r['afectados']) == (17058, 55245)
    assert (r['fallecidos'], r['heridos']) == (2, 27)       # "dos personas fallecidas y 27 lesionadas"
    assert r['escuelas'] == 619                             # "de los cuales 619 presentan afectaciones"
    assert r['salud'] == 120                                # "120 centros de salud afectados"
    assert (r['albergues'], r['albergados']) == (135, 4428)  # "135 albergues, donde permanecen 4,428 personas"
    assert r['ayuda_tierra_t'] == 365


def test_balance_sinaproc_comunicado_31_no_confunde_ayuda_internacional():
    r = ai.parse_sinaproc_balance(ai.html_a_texto(leer('sinaproc_comunicado_31.html')))
    assert r['fecha_corte'] == date(2026, 11, 13)
    assert (r['viviendas_evaluadas'], r['afectados'], r['albergues']) == (22245, 70306, 91)
    assert 'ayuda_tierra_t' not in r       # "48 toneladas de asistencia" es cooperación internacional
    assert 'salud' not in r                # "120 centros de salud" sin decir afectados: no se toma
    assert 'albergados' not in r


def test_replicas_tvn():
    r = ai.parse_replicas(ai.html_a_texto(leer('tvn_replicas_nov2026.html')))
    assert r == {'localizadas': 1690, 'aproximado': True}


# ── Encuestas ────────────────────────────────────────────────────────────────

def test_vea_panama_julio_2026():
    r = ai.parse_vea(ai.html_a_texto(leer('laestrella_vea_jul2026.html')))
    assert r['buena'] == 17.9
    assert r['mala'] == 77.6
    assert r['mal_camino'] == 79.5
    assert r['campo'] == (date(2026, 7, 12), date(2026, 7, 16))
    assert r['n'] == 1508


def test_vea_ignora_notas_sin_medicion():
    assert ai.parse_vea('El presidente habló de la encuesta de Vea Panamá en su conferencia.') is None


def test_sismo_en_modo_archivo_no_se_actualiza(monkeypatch):
    def no_llamar(*a, **k):
        raise AssertionError('en modo archivo no debe consultar fuentes')
    monkeypatch.setattr(ai, 'http_get', no_llamar)
    monkeypatch.setattr(ai, 'existe', no_llamar)
    sm = {'activo': False, 'metricas': [], 'series': {'replicas': []}, 'fuentes': {}}
    assert ai.modulo_sinaproc(sm, date(2026, 11, 23), lambda *a: None) is False
    assert ai.modulo_igc(sm, date(2026, 11, 23), lambda *a: None) is False


# ── Salarios y empleo (INEC) ─────────────────────────────────────────────────

def test_mediana_por_sector_y_sexo():
    r = ai.parse_mediana_inec((FIX / 'inec_eml_ago2026_cuadro21_sector.xlsx').read_bytes())
    assert r['periodo'] == '2026-08'
    g = r['grupos']
    assert (g['Total']['mediana'], g['Hombres']['mediana'], g['Mujeres']['mediana']) == (769.39, 764.57, 776.35)
    sectores = {f['etiqueta']: f['mediana'] for f in g['Total']['filas']}
    assert sectores['Enseñanza'] == 1329.01
    assert sectores['Agricultura, ganadería, caza, silvicultura, pesca y actividades de servicios conexas'] == 353.46
    # las etiquetas de varias filas se unen y la palabra cortada con guion se recompone
    assert any(k.startswith('Suministro de agua; alcantarillado, gestión') for k in sectores)
    # las subramas (artículos durables, al por mayor…) no se cuentan como sectores
    assert not any(k.startswith(('Artículos', 'Al por mayor')) for k in sectores)
    assert len(g['Total']['filas']) == len(g['Mujeres']['filas']) == 21


def test_mediana_por_ocupacion():
    r = ai.parse_mediana_inec((FIX / 'inec_eml_ago2026_cuadro22_ocupacion.xlsx').read_bytes())
    ocup = {f['etiqueta']: f['mediana'] for f in r['grupos']['Total']['filas']}
    assert ocup['Profesionales, científicos e intelectuales'] == 1577.21
    assert len(ocup) == 9


def test_mediana_por_provincia_y_sexo():
    r = ai.parse_mediana_inec((FIX / 'inec_eml_sep2025_cuadro25_provincia.xlsx').read_bytes())
    assert r['periodo'] == '2025-09'
    assert r['grupos']['Total']['mediana'] == 755.8
    prov = {p['provincia']: p for p in r['provincias']}
    assert len(prov) == 13
    assert prov['Panamá']['Total']['mediana'] == 786.74
    assert prov['Comarca Ngäbe Buglé']['Mujeres']['mediana'] == 487.84
    assert prov['Bocas del Toro']['Hombres']['mediana'] == 539.71


def test_desempleo_del_comentario():
    d = ai.parse_desempleo(leer('inec_eml_ago2026_comentario.txt'))
    assert d == {'anterior': 10.4, 'tasa': 8.5, 'jovenes_20_24': 22.6}


def test_informalidad_csv():
    texto = (FIX / 'inec_situacion_ago2026_cuadro11_informalidad.csv').read_bytes().decode('utf-8-sig', errors='replace')
    pares = dict(ai.parse_informalidad_csv(texto))
    assert pares[2026] == 45.8 and pares[2025] == 47.1 and pares[2024] == 47.7
    assert pares[2020] == 52.8        # 2020 trae "…" en el desglose, pero el porcentaje total es válido


def test_periodo_eml():
    assert ai.periodo_eml('Boletín de la Encuesta Mercado Laboral Agosto 2026') == '2026-08'
    assert ai.periodo_eml('ENCUESTA DE MERCADO LABORAL: SEPTIEMBRE 2025') == '2025-09'
    assert ai.periodo_eml('sin fecha') is None


# ── Minería ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize('titulo,esperado', [
    ('En seis días comenzarán las negociaciones que definirán el futuro de la mina de cobre de Donoso', True),
    ('Panamá autoriza negociaciones con First Quantum para reapertura de Cobre Panamá', True),
    ('Reformas al Código de Recursos Minerales: ¿qué cambios se plantean?', True),
    ('Minsa reporta nuevos casos de dengue', False),
    ('Dengue y malaria en Panamá: qué los causa', False),
])
def test_es_noticia_minera(titulo, esperado):
    assert ai.es_noticia_minera(titulo) is esperado


def test_noticias_mineras_se_agregan_sin_duplicar(monkeypatch):
    rss = '''<rss><channel>
      <item><title>Mulino anuncia negociación con First Quantum</title><link>https://ej.pa/a</link><pubDate>Mon, 16 Nov 2026 20:00:00 +0000</pubDate></item>
      <item><title>Encuesta: 60% apoya referéndum minero</title><link>https://ej.pa/b</link><pubDate>Tue, 17 Nov 2026 10:00:00 +0000</pubDate></item>
      <item><title>Minsa amplía horario de vacunación</title><link>https://ej.pa/c</link><pubDate>Tue, 17 Nov 2026 10:00:00 +0000</pubDate></item>
    </channel></rss>'''
    monkeypatch.setattr(ai, 'FEEDS_PRENSA', ['https://ej.pa/rss'])
    monkeypatch.setattr(ai, 'http_get', lambda url, binario=False: rss)
    avisos = []
    mi = {'series': {'noticias': [{'periodo': '2026-11-16', 'titulo': 'ya estaba', 'url': 'https://ej.pa/a', 'medio': 'ej.pa'}]}}
    assert ai.modulo_noticias_mineria(mi, date(2026, 11, 20), lambda m, t: avisos.append((m, t))) is True
    urls = [n['url'] for n in mi['series']['noticias']]
    assert urls == ['https://ej.pa/b', 'https://ej.pa/a']          # sin duplicar y sin la nota del Minsa
    assert any(m == 'encuestas' for m, _ in avisos)               # la encuesta queda para revisar a mano


# ── Job completo sin red: un módulo caído no rompe el resto ──────────────────

def test_job_conserva_valores_y_registra_advertencias(tmp_path, monkeypatch):
    for f in ai.ARCHIVOS.values():
        shutil.copy(RAIZ / 'data' / f, tmp_path / f)
    antes = json.loads((tmp_path / 'costo_vida.json').read_text(encoding='utf-8'))

    def sin_red(*a, **k):
        raise ConnectionError('sin red (prueba)')
    monkeypatch.setattr(ai, 'http_get', sin_red)
    monkeypatch.setattr(ai, 'existe', lambda url: False)

    ai.ejecutar(date(2026, 11, 23), data_dir=tmp_path)
    despues = json.loads((tmp_path / 'costo_vida.json').read_text(encoding='utf-8'))
    assert despues['series']['combustible'] == antes['series']['combustible']
    assert ai.metrica(despues, 'gasolina_95_gal')['valor'] == ai.metrica(antes, 'gasolina_95_gal')['valor']
    modulos = {a['modulo'] for a in despues['advertencias']}
    assert 'combustible' in modulos
    # la foto semanal sí se guarda, con los valores vigentes
    assert despues['series']['fotos'][-1]['periodo'] == '2026-11-23'
    sismo = json.loads((tmp_path / 'sismo.json').read_text(encoding='utf-8'))
    assert any(a['modulo'] in ('sinaproc', 'igc') for a in sismo['advertencias'])
