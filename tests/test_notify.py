#!/usr/bin/env python3
"""Simula il robot delle notifiche (tools/notify.py) senza rete: Firestore e FCM finti, orologio controllato.
Uso: python3 tests/test_notify.py"""
import datetime as dt, importlib, json, os, sys, types, copy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

# ---- finti moduli google
class FakeResp:
    def __init__(self, code, data=None, text=''):
        self.status_code, self._d, self.text = code, data or {}, text or json.dumps(data or {})
        self.ok = code < 400
    def json(self): return self._d
    def raise_for_status(self):
        if not self.ok: raise RuntimeError('HTTP %d' % self.status_code)

DB, SENT = {}, []
def from_fs(v):
    import notify; return notify.to_py(v)

class FakeSession:
    def __init__(self, creds): pass
    def _path(self, url): return url.split('/documents/', 1)[1]
    def get(self, url, params=None, timeout=None):
        p = self._path(url)
        if p.count('/') % 2 == 0:  # collezione
            import notify
            docs = [{'name': 'x/' + k, 'fields': {f: notify.to_fs(v) for f, v in d.items()}} for k, d in DB.items() if k.rsplit('/', 1)[0] == p]
            return FakeResp(200, {'documents': docs})
        if p not in DB: return FakeResp(404)
        import notify
        return FakeResp(200, {'fields': {f: notify.to_fs(v) for f, v in DB[p].items()}})
    def patch(self, url, params=None, json=None, timeout=None):
        import notify
        p = self._path(url); d = DB.setdefault(p, {})
        for k, v in json['fields'].items(): d[k] = notify.to_py(v)
        return FakeResp(200)
    def post(self, url, json=None, timeout=None):
        m = json['message']; SENT.append((TOKOWNER.get(m['token']), m['data']))
        if m['token'].startswith('dead'): return FakeResp(404, text='UNREGISTERED')
        return FakeResp(200)

g = types.ModuleType('google'); oa = types.ModuleType('google.oauth2'); sa = types.ModuleType('google.oauth2.service_account')
sa.Credentials = types.SimpleNamespace(from_service_account_info=lambda info, scopes=None: object())
au = types.ModuleType('google.auth'); tr = types.ModuleType('google.auth.transport'); rq = types.ModuleType('google.auth.transport.requests')
rq.AuthorizedSession = FakeSession
for n, m in {'google': g, 'google.oauth2': oa, 'google.oauth2.service_account': sa, 'google.auth': au, 'google.auth.transport': tr, 'google.auth.transport.requests': rq}.items():
    sys.modules[n] = m
oa.service_account = sa
os.environ['FIREBASE_SA'] = json.dumps({'project_id': 'rimineser'})
import notify

TOKOWNER = {}
def base(now):
    DB.clear(); SENT.clear(); TOKOWNER.clear()
    ppl = {'admin_g': ('giocatore', True), 'm1': ('mister', True), 'c1': ('capitano', True), 'p2': ('giocatore', True),
           'p3': ('giocatore', True), 'p4': ('giocatore', True), 'f1': ('pubblico', True), 'pend': ('giocatore', False)}
    DB['config/team'] = {'coaches': ['admin']}
    for k, (c, a) in ppl.items(): DB['players/' + k] = {'name': k, 'cat': c, 'approved': a}
    DB['players/rej'] = {'name': 'rej', 'cat': 'giocatore', 'approved': False, 'rejected': True}
    for u in ['admin', 'm1', 'c1', 'p2', 'p3', 'p4', 'f1', 'pend', 'rej']:
        DB['tokens/' + u] = {'tokens': {'tok-' + u: 1}, 'prefs': {}}; TOKOWNER['tok-' + u] = u
    DB['robot/state'] = {'requests': ['pend', 'rej'], 'uisp': 'x', 'esempi': ['promemoria-esempio-4']}
    notify.now_rome = lambda: now
    notify.league = lambda: None

def run():
    SENT.clear(); notify.main(); return list(SENT)
def who(sent, title_part=''):
    return sorted({u for u, d in sent if title_part in d['title']})

R = []
def check(c, name, det=''):
    R.append((bool(c), name, det))

TZ = notify.TZ
NOW = dt.datetime(2026, 11, 17, 14, 0, tzinfo=TZ)

