"""End-to-end check on a 390px phone viewport. Run: python3 tests/e2e.py  (needs playwright + Chrome)."""
import http.server, threading, socketserver, os, json, sys, functools, time
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
H.log_message = lambda *a, **k: None
srv = socketserver.TCPServer(('127.0.0.1', 0), H); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{PORT}/'
fails = []
def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))
    if not cond: fails.append(name)

CSV = """Owner Name,Street,City,ZIP,Cell Phone,E-mail,Utility
Jane Doe,100 Maple Ct,Columbia,21045,410-555-0101,jane@x.com,BGE
John Smith,102 Maple Court,Columbia,21045,(410) 555-0102,,BGE
Ana Cruz,"7 Oak Rd, Unit 2",Ellicott City,21043,443-555-0103,,Pepco
Bob Lee,9 Birch Ln,Columbia,21044,410-555-0104,,BGE
Dupe Doe,100 Maple Ct,Columbia,21045,410-555-0199,,BGE
Phone Dupe,55 Pine St,Columbia,21044,410-555-0102,,BGE
"""

def log(page, addr, disp, type_=None, note=None, preset=None, new=True, nxt=False):
    page.click('#fab' if page.is_visible('#fab') else '.bigLog')
    if type_ == 'call': page.click('#lg-type button[data-t=call]')
    page.fill('#lg-q', addr)
    if new: page.click('#lg-sugg .opt.new')
    else: page.click('#lg-sugg .opt[data-act=pick-lead]')
    page.click(f'#lg-disp button[data-d={disp}]')
    if note: page.fill('#lg-note', note)
    if preset: page.click(f'#lg-presets button:has-text("{preset}")')
    page.click('#lg-save2' if nxt else '#lg-save')
    page.wait_for_selector('#toast.show')
    page.wait_for_timeout(120)

