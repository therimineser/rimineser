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
ACT_KEYS = ('id', 'k', 't', 's', 'h', 'ts', 'p', 'a', 'g', 'o', 'm', 'pm', 'li', 'sl', 'b')   # sl/b = titolari/panchina di partenza (k:'xi')
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


def live_lineup(e):
    """Formazione usata dallo Scouting: la prima pubblicata, altrimenti la prima salvata (come scLiveIdx nell'app)."""
    lus = e.get('lineups') or []
    for l in lus:
        if l.get('published'):
            return l
    return lus[0] if lus else None


def minutaggio(e, acts, sc=None):
    """Minuti giocati da ogni giocatore (stessa logica di scMinutes in docs/app.js).
    Partenza = azione k:'xi' (salvata al fischio d'inizio), altrimenti formazione attuale con i cambi rifatti all'indietro.
    Fine di ogni tempo = azione k:'end', altrimenti ultima azione di quel tempo (o il cronometro salvato, se è il tempo in corso)."""
    ordered = sorted(acts, key=lambda a: (a.get('h') or 1, a.get('s') or 0, a.get('ts') or 0))
    subs = [a for a in ordered if a.get('k') == 'sub']
    xi = [a for a in acts if a.get('k') == 'xi']
    if xi:
        field, fonte = [x for x in (xi[-1].get('sl') or []) if x], 'formazione di partenza salvata'
    else:
        l = live_lineup(e or {})
        if not l:
            return None
        field, fonte = [x for x in (l.get('slots') or []) if x], 'ricostruita dalla formazione e dai cambi'
        for a in reversed(subs):
            if a.get('p') in field:
                field[field.index(a['p'])] = a.get('o')
    out, fine = {}, {}

    def P(i):
        return out.setdefault(i, {'titolare': False, 'secondi': 0, 'in_campo': [], 'entrato': [], 'uscito': []})
    for i in field:
        P(i)['titolare'] = True
    for h in (1, 2):
        ends = [a for a in acts if a.get('k') == 'end' and a.get('h') == h]
        if ends:
            end = ends[-1].get('s') or 0
        else:
            end = max([a.get('s') or 0 for a in acts if a.get('h') == h] or [0])
            if sc and sc.get('half') == h:
                end = max(end, sc.get('base') or 0)
        fine[h] = {'secondi': end, 'segnata': bool(ends)}
        if h == 2 and not end and not any(a.get('h') == 2 for a in subs):
            del fine[2]
            break
        start = {i: 0 for i in field}
        for a in (x for x in subs if x.get('h') == h):
            t = min(a.get('s') or 0, end)
            o, p = a.get('o'), a.get('p')
            if o in start:
                P(o)['in_campo'].append({'tempo': h, 'da': start.pop(o), 'a': t})
            P(o)['uscito'].append({'tempo': h, 'secondo': a.get('s') or 0})
            P(p)['entrato'].append({'tempo': h, 'secondo': a.get('s') or 0})
            start[p] = t
        for i, da in start.items():
            P(i)['in_campo'].append({'tempo': h, 'da': da, 'a': end})
        field = list(start)
    for v in out.values():
        v['secondi'] = sum(max(0, x['a'] - x['da']) for x in v['in_campo'])
        v['minuti'] = round(v['secondi'] / 60, 1)
    return {'fonte': fonte, 'fine_tempi': fine, 'giocatori': dict(sorted(out.items()))}


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
            m = minutaggio(e, d['scouting']['azioni'], sc)
            if m and m['giocatori']:
                d['minutaggio'] = m
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