# 1. nuova richiesta di iscrizione: solo admin, una volta
base(NOW)
DB['players/nuovo'] = {'name': 'Mario Rossi', 'cat': 'dirigente', 'approved': False}
s = run()
check(who(s, 'Nuova richiesta') == ['admin'], 'Richiesta iscrizione: notifica solo all\'amministratore', s)
check(any('Mario Rossi (Dirigente)' in d['body'] for u, d in s), 'Richiesta iscrizione: testo con nome e categoria', s)
check(len(s) == 1, 'Richiesta iscrizione: nessun\'altra notifica', s)
s = run()
check(not who(s, 'Nuova richiesta'), 'Richiesta iscrizione: non ripetuta al giro dopo', s)
# richiesta già approvata prima del robot
base(NOW); DB['players/veloce'] = {'name': 'Veloce', 'cat': 'giocatore', 'approved': True}
check(not who(run(), 'Nuova richiesta'), 'Richiesta già approvata prima del robot: nessun avviso (comportamento atteso)')
# admin senza notifiche attive
base(NOW); del DB['tokens/admin']; DB['players/nuovo2'] = {'name': 'N2', 'cat': 'giocatore', 'approved': False}
s = run(); check(not s, 'Richiesta con admin senza notifiche attive: non avvisa nessun altro', s)
# richieste per categorie nuove
base(NOW); DB['players/n3'] = {'name': 'Sofia', 'cat': 'social', 'approved': False}
s = run(); check(any('Social media manager' in d['body'] for u, d in s), 'Richiesta: categoria Social media manager scritta per esteso', s)

# 2. coda outbox
base(NOW)
DB['outbox/a'] = {'kind': 'post', 'title': '📣 Nuova comunicazione', 'body': 'ciao', 'sent': False, 'createdAt': 1}
s = run()
check(who(s) == ['admin', 'c1', 'f1', 'm1', 'p2', 'p3', 'p4'], 'Comunicazione: a tutti gli approvati, non a in attesa/rifiutati', who(s))
check(DB['outbox/a']['sent'] is True, 'Comunicazione: segnata come inviata')
check(not run(), 'Comunicazione: non reinviata')
base(NOW); DB['tokens/p2']['prefs'] = {'posts': False}
DB['outbox/a'] = {'kind': 'poll', 'title': 'Sondaggio', 'sent': False}
check('p2' not in who(run()), 'Sondaggio: rispetta chi ha disattivato le comunicazioni')
base(NOW); DB['outbox/t'] = {'kind': 'test', 'title': 'Prova', 'sent': False}
check(who(run()) == ['admin'], 'Notifica di prova: solo amministratore')
base(NOW); del DB['tokens/admin']; DB['outbox/t'] = {'kind': 'test', 'title': 'Prova', 'sent': False}
check(not run(), 'Notifica di prova senza telefono admin: non va a tutta la squadra')
base(NOW)
DB['events/ev'] = {'type': 'partita', 'date': '2026-11-25', 'time': '21:00', 'opponent': 'X'}
DB['rsvp/p2'] = {'answers': {'ev': 'no'}}; DB['rsvp/c1'] = {'answers': {'ev': 'si'}}; DB['rsvp/admin_g'] = {'answers': {'ev': 'forse'}}
DB['outbox/r'] = {'kind': 'remind', 'eventId': 'ev', 'title': '⏰ promemoria', 'sent': False}
check(who(run(), 'promemoria') == ['f1', 'm1', 'p3', 'p4'], 'Promemoria manuale: solo a chi non ha risposto (admin risponde col profilo Giacomo)')

# 3. promemoria partite 24/12/2 ore
def match_setup(now, answers):
    base(now)
    DB['events/ev'] = {'type': 'partita', 'date': '2026-11-20', 'time': '21:00', 'opponent': 'Oasi', 'location': 'Riccione'}
    for u, a in answers.items(): DB['rsvp/' + u] = {'answers': {'ev': a}}
