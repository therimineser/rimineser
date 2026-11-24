#!/usr/bin/env python3
"""Calendario completo UISP caricato dall'app (PDF che la UISP manda privatamente alle squadre).

L'app estrae il testo del PDF (pdf.js, una riga per riga di tabella) e lo salva in Firestore uploads/calendar
{text, name, by, at, status:'new'}. Il robot di Cloudflare se ne accorge e avvia uisp.yml, che esegue:

  python3 tools/uisp_calendar.py --check   → scrive new=true/false (c'è un calendario da leggere?)
  python3 tools/uisp_calendar.py           → legge il testo, aggiunge le partite a docs/campionato.json
                                             e riscrive lo stato in uploads/calendar (ok / errore + conteggi)

Regole di unione: i comunicati ufficiali vincono sempre. Dal calendario si aggiungono solo le partite che mancano
e, per quelle già note, solo data/ora/campo se mancano. Le partite aggiunte così hanno "cal": true
(il comunicato che le conferma toglie il segno). Prova senza Firestore:
  python3 tools/uisp_calendar.py --text file.txt [--dry]
"""
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uisp_update as U   # noqa: E402  (stessi nomi squadra, giornate e mesi dei comunicati)

DATE = re.compile(r'(?:\b' + U.DAYS + r'[A-Z]*\.?\s+)?\b(\d{1,2})\s*[-/.]\s*([A-Z]{3}[A-Z]*\.?|\d{1,2})(?:\s*[-/.]\s*(\d{2,4}))?\b')
TIME = re.compile(r'\b(\d{1,2})[:.](\d{2})\b')


def teams_of(data):
    names = [r['team'] for r in data.get('standings', [])]
    for r in data.get('rounds', []):
        for m in r.get('matches', []):
            names += [m.get('home'), m.get('away')]
        names.append(r.get('rest'))
    return U.Teams(names)


def parse(text, data, today=None):
    """[{n, home, away, date?, time?, field?}] e {giornata: squadra che riposa}."""
    today = today or dt.date.today()
    teams = teams_of(data)
    lines = U.clean_lines(text)
    out, rests, n = [], {}, None
    for ln in lines:
        m = U.GG.search(ln)
        if m and len(ln) < 40:
            n = int(m.group(1))
            continue
        r = re.match(r'^RIPOS[AO]\s*:?\s*(.*)$', ln)
        if r:
            t = U.rest_team(r.group(1), teams)
            if t and n:
                rests[n] = t
            continue
        if not n:
            continue
        dm, tm = DATE.search(ln), TIME.search(ln)
        cut = min([x.start() for x in (dm, tm) if x] or [len(ln)])
        pair = teams.pair(ln[:cut].strip(' -'))
        if not pair:
            continue
        fx = {'n': n, 'home': pair[0], 'away': pair[1]}
        if dm:
            day, mon = int(dm.group(2)), dm.group(3).rstrip('.')
            mon = int(mon) if mon.isdigit() else U.MONTHS.get(mon[:3])
            y = dm.group(4)
            if mon:
                if y:
                    y = int(y) + (2000 if int(y) < 100 else 0)
                else:
                    y = today.year + (1 if mon < today.month - 6 else 0) - (1 if mon > today.month + 6 else 0)
                try:
                    fx['date'] = dt.date(y, mon, day).isoformat()
                except ValueError:
                    pass
        if tm and 0 <= int(tm.group(1)) < 24:
            fx['time'] = '%02d:%s' % (int(tm.group(1)), tm.group(2))
            after = ln[tm.end():].strip(' -')
            if after:   # in una riga di calendario dopo l'ora c'è il campo (es. RICCIONE, anche se somiglia a una squadra)
                fx['field'] = U.pretty(' '.join(after.split()[:4]))
        out.append(fx)
    return out, rests


def merge(data, fixtures, rests):
    added = filled = 0
    for fx in fixtures:
        rnd = U.get_round(data, fx['n'])
        t = next((m for m in rnd['matches'] if U.same_pair(m, fx['home'], fx['away'])), None)
        if not t:
            t = {'home': fx['home'], 'away': fx['away'], 'cal': True}
            rnd['matches'].append(t)
            added += 1
        changed = False
        for k in ('date', 'time', 'field'):
            if fx.get(k) and not t.get(k):
                t[k] = fx[k]
                changed = True
        filled += changed and not t.get('cal')
    for n, team in rests.items():
        r = U.get_round(data, n)
        r.setdefault('rest', team)
    data['rounds'] = [r for r in data['rounds'] if r['matches']]
    return added, filled


def ours(data, fixtures):
    us = U.norm(data.get('team', ''))
    return [f for f in fixtures if us in (U.norm(f['home']), U.norm(f['away']))]


def firestore():
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    from notify import Store
    info = json.loads(os.environ['FIREBASE_SA'])
    s = AuthorizedSession(service_account.Credentials.from_service_account_info(info, scopes=['https://www.googleapis.com/auth/datastore']))
    return Store(s, info['project_id'])


def output(k, v):
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a') as f:
            f.write('%s=%s\n' % (k, v))


def main():
    with open(U.JSON_PATH, encoding='utf-8') as f:
        data = json.load(f)
    data.setdefault('rounds', [])
    if '--text' in sys.argv:
        text = open(sys.argv[sys.argv.index('--text') + 1], encoding='utf-8').read()
        fx, rests = parse(text, data)
        print('Partite lette: %d (nostre %d), giornate %s' % (len(fx), len(ours(data, fx)), sorted({f['n'] for f in fx})))
        for f in ours(data, fx):
            print('  %s' % f)
        if '--dry' not in sys.argv:
            print('Aggiunte %d, completate %d' % merge(data, fx, rests))
            with open(U.JSON_PATH, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
        return
    if not os.environ.get('FIREBASE_SA'):
        print('Manca FIREBASE_SA: nessun calendario da leggere')
        output('new', 'false')
        return
    st = firestore()
    up = st.get('uploads/calendar') or {}
    if '--check' in sys.argv:
        new = up.get('status') == 'new' and bool(up.get('text'))
        print('Calendario da leggere:', 'sì' if new else 'no')
        output('new', 'true' if new else 'false')
        return
    if up.get('status') != 'new':
        print('Nessun calendario nuovo')
        return
    fx, rests = parse(up.get('text', ''), data)
    mine = ours(data, fx)
    now = int(dt.datetime.now().timestamp() * 1000)
    if not mine:
        st.patch('uploads/calendar', {'status': 'errore', 'done': now, 'found': len(fx), 'ours': 0,
                                      'msg': 'Nel file non ho trovato partite della nostra squadra' if fx else 'Nel file non ho trovato partite'})
        print('Calendario: nessuna nostra partita trovata (%d partite lette)' % len(fx))
        return
    added, filled = merge(data, fx, rests)
    data['calendar'] = {'file': up.get('name', ''), 'at': now, 'matches': len(fx), 'ours': len(mine)}
    with open(U.JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    days = sorted({f['n'] for f in fx})
    st.patch('uploads/calendar', {'status': 'ok', 'done': now, 'found': len(fx), 'ours': len(mine), 'added': added,
                                  'rounds': '%d-%d' % (days[0], days[-1]) if days else ''})
    print('Calendario letto: %d partite (nostre %d), aggiunte %d, completate %d' % (len(fx), len(mine), added, filled))


if __name__ == '__main__':
    main()
