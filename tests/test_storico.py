"""Prova di tools/storico.py con dati finti: nessun nome nei file, solo eventi passati o con scouting."""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools'))
from storico import build, write

players = {'u1': {'name': 'Mario Rossi', 'number': '7', 'cat': 'giocatore', 'approved': True},
           'u2': {'name': 'Luca Bianchi', 'number': '9', 'cat': 'capitano', 'approved': True},
           'u3': {'name': 'Gianni Verdi', 'cat': 'mister', 'approved': True},
           'u4': {'name': 'In Attesa', 'approved': False}}
events = {
  'uisp-5': {'type': 'partita', 'date': '2026-11-18', 'time': '22:00', 'opponent': 'Oasi del Mare', 'location': 'Campo Riccione',
             'notes': 'Porta Mario Rossi le maglie', 'result': '3-2',
             'lineups': [{'name': 'Formazione di Luca Bianchi', 'module': '2-3-1', 'slots': ['u1', 'u2', '', '', '', '', ''],
                          'bench': ['u3'], 'tactic': 'Mario Rossi marca il 10', 'published': True}]},
  'futuro': {'type': 'allenamento', 'date': '2026-12-20', 'time': '21:00'},
}
scout = {'uisp-5': {'acts': [{'id': 'b', 'k': 'pass_ok', 't': 'us', 's': 70, 'h': 1, 'ts': 2},
                             {'id': 'a', 'k': 'goal', 't': 'us', 's': 30, 'h': 1, 'ts': 1, 'p': 'u1', 'a': 'u2', 'g': 'assist'},
                             {'id': 'c', 'k': 'sub', 't': 'us', 's': 1500, 'h': 2, 'ts': 3, 'o': 'u1', 'p': 'u3', 'nome': 'Mario Rossi'}],
                    'half': 2, 'lock': {'uid': 'u2', 'name': 'Luca Bianchi', 'at': 5}},
         'cancellata': {'acts': [{'id': 'z', 'k': 'shot_in', 't': 'them', 's': 10, 'h': 1, 'ts': 9}]}}
rsvp = {'u1': {'answers': {'uisp-5': 'si', 'futuro': 'no'}}, 'u2': {'answers': {'uisp-5': 'si'}, 'roles': {'uisp-5': 'dirigente'}},
        'u3': {'answers': {'uisp-5': 'forse'}}}

res = build(events, scout, rsvp, players, '2026-11-18')
d = tempfile.mkdtemp()
n = write(res, d)
testo = ''.join(open(os.path.join(r, f)).read() for r, _, fs in os.walk(d) for f in fs)
ok = []
def check(nome, cond): ok.append(cond); print(('  OK  ' if cond else 'ERRORE ') + nome)
check('2 eventi salvati (partita giocata + scouting di evento cancellato)', n == 2 and set(res['partite']) == {'uisp-5', 'cancellata'})
check('allenamento futuro escluso', 'futuro' not in res['partite'])
for nome in ('Mario', 'Rossi', 'Luca', 'Bianchi', 'Gianni', 'Verdi', 'Attesa', 'marca il 10', 'maglie', '"7"', 'Formazione di'):
    check('nessuna traccia di %r nei file' % nome, nome not in testo)
p = res['partite']['uisp-5']
check('formazione con id', p['formazioni'] == [{'modulo': '2-3-1', 'titolari': ['u1', 'u2'], 'panchina': ['u3'], 'pubblicata': True}])
check('presenze con dirigenza', p['presenze'] == {'u1': 'si', 'u2': 'si-dirigenza', 'u3': 'forse'})
check('azioni in ordine, con assist e sostituzione', [a['id'] for a in p['scouting']['azioni']] == ['a', 'b', 'c'] and p['scouting']['azioni'][0]['a'] == 'u2' and p['scouting']['azioni'][2]['o'] == 'u1')
check('risultato e orario UISP', p['evento']['result'] == '3-2' and p['evento']['time'] == '22:00')
check('evento cancellato segnato', res['partite']['cancellata']['evento'] == {'cancellato': True})
check('rosa solo id → categoria, senza chi è in attesa', res['rosa'] == {'u1': 'giocatore', 'u2': 'capitano', 'u3': 'mister'})
print('Storico: %d/%d ok' % (sum(ok), len(ok)))
sys.exit(0 if all(ok) else 1)
