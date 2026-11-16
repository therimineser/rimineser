#!/usr/bin/env python3
"""Robot delle notifiche push dell'app The Rimineser F.P.

Gira su GitHub Actions (.github/workflows/notifiche.yml):
- subito, quando il Mister pubblica qualcosa (l'app sveglia il robot);
- ogni 15 minuti, per sicurezza e per i promemoria;
- dopo ogni nuovo comunicato UISP.

Cosa fa:
1. invia le notifiche messe in coda dall'app del Mister (collezione "outbox");
2. il giorno prima di partite e allenamenti avvisa chi non ha ancora risposto alle presenze;
3. quando il robot UISP ha letto un comunicato nuovo, avvisa tutti.

Serve il segreto FIREBASE_SA (chiave dell'account di servizio Firebase, file JSON).
"""
import concurrent.futures as cf
import datetime as dt
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEAGUE = os.path.join(ROOT, 'docs', 'campionato.json')
TZ = None
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/Rome')
except Exception:
    pass
REMIND_FROM_HOUR = 12      # il giorno prima, dalle 12 in poi
PREF_OF = {'post': 'posts', 'poll': 'posts', 'lineup': 'lineup', 'remind': 'remind', 'uisp': 'uisp', 'test': None}


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------ Firestore REST
def to_py(v):
    if 'stringValue' in v: return v['stringValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return float(v['doubleValue'])
    if 'booleanValue' in v: return v['booleanValue']
    if 'nullValue' in v: return None
    if 'timestampValue' in v: return v['timestampValue']
    if 'mapValue' in v: return {k: to_py(x) for k, x in v['mapValue'].get('fields', {}).items()}
    if 'arrayValue' in v: return [to_py(x) for x in v['arrayValue'].get('values', [])]
    return None


def to_fs(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_fs(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)): return {'arrayValue': {'values': [to_fs(x) for x in v]}}
    return {'stringValue': str(v)}


class Store:
    def __init__(self, session, project):
        self.s, self.base = session, 'https://firestore.googleapis.com/v1/projects/%s/databases/(default)/documents' % project

    def list(self, col):
        out, token = {}, None
        while True:
            r = self.s.get('%s/%s' % (self.base, col), params={'pageSize': 300, **({'pageToken': token} if token else {})}, timeout=30)
            r.raise_for_status()
            j = r.json()
            for d in j.get('documents', []):
                out[d['name'].rsplit('/', 1)[-1]] = {k: to_py(v) for k, v in d.get('fields', {}).items()}
            token = j.get('nextPageToken')
            if not token:
                return out

    def get(self, path):
        r = self.s.get('%s/%s' % (self.base, path), timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return {k: to_py(v) for k, v in r.json().get('fields', {}).items()}

    def patch(self, path, data):
        params = [('updateMask.fieldPaths', '`%s`' % k if not k.replace('_', '').isalnum() else k) for k in data]
        r = self.s.patch('%s/%s' % (self.base, path), params=params, json={'fields': {k: to_fs(v) for k, v in data.items()}}, timeout=30)
        r.raise_for_status()


# ------------------------------------------------------------ logica
def now_rome():
    return dt.datetime.now(TZ) if TZ else dt.datetime.utcnow() + dt.timedelta(hours=1)


def norm(s):
    return ''.join(c for c in str(s).upper() if c.isalnum())


def league():
    try:
        with open(LEAGUE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def all_events(fs_events, L):
    """Eventi dell'app + nostre partite UISP (stessa logica dell'app)."""
    ev = {k: dict(v, id=k) for k, v in fs_events.items()}
    if L:
        us = norm(L.get('team', ''))
        for r in L.get('rounds', []):
            for m in r.get('matches', []):
                home = norm(m['home']) == us
                if not home and norm(m['away']) != us or not m.get('date'):
                    continue
                eid = 'uisp-%s' % r['n']
                base = ev.get(eid, {})
                ev[eid] = dict(base, id=eid, type='partita', date=m['date'], time=m.get('time', ''),
                               opponent=m['away'] if home else m['home'], location=('Campo ' + m['field']) if m.get('field') else base.get('location', ''))
    return ev


def ev_title(e):
    return ('vs ' + (e.get('opponent') or 'avversario')) if e.get('type') == 'partita' else 'Allenamento'


class Sender:
    def __init__(self, session, project, store, tokens_docs):
        self.s, self.url, self.store, self.docs = session, 'https://fcm.googleapis.com/v1/projects/%s/messages:send' % project, store, tokens_docs
        self.dead = {}
        self.sent = 0

    def _one(self, uid, tok, msg):
        body = {'message': {'token': tok, 'data': {k: str(v) for k, v in msg.items()},
                            'webpush': {'headers': {'Urgency': 'high', 'TTL': '86400'}}}}
        r = self.s.post(self.url, json=body, timeout=30)
        if r.status_code in (400, 404) and ('UNREGISTERED' in r.text or 'INVALID_ARGUMENT' in r.text and 'token' in r.text.lower()):
            self.dead.setdefault(uid, set()).add(tok)
        elif r.ok:
            self.sent += 1
        else:
            log('  invio non riuscito', r.status_code, r.text[:200])

    def send(self, uids, msg, pref):
        jobs = []
        for uid in uids:
            d = self.docs.get(uid) or {}
            if pref and (d.get('prefs') or {}).get(pref) is False:
                continue
            for tok in (d.get('tokens') or {}):
                jobs.append((uid, tok))
        with cf.ThreadPoolExecutor(max_workers=16) as ex:
            list(ex.map(lambda j: self._one(j[0], j[1], msg), jobs))
        return len(jobs)

    def cleanup(self):
        for uid, toks in self.dead.items():
            keep = {t: v for t, v in (self.docs.get(uid, {}).get('tokens') or {}).items() if t not in toks}
            try:
                self.store.patch('tokens/' + uid, {'tokens': keep})
            except Exception as e:
                log('  pulizia token non riuscita', e)


def main():
    sa = os.environ.get('FIREBASE_SA', '').strip()
    if not sa:
        log('Notifiche non configurate (manca il segreto FIREBASE_SA): niente da fare.')
        return
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    info = json.loads(sa)
    creds = service_account.Credentials.from_service_account_info(info, scopes=[
        'https://www.googleapis.com/auth/datastore', 'https://www.googleapis.com/auth/firebase.messaging'])
    session = AuthorizedSession(creds)
    project = info['project_id']
    st = Store(session, project)

    tokens = st.list('tokens')
    if not tokens:
        log('Nessun telefono ha ancora attivato le notifiche.')
    team = st.get('config/team') or {}
    players = st.list('players')
    members = set(team.get('coaches') or []) | {k for k, v in players.items() if v.get('approved')}
    everyone = [u for u in tokens if u in members]
    sender = Sender(session, project, st, tokens)
    state = st.get('robot/state') or {}
    changed_state = {}

    cache = {}

    def rsvp_all():
        if 'rsvp' not in cache:
            cache['rsvp'] = st.list('rsvp')
        return cache['rsvp']

    # 1) coda del Mister
    outbox = st.list('outbox')
    for oid, o in sorted(outbox.items(), key=lambda kv: kv[1].get('createdAt', 0)):
        if o.get('sent'):
            continue
        kind = o.get('kind', 'post')
        targets = everyone
        if kind == 'remind' and o.get('eventId'):
            rsvp = rsvp_all()
            targets = [u for u in everyone if not ((rsvp.get(u) or {}).get('answers') or {}).get(o['eventId'])]
        if kind == 'test':
            targets = [u for u in everyone if u in (team.get('coaches') or [])] or everyone
        n = sender.send(targets, {'title': o.get('title', 'The Rimineser F.P.'), 'body': o.get('body', ''), 'url': o.get('url', '#home'), 'tag': kind + '-' + oid}, PREF_OF.get(kind))
        log('Coda: "%s" → %d telefoni' % (o.get('title', ''), n))
        st.patch('outbox/' + oid, {'sent': True, 'sentAt': int(dt.datetime.now().timestamp() * 1000)})

    # 2) promemoria del giorno prima a chi non ha risposto
    now = now_rome()
    tomorrow = (now + dt.timedelta(days=1)).date().isoformat()
    reminded = dict(state.get('reminded') or {})
    if now.hour >= REMIND_FROM_HOUR:
        L = league()
        evs = all_events(st.list('events'), L)
        rsvp = rsvp_all()
        for eid, e in evs.items():
            if e.get('date') != tomorrow or reminded.get(eid):
                continue
            targets = [u for u in everyone if not ((rsvp.get(u) or {}).get('answers') or {}).get(eid)]
            n = sender.send(targets, {'title': '⏰ Domani: ' + ev_title(e), 'body': 'Ore %s%s. Non hai ancora risposto: ci sei?' % (e.get('time', ''), (' · ' + e['location']) if e.get('location') else ''),
                                      'url': '#presenze', 'tag': 'remind-' + eid}, 'remind')
            log('Promemoria %s → %d telefoni' % (eid, n))
            reminded[eid] = True
        if reminded != (state.get('reminded') or {}):
            # tengo solo gli ultimi 60 promemoria
            changed_state['reminded'] = dict(list(reminded.items())[-60:])

    # 3) nuovo comunicato UISP
    L = league()
    if L and L.get('updated') and L['updated'] != state.get('uisp'):
        if state.get('uisp'):  # al primissimo avvio non avviso
            us = norm(L.get('team', ''))
            pos = next((i + 1 for i, r in enumerate(L.get('standings', [])) if norm(r['team']) == us), None)
            last = nxt = None
            for r in L.get('rounds', []):
                for m in r.get('matches', []):
                    if us in (norm(m['home']), norm(m['away'])):
                        if m.get('hg') is not None:
                            last = m
                        elif nxt is None:
                            nxt = m
            parts = []
            if last:
                parts.append('%s %s-%s %s' % (last['home'], last['hg'], last['ag'], last['away']))
            if pos:
                parts.append('siamo %d° in classifica' % pos)
            if nxt:
                parts.append('prossima: %s' % (nxt['away'] if norm(nxt['home']) == us else nxt['home']) + (' %s %s' % (nxt.get('date', '')[8:10] + '/' + nxt.get('date', '')[5:7], nxt.get('time', '')) if nxt.get('date') else ''))
            n = sender.send(everyone, {'title': '🏆 Nuovo comunicato UISP', 'body': ' · '.join(parts) or 'Risultati e classifica aggiornati', 'url': '#campionato', 'tag': 'uisp-' + L['updated']}, 'uisp')
            log('Comunicato UISP → %d telefoni' % n)
        changed_state['uisp'] = L['updated']

    if changed_state:
        st.patch('robot/state', changed_state)
    sender.cleanup()
    log('Fatto: %d notifiche consegnate a Google.' % sender.sent)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log('ERRORE:', e)
        sys.exit(1)
