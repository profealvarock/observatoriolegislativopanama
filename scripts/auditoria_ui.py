"""Auditoría de UI del sitio: busca, en todas las secciones y en anchos de 320 a 1440 px,
  - elementos que se salen de su marco (tarjeta, botón, chip) o de la pantalla,
  - texto o cifras recortados por su contenedor,
  - letra de menos de 11 px,
  - botones y controles de menos de 32 px de alto o ancho.
Requiere Playwright (pip install playwright && python -m playwright install chromium).
Uso:  python scripts/auditoria_ui.py . [resultado.json]      (levanta un servidor local en el puerto 8790)
El resultado esperado es TOTALES con fuera=0, recortes=0 y chicas=0."""
import sys, time, subprocess, os, json, collections
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

REPO = sys.argv[1]
SALIDA = sys.argv[2] if len(sys.argv) > 2 else None
TABS = ['inicio', 'aprobacion', 'costo-vida', 'salarios', 'educacion', 'sismo', 'mineria', 'general', 'novedades',
        'diputados', 'proyectos', 'votaciones', 'monitoreo', 'partidos', 'proponentes', 'costos', 'metodologia']
ANCHOS = [320, 360, 400, 768, 1024, 1280, 1440]

JS = r"""() => {
  const MARCOS = '.card,.kpi,.portada-card,.met-card,.cv-calc-out,.ind-avisos,.data-banner,.modal,.portada-hero,.menu-grupo,.tab,.dl-btn,.map-chip,.badge,.fresh,.pill-calidad,.ind-pill,.ind-chip,.met-chip';
  const SCROLLERS = '.heat-scroll,.prop-list,.tbl-scroll,.chart-tabla-scroll,.tabs,.costo-tbl-wrap,.tbl-wrap,[style*="overflow"]';
  const vis = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const raiz = [document.querySelector('header'), document.querySelector('.menu'), document.getElementById('gs-wrap'), document.querySelector('.tab-content.active'), document.querySelector('footer')].filter(Boolean);
  const nombre = e => (e.tagName.toLowerCase() + (e.id?'#'+e.id:'') + (typeof e.className==='string'&&e.className? '.'+e.className.trim().split(/\s+/).slice(0,2).join('.') : ''));
  const ruta = e => { const p=e.closest('[id]'); return (p&&p!==e?('#'+p.id+' › '):'') + nombre(e); };
  const fuera=[], recortes=[], chicas=[], tactiles=[];
  const propioTexto = e => [...e.childNodes].some(n => n.nodeType===3 && n.textContent.trim());
  const W = document.documentElement.clientWidth;
  raiz.forEach(r => r.querySelectorAll('*').forEach(e => {
    if (!vis(e) || e.closest('svg') && e.tagName.toLowerCase()!=='svg' || e.closest('details:not([open])') ) return;
    const enScroll = e.closest(SCROLLERS);
    const rr = e.getBoundingClientRect();
    // 1) se sale de su marco
    const marco = e.parentElement && e.parentElement.closest(MARCOS);
    if (marco && !enScroll && !e.closest('canvas')) {
      const mr = marco.getBoundingClientRect();
      if (rr.right > mr.right + 1.5 || rr.left < mr.left - 1.5) fuera.push({el: ruta(e), marco: nombre(marco), exceso: Math.round(Math.max(rr.right-mr.right, mr.left-rr.left)), texto:(e.innerText||'').trim().slice(0,40)});
    }
    // 1b) se sale de la pantalla
    if (!enScroll && rr.right > W + 1.5 && !e.closest('.tabs-wrap')) fuera.push({el: ruta(e), marco:'VIEWPORT', exceso: Math.round(rr.right-W), texto:(e.innerText||'').trim().slice(0,40)});
    // 2) texto recortado por su propio contenedor
    const s = getComputedStyle(e);
    const hoja = propioTexto(e);
    if (!enScroll && !e.classList.contains('sr-only') && s.display!=='inline' && hoja && e.scrollWidth > e.clientWidth + 1 && e.tagName!=='SELECT' && e.tagName!=='INPUT') recortes.push({el: ruta(e), texto:(e.innerText||'').trim().slice(0,40), sw:e.scrollWidth, cw:e.clientWidth});
    // 3) letra pequeña (texto propio)
    const propio = [...e.childNodes].some(n => n.nodeType===3 && n.textContent.trim());
    if (propio && parseFloat(s.fontSize) < 11 && !e.classList.contains('sr-only')) chicas.push({el: ruta(e), px: parseFloat(s.fontSize).toFixed(1), texto:(e.innerText||'').trim().slice(0,30)});
    // 4) áreas táctiles
    if (e.matches('button,a.dl-btn,.tab,.menu-grupo,.map-chip,select,input') && (rr.height < 32 || rr.width < 32)) tactiles.push({el: ruta(e), h: Math.round(rr.height), w: Math.round(rr.width), texto:(e.innerText||e.value||'').trim().slice(0,25)});
  }));
  return {scroll: document.documentElement.scrollWidth, W, fuera, recortes, chicas, tactiles};
}"""

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8790', '--bind', '127.0.0.1'], cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
res = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for w in ANCHOS:
            ctx = b.new_context(viewport={'width': w, 'height': 900}, color_scheme='dark')
            pg = ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto('http://127.0.0.1:8790/', wait_until='networkidle'); pg.wait_for_timeout(1500)
            for t in TABS:
                pg.evaluate(f"location.hash='{t}'"); pg.wait_for_timeout(1800 if t in ('votaciones','costos','diputados','proyectos','monitoreo') else 1100)
                r = pg.evaluate(JS)
                r.update({'ancho': w, 'tab': t})
                res.append(r)
            if errs: print('errores', w, errs[:3])
            ctx.close()
        b.close()
