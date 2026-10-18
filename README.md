# 🏛️ Observatorio Legislativo — Asamblea Nacional de Panamá

Dashboard interactivo que muestra la producción legislativa de la Asamblea Nacional, con datos actualizados automáticamente cada 24 horas.

## 🌐 Demo
Desplegado en Netlify: [https://observatoriolegistalivopa.netlify.app](https://observatoriolegistalivopa.netlify.app)

## 📊 Qué muestra

| Pestaña | Contenido |
|---------|-----------|
| **General** | Timeline de actividad por mes, donut de etapas, embudo legislativo, top 20 diputados, mapa por provincia |
| **Diputados** | Tabla y tarjetas con producción por diputado (filtrable por partido, provincia y mes) |
| **Monitoreo** | Planilla, asistencia a pleno y comisiones, calificación de desempeño |
| **Partidos** | Proyectos y leyes por partido político |
| **Otros proponentes** | Órgano Ejecutivo, iniciativa ciudadana y comisiones de la Asamblea |
| **Costo Legislativo** | Estimación proporcional del costo por proyecto y por diputado (jul 2024 – presente) |
| **Metodología** | Fuentes, qué cuenta cada número, fórmula del costo, historial y limitaciones conocidas (con datos actualizados) |

Además:
- **Enlaces directos**: la URL refleja lo que se ve y se puede compartir — `#costos`, `#monitoreo`, `#diputado=<slug>` (abre la ficha) o `#comparar=<slug>,<slug>[,<slug>]`.
- **Comparador**: hasta 3 diputados lado a lado (producción, asistencia, planilla y costo), en la pestaña Diputados.
- **Evolución en el tiempo**: gráfico de tendencias en Monitoreo y pestaña "Evolución" en la ficha de cada diputado, a partir de `historico.json`.
- **Datos abiertos**: descargas en CSV (proyectos, diputados, monitoreo, costos e histórico) desde la pestaña General y junto a cada tabla.
- **Modo claro/oscuro** y diseño adaptado a celular y tablet.

## 🎨 Color
Reglas para mantener la paleta coherente:
- **Azul** = marca e información (confianza, institucionalidad; el azul de la bandera).
- **Partidos sin color propio**: todos se muestran igual y se identifican por su nombre, para que ninguno quede asociado a la marca ni a los colores de éxito o alerta.
- **Etapas** (`ETAPA_COLOR` en `index.html`): las que siguen en trámite van en una escala de azules que avanza con el proceso (validada como rampa ordinal en cada tema); Enviado al Ejecutivo = índigo; objetado = naranja; ley = verde; negado = rojo; archivado, retirado o suspendido = gris.
- **Dinero**: montos en tinta neutra y ámbar (`--costo`) como único acento de gasto.
- **Contraste**: textos de al menos 4.5:1 en ambos temas.

## ✍️ Autoría
Creado por **@profealvarock** — [Portafolio](https://profealvarock.vercel.app/) · [TikTok](https://www.tiktok.com/@profealvarock) · [LinkedIn](https://www.linkedin.com/in/profealvarock) · [Instagram](https://www.instagram.com/profealvarock) · [Facebook](https://www.facebook.com/profealvarock) · [X](https://x.com/profealvarock) · [Bluesky](https://bsky.app/profile/profealvarock.bsky.social) · [YouTube](https://www.youtube.com/@profealvarock)

## 🗂️ Estructura
```
observatoriolegislativopanama/
├── index.html              # Dashboard (HTML + CSS + JS, un solo archivo)
├── scraper.py              # Scraper Playwright — extrae datos de 3 fuentes
├── requirements.txt        # Dependencias Python
├── resumen.json            # Datos procesados y cruzados (auto-generado)
├── datos.json              # Proyectos crudos con proponentes (auto-generado)
├── diputados.json          # Perfil y foto de los 71 diputados (auto-generado)
├── metricas_diputados.json # Planilla, asistencia, calificación (auto-generado)
├── historico.json          # Una foto diaria por diputado para graficar tendencias (auto-generado)
├── panama-map.svg          # Mapa base de Panamá
├── netlify.toml            # Configuración Netlify
└── .github/workflows/
    └── scraper.yml         # Actualización automática diaria (4 AM Panamá)
```

## 📡 Fuentes de datos
| Fuente | Datos |
|--------|-------|
| [sistemas.asamblea.gob.pa](https://sistemas.asamblea.gob.pa/segLegis/viewsPublico/SeguimientoLegislativo) | Proyectos legislativos, etapas, fechas |
| [espaciocivico.org/diputados](https://espaciocivico.org/diputados) | Perfil, foto, partido, provincia, suplentes |
| [espaciocivico.org/buscador/diputados-monitoreo](https://espaciocivico.org/buscador/diputados-monitoreo) | Planilla, asistencia, calificación |

## 🚀 Despliegue

### 1. Clonar y subir a GitHub
```bash
git clone https://github.com/profealvarock/observatoriolegislativopanama.git
cd observatoriolegislativopanama
# O para un fork nuevo:
git remote set-url origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

### 2. Conectar Netlify
1. Ve a [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**
2. Selecciona el repositorio
3. Build command: *(dejar vacío)*
4. Publish directory: `.`
5. Click **Deploy**

### 3. Activar GitHub Actions
Para que los datos se actualicen automáticamente:
1. Ve al repo en GitHub → **Settings** → **Actions** → **General**
2. En *Workflow permissions*, selecciona **Read and write permissions**
3. Los datos se actualizan diariamente a las **4:00 AM hora Panamá** (9:00 AM UTC)
4. Ejecución manual: **Actions** → **Actualizar datos legislativos** → **Run workflow**

### 4. Ejecutar scraper localmente
```bash
pip install -r requirements.txt
playwright install chromium
python scraper.py
```

Para regenerar solo `resumen.json` a partir de los JSON ya guardados (sin navegador ni Playwright):
```bash
python scraper.py --solo-resumen
```

## 🔄 Flujo de actualización automática
1. GitHub Actions ejecuta `scraper.py` cada día a las 4 AM Panamá
2. El scraper extrae proyectos de `sistemas.asamblea.gob.pa` y perfiles de `espaciocivico.org`
3. Genera `resumen.json`, `datos.json`, `diputados.json` y `metricas_diputados.json`, y agrega la foto del día a `historico.json`
4. Hace commit automático al repositorio
5. Netlify detecta el nuevo commit y redespliega el sitio automáticamente

Si una fuente falla (o trae muchos menos registros que la vez anterior), el scraper conserva el archivo guardado de esa fuente, lo registra en `respaldos` dentro de `resumen.json` y el dashboard muestra un aviso. El aviso (una franja bajo el encabezado) también aparece si los datos tienen 2 o más días sin actualizarse, y se vuelve rojo a partir de 7 días.

**Caché.** Netlify comprime los JSON con brotli (`resumen.json` y `datos.json` pesan ~65 KB al descargarse; `historico.json` ~9 KB). Como su ETag comprimido nunca devuelve 304, `netlify.toml` permite guardar los JSON 10 minutos en el navegador; las imágenes de `img/`, una semana.

### Histórico (`historico.json`)
Formato compacto: `{"campos": ["planilla","pleno","comisiones","calificacion","proyectos","leyes"], "snapshots": [{"fecha": "2026-10-17", "total_proyectos": …, "total_leyes": …, "diputados": {"<slug>": [valores en el orden de campos]}}]}`. Hay una foto por día (si el scraper corre dos veces, se queda la última). Si Espacio Cívico no respondió ese día, las métricas de esa foto quedan en `null` para no repetir datos viejos como si fueran nuevos.

El histórico se reconstruyó inicialmente desde las versiones de `resumen.json` guardadas en git (métricas disponibles desde el 25-may-2026). El conteo de `proyectos`/`leyes` por diputado anterior a octubre 2026 no es comparable con el actual porque cambió la forma de relacionar proponentes con diputados; por eso el sitio solo grafica las métricas de Espacio Cívico.

## 🔗 Relación proponente ↔ diputado
La Asamblea registra a los proponentes con su nombre completo (`H.D JORGE ISAAC BLOISE IGLESIAS`, `H.D.S ...` para suplentes) y Espacio Cívico con el nombre corto. `scraper.py` (`EmparejadorDiputados`) los relaciona así:
- Compara **palabras completas** (sin tildes, sin apodos entre comillas) y tolera pequeñas diferencias de ortografía (*Jhonatan / Jhonathan*).
- Los **suplentes** se asignan al diputado principal al que suplen; a los firmantes `H.D.S` se les busca primero entre los suplentes.
- Un diputado cuenta **una sola vez por proyecto**, aunque firmen él y su suplente.
- Las coincidencias ambiguas no se asignan. Los casos que no se resuelven solos se agregan a mano en `ALIAS_PROPONENTES`.
- Quien firma como `H.D.S` siempre cuenta como suplente, aunque su nombre se parezca al del principal (p. ej. *Benisio Enisio Robinson*, suplente de Benicio Robinson).
- Las firmas sin diputado asociado quedan listadas en `proponentes_sin_match` dentro de `resumen.json`. No se asignan por intuición: se agregan a `ALIAS_PROPONENTES` solo cuando hay certeza.

**Proponentes que no son diputados.** El campo de proponentes viene separado por comas, pero varias comisiones también llevan comas en su nombre (*Credenciales, Reglamento, Ética Parlamentaria y Asuntos Judiciales*). `separar_proponentes` vuelve a unir esos trozos usando la lista oficial `COMISIONES_PERMANENTES`, y cada comisión se muestra con su nombre oficial. Los nombres de ciudadanos se unifican (mayúsculas y tildes) para no contar dos veces a la misma persona.

**Partidos y provincias.** Cada proyecto se atribuye **una sola vez**, al partido y la provincia de su **autor principal** (primer firmante), igual que en la tabla de diputados; por eso los totales por partido suman lo mismo que los proyectos de diputados. Aparte, `participaciones` cuenta los proyectos en que firmó al menos un diputado del partido o provincia (como autor o co-patrocinador).

**Comisiones de cada diputado.** Espacio Cívico las publica en una sola línea separada por `|`; el scraper las separa y quita los emojis, así `comisiones_cantidad` refleja el número real.

En `resumen.json`, cada diputado incluye `proyectos` (como proponente principal), `co_patrocinios`, `proyectos_suplente` (cuántos de sus proyectos firmó su suplente) y `participaciones` (fichas en que participó con cualquier rol). La pestaña de costos usa esas `participaciones`, de modo que todas las pestañas usan la misma relación.

## 📈 Índice de efectividad legislativa
Mide la capacidad de convertir proyectos en leyes (`calcular_efectividad` en `scraper.py`; se guarda en `efectividad_ley` de cada diputado y `efectividad_meta` en `resumen.json`).
- **Tasas crudas**: autor → ley = leyes ÷ proyectos como autor principal; co-patrocinio → ley = co-patrocinados que son ley ÷ co-patrocinados.
- **Problema 1, antigüedad**: de los proyectos de jul–dic 2024 llegó a ley ~18%; de los de 2026, ~1–3%. Se corrige con **leyes esperadas** = Σ tasa de la Cámara en el semestre de cada proyecto.
- **Problema 2, muestras pequeñas**: la mitad de los diputados tiene ≤ 8 proyectos como autor. Se suaviza sumando `SUAVIZADO_LEYES` (1.5) a observadas y esperadas.
- **Índice** = (leyes + 1.5) ÷ (esperadas + 1.5) × 100 → 100 = promedio. ▲ ≥ 120 · ● 81–119 · ▼ ≤ 80. Si se esperaba < 1 ley, se marca **"pocos datos"** y al ordenar va después de los casos con evidencia.
- Se calcula aparte como autor y como co-patrocinador, cada uno con su propia tasa base (co-patrocinar tiene una tasa de éxito mayor: ~16% vs ~9%).

## 💰 Metodología — Costo Legislativo
El módulo de costo estima el gasto proporcional por proyecto:
- **Costo acumulado por diputado** = saldo de planilla publicado por Espacio Cívico + USD 7,000 (salario fijo) × meses cerrados desde julio 2024 (p. ej. con datos de octubre 2026: hasta septiembre 2026 = 27 meses)
- En el desglose anual la planilla se prorratea según los meses de cada año
- **Periodo de análisis**: julio 2024 – último mes cerrado a la **fecha de extracción** de los datos (no la fecha de hoy, para que el costo no crezca si los datos dejan de actualizarse)
- **Distribución**: costo anual ÷ proyectos en que participó ese año
- Los proyectos de **diputados suplentes** se contabilizan bajo el titular al que suplen
- Es una estimación analítica, no un costo contable exacto
