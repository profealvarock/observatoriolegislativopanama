"""
=============================================================
 CLASIFICACIÓN TEMÁTICA DE PROYECTOS DE LEY - Observatorio Legislativo

 Estándar: temas mayores del Comparative Agendas Project (CAP, comparativeagendas.net),
 adaptados a Panamá, más una segunda dimensión: el tipo de norma.

 - clasificacion_tematica.json guarda la clasificación de cada ficha:
     fuente "ia"     → revisada con IA (no se vuelve a calcular)
     fuente "modelo" → proyecto nuevo, clasificado con el modelo aprendido de las fichas "ia"
 - modelo_temas.json guarda el modelo (Naive Bayes multinomial sobre palabras del título),
   entrenado con las clasificaciones revisadas. Sin dependencias ni API.

EJECUCIÓN:
    python temas_cap.py --entrenar        # reentrena el modelo con las fichas "ia" y muestra su precisión
    python temas_cap.py --importar F.json # incorpora clasificaciones revisadas {ficha: [tema, tema2]}
=============================================================
"""

import json, math, os, re, sys, unicodedata
from collections import Counter, defaultdict

CLASIFICACION = 'clasificacion_tematica.json'
MODELO = 'modelo_temas.json'
VERSION_TAXONOMIA = 'CAP-PA 1.0'
UMBRAL_REVISION = 0.5   # por debajo de esta confianza, el proyecto nuevo queda marcado para revisión
UMBRAL_OTROS = 0.3      # por debajo de esta, no se adivina: queda en "Otros" (y para revisión)

# Código CAP → (nombre en el sitio, qué incluye). 99 = el título no permite identificar el tema.
TEMAS_CAP = {
    1:  ('Macroeconomía y finanzas públicas', 'Presupuesto, impuestos, deuda, política fiscal y monetaria.'),
    2:  ('Derechos civiles e igualdad', 'Discriminación, género, discapacidad, pueblos indígenas y afrodescendientes, privacidad y libertades.'),
    3:  ('Salud', 'Sistema de salud, enfermedades, medicamentos, profesiones sanitarias, nutrición y salud mental.'),
    4:  ('Agro y pesca', 'Agricultura, ganadería, pesca, sanidad agropecuaria y seguridad alimentaria.'),
    5:  ('Trabajo y empleo', 'Derechos laborales, salarios, escalafones, licencias, formación para el empleo y profesiones.'),
    6:  ('Educación', 'Escuelas, universidades, docentes, becas y contenidos educativos.'),
    7:  ('Ambiente y protección animal', 'Áreas protegidas, residuos, contaminación, biodiversidad, cuencas y bienestar animal.'),
    8:  ('Energía y minería', 'Electricidad, combustibles, energías renovables y recursos minerales.'),
    9:  ('Migración', 'Extranjería, residencia y servicio de migración.'),
    10: ('Transporte', 'Tránsito, transporte público y de carga, vías, puertos, aviación y Canal como vía.'),
    12: ('Justicia, crimen y seguridad', 'Código Penal y procesal, policía, sistema judicial y penitenciario, corrupción como delito.'),
    13: ('Bienestar social y seguridad social', 'Caja de Seguro Social, pensiones, subsidios, niñez, familia y adultos mayores.'),
    14: ('Vivienda y desarrollo urbano', 'Vivienda, ordenamiento urbano, propiedad horizontal e infraestructura comunitaria.'),
    15: ('Comercio, banca y consumo', 'Empresas, banca y finanzas, consumidores, competencia, turismo y seguros.'),
    16: ('Seguridad nacional y emergencias', 'Fronteras, protección civil, gestión de riesgo y desastres.'),
    17: ('Ciencia, tecnología y comunicaciones', 'Investigación, innovación, telecomunicaciones, ciberseguridad e inteligencia artificial.'),
    18: ('Comercio exterior', 'Aranceles, aduanas, zonas francas y acuerdos comerciales.'),
    19: ('Relaciones internacionales', 'Tratados y convenios no comerciales, cooperación, servicio exterior.'),
    20: ('Gobierno y administración pública', 'Asamblea, sistema electoral, municipios, servidores públicos, contrataciones y transparencia.'),
    21: ('Tierras, agua y territorio', 'Tierras públicas, titulación, recursos hídricos, agua potable y bienes del Estado.'),
    23: ('Cultura, deporte y patrimonio', 'Arte, patrimonio, festivales, deporte y símbolos patrios.'),
    99: ('Otros', 'El título no permite identificar el tema (p. ej. "Que modifica la Ley 15 de 1995").'),
}
# Nombre corto para ejes de gráficos (el completo va en tooltips y tablas)
CORTO = {1: 'Macroeconomía', 2: 'Derechos civiles', 3: 'Salud', 4: 'Agro y pesca', 5: 'Trabajo', 6: 'Educación',
         7: 'Ambiente', 8: 'Energía y minería', 9: 'Migración', 10: 'Transporte', 12: 'Justicia y seguridad',
         13: 'Bienestar social', 14: 'Vivienda y urbanismo', 15: 'Comercio y consumo', 16: 'Seguridad nacional',
         17: 'Ciencia y tecnología', 18: 'Comercio exterior', 19: 'Relaciones exteriores', 20: 'Gobierno',
         21: 'Tierras y agua', 23: 'Cultura y deporte', 99: 'Otros'}
