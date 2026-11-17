#!/usr/bin/env python3
"""Copia notturna dello storico (scouting, formazioni, sostituzioni, presenze) SENZA NOMI.

Il repository è pubblico: nei file finiscono solo gli id Firebase dei giocatori (es. "aB3x…"),
mai nomi, numeri di maglia, tattiche, note o il nome di chi ha fatto lo scouting.
Per abbinare id → nome serve Firebase (players/{id}), leggibile solo dagli iscritti.

Uso: FIREBASE_SA=... python3 tools/storico.py <cartella di uscita>
Scrive <cartella>/partite/<id evento>.json e <cartella>/rosa.json (id → categoria).
Lo usa .github/workflows/storico.yml, che salva la cartella nel ramo "storico".
"""
import datetime as dt
import json
import os
import sys

# Campi delle azioni di scouting che si copiano (tutti senza nomi: p, a, o = id giocatore)
ACT_KEYS = ('id', 'k', 't', 's', 'h', 'ts', 'p', 'a', 'g', 'o', 'm', 'pm')
EV_KEYS = ('type', 'date', 'time', 'meet', 'opponent', 'location', 'home', 'result', 'lockAt')  # mai notes


def oggi_roma():
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo('Europe/Rome')).date().isoformat()
    except Exception:
        return dt.date.today().isoformat()


def norm(x):
    return ''.join(c for c in str(x).upper() if c.isalnum())


def uisp(L):
    """Le nostre partite dal calendario UISP (docs/campionato.json), anche quelle giocate senza data nel comunicato."""
    out = {}
    if not L:
        return out
    us = norm(L.get('team', ''))
    for r in L.get('rounds', []):
        for m in r.get('matches', []):
            home = norm(m.get('home')) == us
            if not home and norm(m.get('away')) != us:
                continue
            d = {'type': 'partita', 'giornata': r['n'], 'home': home, 'opponent': m['away'] if home else m['home']}
            for a, b in (('date', 'date'), ('time', 'time')):
                if m.get(a):
                    d[b] = m[a]
            if m.get('field'):
                d['location'] = 'Campo ' + m['field']
            if m.get('hg') is not None and m.get('ag') is not None:
                gf, gs = (m['hg'], m['ag']) if home else (m['ag'], m['hg'])
                d.update(gol_fatti=gf, gol_subiti=gs, result='%s-%s' % (gf, gs))
            out['uisp-%s' % r['n']] = d
    return out


def build(events, scout, rsvp, players, today, L=None):
    """Ritorna {'partite': {eid: dati}, 'rosa': {id: cat}}. Solo eventi già iniziati (data <= oggi), giocati o con scouting."""
    out, U = {}, uisp(L)
    for eid in sorted(set(events) | set(scout) | set(U)):
        e, sc, u = events.get(eid) or {}, scout.get(eid) or {}, U.get(eid) or {}
        day = u.get('date') or e.get('date')
        if not sc.get('acts') and 'gol_fatti' not in u and (not day or day > today):
            continue
        d = {'id': eid, 'evento': {k: e[k] for k in EV_KEYS if e.get(k) not in (None, '')}}
        d['evento'].update(u)   # per le partite UISP vale sempre il calendario UISP (orari, campo, risultato)
        if not e and not u:
            d['evento']['cancellato'] = True   # evento tolto dal calendario: lo scouting resta
        lus = []
        for l in e.get('lineups') or []:
            lus.append({'modulo': l.get('module'), 'titolari': [x for x in (l.get('slots') or []) if x],
                        'panchina': [x for x in (l.get('bench') or []) if x], 'pubblicata': bool(l.get('published'))})
        if lus:
            d['formazioni'] = lus
        pres = {}
        for uid, r in rsvp.items():
            a = (r.get('answers') or {}).get(eid)
            if a:
                ruolo = (r.get('roles') or {}).get(eid)
                pres[uid] = a + ('-dirigenza' if ruolo == 'dirigente' and a == 'si' else '')
        if pres:
            d['presenze'] = dict(sorted(pres.items()))
        if sc:
            d['scouting'] = {
                'azioni': [{k: a[k] for k in ACT_KEYS if k in a} for a in (sc.get('acts') or []) if isinstance(a, dict)],
                'tempo': sc.get('half'), 'aggiornato': sc.get('updatedAt'),
            }
            d['scouting']['azioni'].sort(key=lambda a: (a.get('ts') or 0, str(a.get('id'))))
        out[eid] = d
    rosa = {uid: (p.get('cat') or 'giocatore') for uid, p in sorted(players.items()) if p.get('approved')}
    return {'partite': out, 'rosa': rosa}


def write(res, folder):
    os.makedirs(os.path.join(folder, 'partite'), exist_ok=True)
    keep = set()
    for eid, d in res['partite'].items():
        fn = eid.replace('/', '_') + '.json'
        keep.add(fn)
        with open(os.path.join(folder, 'partite', fn), 'w') as f:
            json.dump(d, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write('\n')
    # I file di partite che non esistono più su Firebase NON si cancellano: è uno storico.
    with open(os.path.join(folder, 'rosa.json'), 'w') as f:
        json.dump(res['rosa'], f, ensure_ascii=False, indent=1)
        f.write('\n')
    return len(keep)


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else 'storico'
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from notify import Store
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    info = json.loads(os.environ['FIREBASE_SA'])
    s = AuthorizedSession(service_account.Credentials.from_service_account_info(info, scopes=['https://www.googleapis.com/auth/datastore']))
    fs = Store(s, info['project_id'])
    from notify import league
    res = build(fs.list('events'), fs.list('scout'), fs.list('rsvp'), fs.list('players'), oggi_roma(), league())
    n = write(res, folder)
    azioni = sum(len((d.get('scouting') or {}).get('azioni', [])) for d in res['partite'].values())
    print('Storico: %d eventi salvati, %d azioni di scouting, %d iscritti (solo id e categoria)' % (n, azioni, len(res['rosa'])))


if __name__ == '__main__':
    main()
