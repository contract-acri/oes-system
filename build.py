import os
SRC='src'; OUT='out'
URL='https://script.google.com/macros/s/AKfycbzE-HjXSg1EomncP1zQD-U-NPfv01q-28Uz7pyn-TrHLFfZ7ukxxXuNFs0x97KBMI27WA/exec'
coe=open(f'{SRC}/coe.html').read()
def between(s,a,b):
  i=s.index(a); j=s.index(b,i); return s[i:j]
css=between(coe,'<style>\n','</style>')[len('<style>\n'):]
parts={'/*@@CSS@@*/':css,
 '//@@HELPERS@@':between(coe,"const $ = s =>","/* ============================ AUTH"),
 '//@@AUTH@@':between(coe,"/* ============================ AUTH","/* ============================ SHELL"),
 '//@@MARKING@@':between(coe,"function answerCard(","/* ============================ LIVE PROCTOR"),
 '//@@LIVEPOLL@@':between(coe,"let ZOOM = null","/* ============================ START")}
for name in ['review','control','papers']:
  r=open(f'{SRC}/{name}.src.html').read()
  for k,v in parts.items(): r=r.replace(k,v)
  assert '@@' not in r, name
  open(f'{SRC}/{name}.html','w').write(r)
os.makedirs(OUT,exist_ok=True)
em=open('emblem.b64').read(); full=open('full.b64').read()
for f in ['exam.html','coe.html','review.html','control.html','papers.html']:
  s=open(f'{SRC}/{f}').read(); assert s.count('__EMBLEM__')==1
  s=s.replace('__EMBLEM__',em).replace("window.ACRI_API_URL || 'PASTE_YOUR_WEB_APP_EXEC_URL_HERE'",f"window.ACRI_API_URL || '{URL}'")
  assert URL in s
  open(f'{OUT}/{f}','w').write(s)
g=open(f'{SRC}/Code.gs').read(); assert g.count('__LOGO_FULL__')==1
built_gs=g.replace('__LOGO_FULL__',full); open(f'{OUT}/Code.gs','w').write(built_gs); os.makedirs('apps-script',exist_ok=True); open('apps-script/Code.gs','w').write(built_gs)
print('built')

# ---------- Cloudflare Pages site (one domain, one folder per portal) ----------
import shutil, base64, json
SITE = 'site'
ROUTES = {'exam.html': 'index.html', 'coe.html': 'admin/index.html', 'review.html': 'review/index.html',
          'control.html': 'control/index.html', 'papers.html': 'papers/index.html'}
if os.path.isdir(SITE): shutil.rmtree(SITE)
for src, dst in ROUTES.items():
  p = os.path.join(SITE, dst); os.makedirs(os.path.dirname(p), exist_ok=True)
  shutil.copy(f'{OUT}/{src}', p)
shutil.copytree('static', SITE, dirs_exist_ok=True)
for root, _, files in os.walk(SITE):
  for f in files:
    if f.endswith('.html'):
      p = os.path.join(root, f); h = open(p).read()
      if '__EMBLEM__' in h: open(p, 'w').write(h.replace('__EMBLEM__', em))
open(f'{SITE}/favicon.png', 'wb').write(base64.b64decode(em.split(',', 1)[1]))
open(f'{SITE}/config.js', 'w').write(
  "/* ACRI OES — the one setting every page reads.\n"
  "   If you ever make a NEW Apps Script deployment, paste its /exec URL here and commit. */\n"
  f"window.ACRI_API_URL = {json.dumps(URL)};\n")
print('site built')