CORTO_TIPO = {'tratado': 'Tratado', 'presupuesto': 'Presupuesto', 'declarativa': 'Declarativa', 'reforma': 'Reforma', 'nueva': 'Nueva regulación'}
# Orden de presentación: por código CAP, "Otros" al final
CODIGOS = sorted(c for c in TEMAS_CAP if c != 99) + [99]
NOMBRE = {c: TEMAS_CAP[c][0] for c in CODIGOS}

# Tipo de norma: se deduce del título con reglas fijas (no lo decide la IA). El orden importa.
TIPOS_NORMA = [
    ('tratado', 'Aprobación de tratado o convenio',
     r'\b(APRUEBA|ADOPTA)\b.{0,40}\b(CONVENIO|TRATADO|ACUERDO|PROTOCOLO|CONVENCION|ESTATUTOS|ENMIENDA)\b'),
    ('presupuesto', 'Presupuesto y finanzas del Estado',
     r'\bDICTA (EL|LA LEY MARCO DEL) PRESUPUESTO\b|\bPRESUPUESTO GENERAL DEL ESTADO\b|\bTRASLADO DE PARTIDA|\bCREDITO (EXTRAORDINARIO|SUPLEMENTARIO)'),
    ('declarativa', 'Declarativa o conmemorativa',
     r'\bDECLARA\b.{0,40}\b(DIA|SEMANA|MES|ANO|PATRIMONIO|MONUMENTO|FERIADO|SITIO)\b|\bDIA (NACIONAL|INTERNACIONAL|DEL|DE LA|DE LOS)\b'
     r'|\bFESTIVAL\b|\bFERIA\b|\bCONMEMORA|\bCONDECORACION\b|\bORDEN (NACIONAL|BELISARIO)|\bDESIGNA CON EL NOMBRE\b|\bDENOMINA\b'
     r'|\bRESALTA LOS VALORES\b|\bPATRONATO DE LA (FERIA|SEMANA SANTA)'),
    ('reforma', 'Reforma de una ley existente',
     r'^(LEY |POR (EL|LA) CUAL SE |POR MEDIO (DEL|DE LA) CUAL SE |QUE SE )?(QUE )?(MODIFICA|ADICIONA|DEROGA|REFORMA|SUBROGA|SUSPENDE|ACTUALIZA|INTRODUCE A LA LEY)'),
]
TIPO_NUEVA = ('nueva', 'Nueva regulación o política')
NOMBRE_TIPO = {k: n for k, n, _ in TIPOS_NORMA} | {TIPO_NUEVA[0]: TIPO_NUEVA[1]}
_TIPOS_RE = [(k, re.compile(p)) for k, _, p in TIPOS_NORMA]

def sin_tildes(s):
    s = unicodedata.normalize('NFD', str(s or '').upper())
    return re.sub(r'\s+', ' ', ''.join(c for c in s if unicodedata.category(c) != 'Mn')).strip()

def tipo_norma(titulo):
    t = sin_tildes(titulo)
    return next((k for k, rx in _TIPOS_RE if rx.search(t)), TIPO_NUEVA[0])


# ─────────────────────────────────────────────
# MODELO (Naive Bayes multinomial sobre el título)
# ─────────────────────────────────────────────
_VACIAS = set('''QUE LEY DEL LOS LAS POR PARA CON SOBRE COMO CUAL OTRAS OTRA OTROS DISPOSICIONES DISPOSICION DICTA
DICTAN ESTABLECE ESTABLECEN CREA CREAN MODIFICA MODIFICAN ADICIONA ADICIONAN DEROGA SUBROGA REFORMA ARTICULO ARTICULOS
REPUBLICA PANAMA NACIONAL GENERAL MARCO MEDIDAS MEDIO TEXTO UNICO ADOPTA REGULA DECRETO PROGRAMA SISTEMA REGIMEN
INTEGRAL ESPECIAL NUEVO NUEVA ENERO FEBRERO MARZO ABRIL MAYO JUNIO JULIO AGOSTO SEPTIEMBRE OCTUBRE NOVIEMBRE DICIEMBRE
CAPITULO TITULO LIBRO NUMERAL PARRAFO MISMA DICHA SUS SU UNA UNO LAS DESDE ENTRE TODO TODA TODOS FIN OBJETO PERMITE
PROMUEVE FOMENTA GARANTIZA RECONOCE INSTITUYE HONORABLE DIPUTADO'''.split())
_RX_LEY = re.compile(r'\b(LEY|DECRETO LEY|DECRETO DE GABINETE)\s*(?:N[O°º.]*\s*)?(\d+)\s+(?:DE\s+(?:\d{1,2}\s+DE\s+)?(?:[A-Z]+\s+DE\s+)?(?:DEL\s+)?)?(\d{4})')

