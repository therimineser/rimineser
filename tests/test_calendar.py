"""Prova di tools/uisp_calendar.py (calendario completo caricato dall'app) con un testo di esempio."""
import copy, datetime as dt, json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
import uisp_calendar as C

DATA = {'team': 'The Rimineser F.P.', 'standings': [{'team': t} for t in ['The Rimineser F.P.', 'Casa Beach 27 Riccione', "Riccione's Brothers FC", 'Vibes Viserbella', 'Siamo Questi', 'Tinto Team', 'Tiki FC', 'Los Diez', 'AC Ciechi', 'Rose and Crown', 'Flamingo FC', 'Vergiano Calcio', 'Anfiteatro FC']],
        'rounds': [{'n': 6, 'matches': [{'home': 'The Rimineser F.P.', 'away': 'Vibes Viserbella', 'date': '2026-11-27', 'time': '22:00', 'field': 'Riccione'}]}]}
TEXT = """CALENDARIO CAMPIONATO CALCIO A 7 2026/2027
6^ Giornata
THE RIMINESER F.P. VIBES VISERBELLA GIO 26/11/2026 21:00 CORIANO
SIAMO QUESTI TINTO TEAM MER 25-nov 22:00 RICCIONE
Riposa ANFITEATRO FC
7ª GIORNATA
TIKI FC THE RIMINESER F.P. 03/12 20:45 STELLA
LOS DIEZ AC CIECHI 04/12/26 21:45 CORIANO
8 GIORNATA
THE RIMINESER F.P. ROSE AND CROWN
CASA BEACH 27 RICCIONE FLAMINGO FC MER 10/12/2026 22:00 RICCIONE
FLAMINGO FC VERGIANO CALCIO
"""
R = []
def check(c, name, det=''): R.append(c); print(('  OK  ' if c else 'ERRORE ') + name + ('' if c else ' -> ' + str(det)[:300]))
fx, rests = C.parse(TEXT, DATA, dt.date(2026, 11, 24))
check(next(f for f in fx if 'Casa' in f['home'])['field'] == 'Riccione', 'campo "RICCIONE" anche se somiglia a una squadra')
check(len(fx) == 7 and sorted({f['n'] for f in fx}) == [6, 7, 8], '6 partite in 3 giornate', fx)
t7 = next(f for f in fx if f['n'] == 7 and 'Tiki' in f['home'])
check(t7 == {'n': 7, 'home': 'Tiki FC', 'away': 'The Rimineser F.P.', 'date': '2026-12-03', 'time': '20:45', 'field': 'Stella'}, 'data senza anno (03/12), ora e campo', t7)
check(next(f for f in fx if 'Los' in f['home'])['date'] == '2026-12-04', 'data con anno a due cifre (04/12/26)')
check(next(f for f in fx if 'Siamo' in f['home'])['date'] == '2026-11-25', 'data col mese a lettere (25-nov)')
check(next(f for f in fx if f['n'] == 8 and 'Rose' in f['away']) == {'n': 8, 'home': 'The Rimineser F.P.', 'away': 'Rose and Crown'}, 'partita senza data: solo le squadre')
check(rests == {6: 'Anfiteatro FC'}, 'chi riposa', rests)
d = copy.deepcopy(DATA); added, filled = C.merge(d, fx, rests)
r6 = next(r for r in d['rounds'] if r['n'] == 6)
us6 = next(m for m in r6['matches'] if 'Vibes' in m['away'])
check(us6['date'] == '2026-11-27' and us6['time'] == '22:00' and us6['field'] == 'Riccione' and 'cal' not in us6, 'il comunicato ufficiale vince: data/ora/campo non cambiano', us6)
check(added == 6 and all(m.get('cal') for r in d['rounds'] for m in r['matches'] if m is not us6), 'le altre 6 partite aggiunte con il segno "dal calendario"', added)
check([r['n'] for r in d['rounds']] == [6, 7, 8] and r6.get('rest') == 'Anfiteatro FC', 'giornate in ordine, riposo segnato')
check(len(C.ours(d, fx)) == 3, '3 partite della nostra squadra')
f2, _ = C.parse('PARTITE\nNIENTE DA VEDERE QUI', DATA)
check(f2 == [], 'testo senza partite: niente')
print('Calendario: %d/%d ok' % (sum(R), len(R))); sys.exit(0 if all(R) else 1)