finally:
    srv.terminate()

tot = collections.Counter()
for r in res:
    n = (len(r['fuera']), len(r['recortes']), len(r['chicas']), len(r['tactiles']))
    tot['fuera'] += n[0]; tot['recortes'] += n[1]; tot['chicas'] += n[2]; tot['tactiles'] += n[3]
    if r['scroll'] > r['W'] or n[0] or n[1]:
        print(f"{r['ancho']:>5} {r['tab']:<12} scroll={r['scroll']}/{r['W']} fuera={n[0]} recortes={n[1]} chicas={n[2]} tactiles={n[3]}")
        vistos=set()
        for x in r['fuera'][:6] + r['recortes'][:4]:
            k=(x['el'],x.get('marco'))
            if k in vistos: continue
            vistos.add(k); print('        ', x)
print('TOTALES', dict(tot))
g = collections.defaultdict(set)
for r in res:
    for x in r['fuera']:
        g[('FUERA', x['el'].split(' › ')[0] + ' › ' + x['el'].split(' › ')[-1].split('.')[0] + '.' + '.'.join(x['el'].split(' › ')[-1].split('.')[1:2]), x['marco'][:30])].add(r['ancho'])
    for x in r['recortes']:
        g[('RECORTE', x['el'], x['texto'][:25])].add(r['ancho'])
for k, v in sorted(g.items(), key=lambda kv: (kv[0][0], -len(kv[1]))):
    print(k, sorted(v))
# resumen de letra pequeña y táctiles por selector
ch = collections.Counter((x['el'].split(' › ')[-1], x['px']) for r in res if r['ancho'] == 400 for x in r['chicas'])
print('LETRA <11px (400px), top:', ch.most_common(25))
ta = collections.Counter((x['el'].split(' › ')[-1], x['h']) for r in res if r['ancho'] == 400 for x in r['tactiles'])
print('TÁCTILES <32px (400px), top:', ta.most_common(20))
if SALIDA:
    json.dump(res, open(SALIDA, 'w', encoding='utf-8'), ensure_ascii=False)