# Pistas por palabras clave (la clasificación anterior del sitio). No deciden el tema: entran al
# modelo como un rasgo más, y el modelo aprende de las fichas revisadas cuánto pesa cada una.
PISTAS = [
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
_PISTAS_RE = [(nombre, [re.compile(p) for p in pats]) for nombre, pats in PISTAS]
PESO_PISTAS = 2   # validación cruzada: 71 % de acierto con pistas frente a 69 % sin ellas

def rasgos(titulo):
    """Palabras del título (raíz de 6 letras), pares de palabras, leyes citadas ("LEY 45/2007") y pistas."""
    t = sin_tildes(titulo)
    leyes = [f'@{m.group(1)[0]}{m.group(2)}/{m.group(3)}' for m in _RX_LEY.finditer(t)]
    ws = [w[:6] for w in re.findall(r'[A-Z]{3,}', t) if w not in _VACIAS]
    pistas = ['K:' + n for n, pats in _PISTAS_RE if any(p.search(t) for p in pats)] * PESO_PISTAS
    return ws + [a + '_' + b for a, b in zip(ws, ws[1:])] + leyes + pistas

def entrenar(etiquetas, titulos):
    """etiquetas: {ficha: [tema, tema2?]}. El tema principal pesa 1; el secundario, 0,5."""
    cuenta, total, docs = defaultdict(Counter), Counter(), Counter()
    for f, ts in etiquetas.items():
        rs = rasgos(titulos.get(f, ''))
        for i, c in enumerate(ts[:2]):
            peso = 1.0 if i == 0 else 0.5
            docs[c] += peso
            for r in rs:
                cuenta[c][r] += peso
                total[c] += peso
    vocab = {r for c in cuenta for r in cuenta[c]}
    return {'clases': {str(c): {'prior': docs[c], 'total': total[c], 'rasgos': dict(cuenta[c])} for c in docs},
            'vocabulario': len(vocab), 'alfa': 0.5}

def predecir(modelo, titulo):
    """→ [(tema, probabilidad), …] de mayor a menor."""
    rs = rasgos(titulo)
    V, a = modelo['vocabulario'], modelo['alfa']
    n_docs = sum(c['prior'] for c in modelo['clases'].values())
    log = {}
    for c, m in modelo['clases'].items():
        lp = math.log(m['prior'] / n_docs)
        den = math.log(m['total'] + a * V)
        for r in rs:
            lp += math.log(m['rasgos'].get(r, 0) + a) - den
        log[int(c)] = lp
    mx = max(log.values())
    z = sum(math.exp(v - mx) for v in log.values())
    return sorted(((c, math.exp(v - mx) / z) for c, v in log.items()), key=lambda x: -x[1])

def evaluar(etiquetas, titulos, k=5):
    """Validación cruzada: ¿el modelo acierta el tema que asignó la revisión con IA?"""
    fichas = sorted(etiquetas)
    ok1 = ok2 = 0
    for i in range(k):
        prueba = fichas[i::k]
        m = entrenar({f: etiquetas[f] for f in fichas if f not in set(prueba)}, titulos)
        for f in prueba:
            p = [c for c, _ in predecir(m, titulos[f])[:2]]
            ok1 += p[0] == etiquetas[f][0]
            ok2 += etiquetas[f][0] in p
    n = len(fichas)
    return {'fichas': n, 'acierto_tema_principal': round(100 * ok1 / n, 1), 'acierto_entre_2_primeros': round(100 * ok2 / n, 1)}


# ─────────────────────────────────────────────
# CLASIFICACIÓN GUARDADA
# ─────────────────────────────────────────────
def _leer(ruta):
    try:
        with open(ruta, encoding='utf-8') as f: return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError): return None

def cargar():
    c = _leer(CLASIFICACION) or {}
    c.setdefault('fichas', {})
    return c

def guardar(c):
    c['version'] = VERSION_TAXONOMIA
    c['temas'] = {str(k): {'nombre': n, 'incluye': d} for k, (n, d) in TEMAS_CAP.items()}
    c['tipos_norma'] = NOMBRE_TIPO
    c['resumen'] = {'fichas': len(c['fichas']), 'por_fuente': dict(Counter(x['fuente'] for x in c['fichas'].values())),
                    'para_revisar': sorted(f for f, x in c['fichas'].items() if x.get('revisar'))}
    with open(CLASIFICACION, 'w', encoding='utf-8') as f:
        json.dump(c, f, ensure_ascii=False, separators=(',', ':'))