ANS = {'p2': 'no', 'c1': 'si', 'm1': 'forse', 'admin_g': 'si'}
match_setup(dt.datetime(2026, 11, 19, 20, 0, tzinfo=TZ), ANS)  # 25 ore prima
check(not who(run(), 'Oasi'), 'Partita: 25 ore prima nessun promemoria')
notify.now_rome = lambda: dt.datetime(2026, 11, 19, 21, 3, tzinfo=TZ)
s = run()
check('Domani' in (s[0][1]['title'] if s else ''), 'Partita: 24 ore prima arriva "Domani"', s[:1])
check(who(s, 'Oasi') == ['admin', 'c1', 'f1', 'm1', 'p3', 'p4'], 'Partita 24h: a presenti/forse e senza risposta, mai agli assenti', who(s))
check(all('Non hai ancora risposto' in d['body'] for u, d in s if u in ('p3', 'p4', 'f1')) and all('Ci vediamo' in d['body'] for u, d in s if u in ('c1', 'm1', 'admin')), 'Partita 24h: testo diverso per chi non ha risposto')
check(not run(), 'Partita 24h: non ripetuto')
notify.now_rome = lambda: dt.datetime(2026, 11, 20, 9, 5, tzinfo=TZ)
s = run(); check(s and 'Tra 12 ore' in s[0][1]['title'], 'Partita: promemoria 12 ore prima')
notify.now_rome = lambda: dt.datetime(2026, 11, 20, 19, 5, tzinfo=TZ)
s = run(); check(s and 'Tra 2 ore' in s[0][1]['title'] and 'p2' not in who(s), 'Partita: promemoria 2 ore prima (non agli assenti)')
notify.now_rome = lambda: dt.datetime(2026, 11, 20, 22, 0, tzinfo=TZ)
check(not run(), 'Partita iniziata: nessun promemoria')
# robot in ritardo: salta dalle 30 ore alle 1.5 ore prima -> solo il più vicino
match_setup(dt.datetime(2026, 11, 20, 19, 30, tzinfo=TZ), {})
s = run(); check(len({d['title'] for u, d in s}) == 1 and 'Tra 2 ore' in s[0][1]['title'], 'Robot in ritardo: manda solo il promemoria più vicino, non tre di fila', [d['title'] for u, d in s][:3])
check(not run(), 'Robot in ritardo: poi niente doppioni')
# promemoria partite: scelta separata 24/12/2 ore
match_setup(dt.datetime(2026, 11, 19, 21, 3, tzinfo=TZ), {})
DB['tokens/p2']['prefs'] = {'r24': False}; DB['tokens/p3']['prefs'] = {'remind': False}; DB['tokens/p4']['prefs'] = {'remind': False, 'r24': True}
s = run(); check('p2' not in who(s) and 'p3' not in who(s) and 'p4' in who(s), 'Promemoria 24h: scelta separata rispettata', who(s))
notify.now_rome = lambda: dt.datetime(2026, 11, 20, 9, 5, tzinfo=TZ)
s = run(); check('p2' in who(s) and 'p3' not in who(s) and 'p4' not in who(s), 'Promemoria 12h: chi ha tolto solo il 24h lo riceve', who(s))
# allenamento
base(dt.datetime(2026, 11, 18, 11, 0, tzinfo=TZ))
DB['events/tr'] = {'type': 'allenamento', 'date': '2026-11-19', 'time': '20:30'}
DB['rsvp/p2'] = {'answers': {'tr': 'si'}}
check(not run(), 'Allenamento: prima delle 12 del giorno prima niente')
notify.now_rome = lambda: dt.datetime(2026, 11, 18, 12, 10, tzinfo=TZ)
s = run(); check(who(s, 'Domani') == ['admin', 'c1', 'f1', 'm1', 'p3', 'p4'], 'Allenamento: dalle 12 del giorno prima solo a chi non ha risposto', who(s))
check(not run(), 'Allenamento: non ripetuto')
# token scaduto viene pulito
base(NOW); DB['tokens/p3'] = {'tokens': {'dead-1': 1, 'tok-p3': 2}}; TOKOWNER['dead-1'] = 'p3'
DB['outbox/a'] = {'kind': 'post', 'title': 'x', 'sent': False}
run(); check(list(DB['tokens/p3']['tokens']) == ['tok-p3'], 'Telefono non più valido: rimosso, l\'altro resta', DB['tokens/p3'])

# robot Cloudflare vivo: la riserva su GitHub non invia niente e copia il registro
import time
base(NOW); DB['outbox/a'] = {'kind': 'post', 'title': 'x', 'sent': False}
DB['robot/state']['workerAt'] = int(time.time() * 1000) - 60000
DB['robot/log'] = {'lines': ['2026-11-17 14:00:01 · ping · Coda: "x" → 7 telefoni']}
check(not run() and DB['outbox/a']['sent'] is False, 'Worker vivo: la riserva GitHub non invia')
check(DB['robot/state'].get('logShown', '').startswith('2026-11-17 14:00:01'), 'Worker vivo: registro copiato una volta')
DB['robot/state']['workerAt'] = int(time.time() * 1000) - 10 * 60000
check(who(run()) == ['admin', 'c1', 'f1', 'm1', 'p2', 'p3', 'p4'], 'Worker fermo da 10 minuti: la riserva GitHub invia lei')

bad = [r for r in R if not r[0]]
for r in bad: print('FALLITO', r[1], '->', str(r[2])[:300])
print('Robot notifiche: %d/%d controlli superati' % (len(R) - len(bad), len(R)))
sys.exit(1 if bad else 0)