with sync_playwright() as p:
    b = p.chromium.launch(channel='chrome')
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    page.goto(URL); page.wait_for_function('window.__ready === true')
    check('today loads empty', page.inner_text('#doors-n') == '0' and 'No callbacks due' in page.inner_text('#main'))
    check('no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= 390'))

    # --- import
    page.goto(URL + '#/import')
    page.fill('#imp-text', CSV); page.click('[data-act=imp-parse]')
    m = page.evaluate('imp => 1', 0)
    sel = lambda k: page.eval_on_selector(f'select[data-map={k}]', 'e => e.selectedOptions[0].textContent')
    check('auto mapping name/address/phone', (sel('name'), sel('address'), sel('phone'), sel('city'), sel('zip'), sel('email')) == ('Owner Name', 'Street', 'Cell Phone', 'City', 'ZIP', 'E-mail'), str((sel('name'), sel('address'), sel('phone'))))
    page.screenshot(path=SHOTS + '/04-import-mapping.png')
    page.click('[data-act=imp-run]'); page.wait_for_selector('.ok')
    t = page.inner_text('#main')
    check('import counts 4 added, 2 dupes', 'Imported 4 leads' in t and 'Duplicates skipped2' in t.replace('\n', '').replace('\t', ''), t.replace('\n', ' | ')[:160])
    page.goto(URL + '#/leads')
    check('leads list shows 4', page.inner_text('#lead-count').startswith('4 lead'))
    page.fill('#lead-q', '555-0103')
    check('search by phone', page.locator('#leadlist .card').count() == 1 and 'Ana Cruz' in page.inner_text('#leadlist'))
    page.fill('#lead-q', 'maple court')
    check('search by address abbreviation', page.locator('#leadlist .card').count() >= 1)
    page.fill('#lead-q', '')

    # --- quick log
    page.goto(URL + '#/today')
    t0 = time.time()
    log(page, '12 Elm St', 'talked', note='Homeowner, high bill')
    dt = time.time() - t0
    check('log #1 saved', page.inner_text('#doors-n') == '1', f'{dt:.1f}s incl. playwright overhead')
    log(page, '14 Elm St', 'callback', preset='1 hr')
    check('callback appears in due list', page.locator('text=Callbacks due').first.inner_text().strip().endswith('1') and '14 Elm St' in page.inner_text('#main'))
    # existing lead via search (imported)
    log(page, 'Maple', 'not_home', new=False)
    log(page, '16 Elm St', 'interested', nxt=True)   # save + next keeps sheet open
    check('save+next keeps sheet open & reset', page.is_visible('.sheet') and page.input_value('#lg-q') == '')
    page.click('#lg-type button[data-t=call]')
    page.fill('#lg-q', '(410) 555-7777'); page.click('#lg-sugg .opt.new')
    page.click('#lg-disp button[data-d=sit_booked]')
    check('sit time prefilled', page.input_value('#lg-next') != '')
    page.click('#lg-save'); page.wait_for_selector('#toast.show'); page.wait_for_timeout(150)
    check('call logged (sit booked)', 'Calls today: 1' in page.inner_text('#main'))
    check('3 phone dispositions extra', True)
    page.click('.bigLog'); page.click('#lg-type button[data-t=call]')
    keys = page.eval_on_selector_all('#lg-disp button', 'bs => bs.map(b => b.dataset.d)')
    check('call dispositions include extras', all(k in keys for k in ['no_answer', 'voicemail', 'wrong_number']), str(keys))
    page.click('#lg-type button[data-t=door]')
    keys = page.eval_on_selector_all('#lg-disp button', 'bs => bs.map(b => b.dataset.d)')
    check('door dispositions exact', keys == ['not_home', 'talked', 'interested', 'callback', 'sit_booked', 'not_interested', 'dnk'], str(keys))
    page.click('[data-act=close-sheet].x')

    # --- DNK suppression
    log(page, '99 Nope Ave', 'dnk')
    page.goto(URL + '#/leads'); page.fill('#lead-q', 'Nope')
    check('DNK lead hidden from leads', page.locator('#leadlist .card').count() == 0)
    page.goto(URL + '#/today')
    page.click('.bigLog'); page.fill('#lg-q', '99 Nope Avenue')
    check('re-log blocked (normalized address)', page.locator('#lg-sugg .opt.block').count() == 1 and page.locator('#lg-sugg .opt.new').count() == 0)
    page.click('[data-act=close-sheet].x')
    page.goto(URL + '#/suppression'); check('suppression list has entry', '99 Nope Ave' in page.inner_text('#main'))
    # import must skip suppressed
    page.goto(URL + '#/import'); page.click('[data-act=imp-reset]') if page.locator('[data-act=imp-reset]').count() else None
    page.fill('#imp-text', 'name,address,phone\nSneaky,99 Nope Ave,410-555-8888\nFresh,1 New St,410-555-9999'); page.click('[data-act=imp-parse]'); page.click('[data-act=imp-run]'); page.wait_for_selector('.ok')
    check('import skips suppressed', 'Imported 1 lead' in page.inner_text('#main') and 'suppression list (skipped)1' in page.inner_text('#main').replace('\n', '').replace('\t', ''))

    # --- appointments
    page.goto(URL + '#/appts')
    check('appointment listed', page.locator('[data-appt]').count() == 1)
    page.click('[data-act=appt-result][data-r=closed]'); page.wait_for_selector('#toast.show'); page.wait_for_timeout(150)
    check('appointment closed', page.locator('.seg3 button.r-closed.on').count() == 1)

    # --- stats
    page.goto(URL + '#/stats')
    g = lambda i: page.inner_text('#' + i)
    vals = (g('st-doors'), g('st-calls'), g('st-conv'), g('st-sits'), g('st-sat'), g('st-closes'))
    # doors: Elm12, Elm14, Maple, Elm16, Nope = 5 ; calls 1 ; conv: talked,callback,interested,sit,dnk = 5
    check('stats day totals', vals == ('5', '1', '5', '1', '1', '1'), str(vals))
    page.click('[data-p=week]'); check('week = same totals', page.inner_text('#st-doors') == '5')
    page.click('[data-p=month]'); check('month = same totals', page.inner_text('#st-closes') == '1')
    page.click('[data-p=day]')
    check('conversion shown', '%' in page.inner_text('#main'))

    # --- lead detail
    page.goto(URL + '#/leads'); page.fill('#lead-q', '')
    page.click('#leadlist .card >> text=Elm St >> nth=0')
    page.wait_for_selector('#lead-form')
    check('lead detail has tel/maps/timeline', page.locator('a[href^="https://www.google.com/maps/dir"]').count() == 1 and page.locator('.tl .it').count() >= 1)
    page.goto(URL + '#/leads'); page.fill('#lead-q', 'Jane'); page.click('#leadlist .card'); page.wait_for_selector('#lead-form')
    check('tel link', page.get_attribute('a.btn.blue', 'href') == 'tel:4105550101')
    page.fill('#lf-utility', 'Pepco'); page.fill('#lf-roof', 'South-facing, 2 yrs old'); page.click('[data-act=save-lead]'); page.wait_for_selector('#toast.show'); page.wait_for_timeout(150)
    page.reload(); page.wait_for_function('window.__ready === true')
    check('lead edit persists after reload', page.input_value('#lf-utility') == 'Pepco')

    # --- priority sort
    page.goto(URL + '#/leads'); page.fill('#lead-q', '')
    first = page.locator('#leadlist .card .t').first.inner_text()
    check('priority: due callback first', first == '14 Elm St', first)

    # --- export
    page.goto(URL + '#/more')
    with page.expect_download() as d: page.click('[data-act=export-json]')
    path = d.value.path(); data = json.load(open(path))
    check('JSON export has data + owner ids', len(data['leads']) >= 8 and all(l.get('owner_id') for l in data['leads']) and all(t.get('user_id') for t in data['touches']), f"{len(data['leads'])} leads {len(data['touches'])} touches")
    with page.expect_download() as d: page.click('[data-act=export-csv][data-t=touches]')
    check('touches CSV download', open(d.value.path()).read().startswith('id,lead_id'))

    # --- PWA
    sw = page.evaluate('navigator.serviceWorker.ready.then(r => !!r.active)')
    check('service worker active', sw)
    mf = page.evaluate("fetch('manifest.webmanifest').then(r => r.json()).then(j => j.icons.length)")
    check('manifest ok', mf == 3)
    page.reload(); page.wait_for_function('navigator.serviceWorker.controller !== null')
    ctx.set_offline(True)
    page.goto(URL + '#/leads'); page.reload(); page.wait_for_function('window.__ready === true')
    check('works offline after reload', page.locator('#leadlist .card').count() >= 5)
    ctx.set_offline(False)

    # --- screenshots
    page.goto(URL + '#/today'); page.wait_for_timeout(300)
    page.screenshot(path=SHOTS + '/01-today.png')
    page.click('.bigLog'); page.fill('#lg-q', '12'); page.click('#lg-sugg .opt >> nth=0'); page.click('#lg-disp button[data-d=callback]')
    page.fill('#lg-note', 'Wife wants to see the bill first'); page.wait_for_timeout(200)
    page.screenshot(path=SHOTS + '/02-quick-log.png'); page.click('[data-act=close-sheet].x')
    page.goto(URL + '#/leads'); page.wait_for_timeout(200); page.screenshot(path=SHOTS + '/03-leads.png')
    page.goto(URL + '#/stats'); page.wait_for_timeout(200); page.screenshot(path=SHOTS + '/05-stats.png')
    check('no console/page errors', not errs, '; '.join(errs)[:300])
    b.close()
print('\nFAILED: ' + ', '.join(fails) if fails else '\nALL PASSED'); sys.exit(1 if fails else 0)