def clasificar_fichas(datos):
    """
    Devuelve {ficha: {'temas': [nombre, …], 'tipo': clave}} para todas las fichas de datos.json.
    Las fichas ya guardadas se respetan; las nuevas se clasifican con el modelo y se guardan.
    """
    c, modelo = cargar(), _leer(MODELO)
    nuevas = 0
    for r in datos:
        f = r['ficha']
        titulo = r.get('titulo') or r.get('anteproyecto') or r.get('proyecto') or ''
        x = c['fichas'].get(f)
        if x is None:
            if modelo:
                pred = predecir(modelo, titulo)
                (t1, p1), (t2, p2) = pred[0], pred[1]
                temas = [99] if p1 < UMBRAL_OTROS else [t1] + ([t2] if p2 >= 0.25 else [])
                x = {'t': temas, 'fuente': 'modelo', 'confianza': round(p1, 2)}
                if p1 < UMBRAL_REVISION: x['revisar'] = True
            else:
                x = {'t': [99], 'fuente': 'modelo', 'confianza': 0, 'revisar': True}
            c['fichas'][f] = x
            nuevas += 1
        x['tipo'] = tipo_norma(titulo)   # regla fija: se recalcula siempre
    if nuevas or not os.path.exists(CLASIFICACION):
        guardar(c)
    if nuevas:
        print(f"  Temas: {nuevas} proyecto(s) nuevo(s) clasificados con el modelo "
              f"({sum(1 for r in datos if c['fichas'][r['ficha']].get('revisar'))} para revisión)")
    return {r['ficha']: {'temas': [NOMBRE[t] for t in c['fichas'][r['ficha']]['t']],
                         'tipo': c['fichas'][r['ficha']]['tipo']} for r in datos}


def meta_resumen():
    """Descripción de la clasificación para resumen.json (la usa el sitio en Proyectos y Metodología)."""
    c, m = cargar(), _leer(MODELO) or {}
    por_fuente = Counter(x['fuente'] for x in c['fichas'].values())
    return {'estandar': 'Comparative Agendas Project (CAP), temas mayores adaptados a Panamá', 'version': VERSION_TAXONOMIA,
            'codigos': {NOMBRE[k]: k for k in CODIGOS}, 'incluye': {NOMBRE[k]: TEMAS_CAP[k][1] for k in CODIGOS},
            'cortos': {NOMBRE[k]: CORTO[k] for k in CODIGOS}, 'tipos_cortos': CORTO_TIPO,
            'revisadas_ia': por_fuente.get('ia', 0), 'clasificadas_modelo': por_fuente.get('modelo', 0),
            'para_revisar': sum(1 for x in c['fichas'].values() if x.get('revisar')),
            'modelo': m.get('evaluacion'), 'umbral_revision': UMBRAL_REVISION}

def _titulos():
    datos = (_leer('datos.json') or {}).get('datos', [])
    return {r['ficha']: r.get('titulo') or r.get('anteproyecto') or '' for r in datos}

def main():
    if '--importar' in sys.argv:
        nuevas = _leer(sys.argv[sys.argv.index('--importar') + 1]) or {}
        c = cargar()
        for f, ts in nuevas.items():
            ts = [int(t) for t in ts][:2]
            assert all(t in TEMAS_CAP for t in ts), (f, ts)
            c['fichas'][f] = {**c['fichas'].get(f, {}), 't': ts, 'fuente': 'ia'}
            c['fichas'][f].pop('revisar', None); c['fichas'][f].pop('confianza', None)
        guardar(c)
        print(f'{len(nuevas)} clasificaciones revisadas incorporadas.')
    if '--entrenar' in sys.argv or '--importar' in sys.argv:
        c, titulos = cargar(), _titulos()
        etiquetas = {f: x['t'] for f, x in c['fichas'].items() if x['fuente'] == 'ia' and f in titulos and x['t'][0] != 99}
        metricas = evaluar(etiquetas, titulos)
        modelo = entrenar(etiquetas, titulos)
        modelo['evaluacion'] = metricas
        modelo['version'] = VERSION_TAXONOMIA
        with open(MODELO, 'w', encoding='utf-8') as f:
            json.dump(modelo, f, ensure_ascii=False, separators=(',', ':'))
        c['modelo'] = metricas
        guardar(c)
        print(f"Modelo entrenado con {metricas['fichas']} fichas · acierto en validación cruzada: "
              f"{metricas['acierto_tema_principal']}% (tema principal), {metricas['acierto_entre_2_primeros']}% (entre los 2 primeros)")

if __name__ == '__main__':
    main()
