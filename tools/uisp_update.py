#!/usr/bin/env python3
"""Robot che aggiorna docs/campionato.json leggendo i comunicati UISP Rimini (calcio a 7).

Gira da solo su GitHub Actions (vedi .github/workflows/uisp.yml):
1. cerca sul sito UISP Rimini i PDF dei comunicati di calcio a 7 della stagione;
2. legge quelli nuovi: risultati, classifica, prossimo turno, marcatori, provvedimenti;
3. controlla che i numeri tornino e aggiorna campionato.json (che l'app legge).

Uso locale:  python tools/uisp_update.py            (scarica dal sito)
             python tools/uisp_update.py --text file.txt --name "giornata 4 ... del 13-11-26.pdf"   (prova su un testo)
"""
import datetime as dt
import difflib
import html
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(ROOT, 'docs', 'campionato.json')
START_PAGES = ['https://www.uisp.it/rimini/pagina/calcio',
               'https://www.uisp.it/rimini/pagina/uisp-rimini-20252026',
               'https://www.uisp.it/rimini/pagina/uisp-rimini-20262027']
_t = dt.date.today()
SEASON_START = dt.date(_t.year if _t.month >= 8 else _t.year - 1, 8, 1)  # la stagione parte ad agosto
UA = {'User-Agent': 'Mozilla/5.0 (RimineserApp; aggiornamento campionato)'}
DAYS = r'(LUN|MAR|MER|GIO|VEN|SAB|DOM)'
MONTHS = {'GEN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAG': 5, 'GIU': 6, 'LUG': 7, 'AGO': 8, 'SET': 9, 'OTT': 10, 'NOV': 11, 'DIC': 12}
KEEP_UP = {'FC', 'F.C.', 'A.C.', 'AC', 'F.P.', 'FP', 'ASD', 'A.S.D.', 'SSD', 'US', 'U.S.', 'CSK', 'SC', 'S.C.'}
LOWER = {'IN', 'AL', 'A', 'AND', 'DEL', 'DELLA', 'DELLE', 'DEI', 'DI', 'DA', 'E', 'DE', 'LA', 'LE', 'IL'}


def log(*a):
    print(*a, flush=True)


def norm(s):
    return re.sub(r'[^A-Z0-9]', '', str(s).upper())


def pretty(s):
    out = []
    for i, w in enumerate(s.split()):
        if w in KEEP_UP or re.fullmatch(r'[A-Z]\.([A-Z]\.)+', w):
            out.append(w)
        elif w in LOWER and i > 0:
            out.append(w.lower())
        elif re.fullmatch(r'\d+', w):
            out.append(w)
        else:
            out.append(w[:1] + w[1:].lower())
    return ' '.join(out)


def title_name(s):
    return ' '.join(w[:1] + w[1:].lower() if not w.startswith("D'") else "D'" + w[2:3] + w[3:].lower() for w in s.split())


# ---------------------------------------------------------------- download
def http_get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


def discover():
    pages, seen, pdfs = list(START_PAGES), set(), {}
    while pages:
        url = pages.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            body = http_get(url).decode('utf-8', 'replace')
        except Exception as e:
            log('  pagina non raggiungibile:', url, e)
            continue
        for href in re.findall(r'href=["\']([^"\']+)["\']', body):
            href = html.unescape(href)
            full = urllib.parse.urljoin(url, href)
            low = urllib.parse.unquote(full).lower()
            if low.endswith('.pdf') and 'calcio a 7' in low:
                d = file_date(full)
                if d and d >= SEASON_START:
                    pdfs[full] = d
            elif '/rimini/pagina/' in low and re.search(r'uisp-rimini-20\d\d|risultati-calcio-a-7', low) and len(seen) < 8:
                pages.append(full.split('#')[0])
    return sorted(pdfs.items(), key=lambda kv: (kv[1], comunicato_n(kv[0])))


def file_name(url):
    return urllib.parse.unquote(url.rsplit('/', 1)[-1])


def file_date(url):
    m = re.search(r'del\s*(\d{1,2})-(\d{1,2})-(\d{2,4})', file_name(url), re.I)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    y = y + 2000 if y < 100 else y
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


def comunicato_n(url):
    m = re.search(r'N\.\s*(\d+)', file_name(url))
    return int(m.group(1)) if m else 0


def pdf_texts(data):
    """Restituisce più estrazioni possibili del testo (il lettore sceglie quella che torna)."""
    outs = []
    try:
        import pypdf
        r = pypdf.PdfReader(io.BytesIO(data))
        outs.append('\n'.join((p.extract_text() or '') for p in r.pages))
    except Exception as e:
        log('  pypdf non riuscito:', e)
    for mode in ([], ['-layout'], ['-raw']):
        try:
            with tempfile.NamedTemporaryFile(suffix='.pdf') as f:
                f.write(data)
                f.flush()
                outs.append(subprocess.run(['pdftotext', *mode, f.name, '-'], capture_output=True, text=True, timeout=60).stdout)
        except Exception:
            pass
    return [o for o in outs if o and o.strip()]


# ---------------------------------------------------------------- lettura
def clean_lines(text):
    text = text.replace('’', "'").replace('‘', "'").replace('`', "'").replace(' ', ' ').replace('–', '-').replace('—', '-')
    lines = []
    for ln in text.splitlines():
        ln = re.sub(r'\s+', ' ', ln).strip()
        if ln:
            lines.append(ln.upper())
    return lines


HEAD = [('RISULTATI', r'^RISULTATI\b'), ('CLASSIFICA', r'^CLASSIFICA$|^CLASSIFICA GENERALE|^CLASSIFICA\s+PUNTI'),
        ('PROSSIMO', r'^PROSSIMO TURNO|^PROGRAMMA GARE|^CALENDARIO GARE'),
        ('DISCIPLINA', r'^PROVVEDIMENTI'), ('MARCATORI', r'^CLASSIFICA MARCATORI'),
        ('ALTRO', r'^(SCADENZE|COMUNICAZIONI|AVVISI|NOTE\b|SI RICORDA|SEGRETERIA)')]


def sections(lines):
    out, cur = {}, 'TESTA'
    for ln in lines:
        for key, rx in HEAD:
            if re.search(rx, ln):
                cur = key
                if key == 'CLASSIFICA' and ln.startswith('CLASSIFICA PUNTI'):
                    out.setdefault(cur, []).append(ln[len('CLASSIFICA'):])
                break
        else:
            out.setdefault(cur, []).append(ln)
    return out


class Teams:
    def __init__(self, names):
        self.names = list(dict.fromkeys(n for n in names if n))

    def score(self, s, t):
        a, b = norm(s), norm(t)
        if not a:
            return 0
        r = difflib.SequenceMatcher(None, a, b).ratio()
        if len(a) >= 4 and (b.startswith(a) or a.startswith(b)):
            r = max(r, 0.9)
        if len(a) >= 6 and a in b:
            r = max(r, 0.85)
        return r

    def best(self, s):
        best = max(self.names, key=lambda t: self.score(s, t), default=None)
        return (best, self.score(s, best)) if best else (None, 0)

    def pair(self, seg):
        words = seg.split()
        if len(words) < 2:
            return None
        cands = []
        for k in range(1, len(words)):
            a, b = ' '.join(words[:k]), ' '.join(words[k:])
            (ta, sa), (tb, sb) = self.best(a), self.best(b)
            if ta and tb and ta != tb:
                cands.append((sa + sb, min(sa, sb), ta, tb))
        if not cands:
            return None
        tot, worst, ta, tb = max(cands)
        return (ta, tb) if worst >= 0.6 else None


GG = re.compile(r'(\d{1,2})\s*[\^°ª]?\s*(?:A\s+)?GIORNATA')


def round_chunks(lines, default_n):
    """Divide le righe di una sezione per giornata: [(n, testo, riga_riposo)]."""
    chunks, n, buf, rest = [], default_n, [], None
    for ln in lines:
        m = GG.search(ln)
        if m and len(ln) < 40:
            if buf or rest:
                chunks.append((n, ' '.join(buf), rest))
            n, buf, rest = int(m.group(1)), [], None
            continue
        r = re.match(r'^RIPOS[AO]\s*:?\s*(.*)$', ln)
        if r:
            rest = r.group(1)
            continue
        buf.append(ln)
    if buf or rest:
        chunks.append((n, ' '.join(buf), rest))
    return chunks


def rest_team(raw, teams):
    if not raw:
        return None
    t, sc = teams.best(raw)
    return t if sc >= 0.6 else None


def parse_standings(lines):
    txt = ' '.join(lines)
    txt = re.sub(r'\*?CD\s*:.*$', ' ', txt)
    txt = re.sub(r'^\s*PUNTI\s+G\s+V\s+N\s+P\s+GF\s+GS\s*\*?CD', ' ', txt)
    txt = re.sub(r'\s+', ' ', txt).strip() + ' '
    rows, k, pos = [], 1, 0
    while True:
        rx = re.compile(r'%d (.+?) (\d{1,3}) (\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,2}) (\d{1,3}) (\d{1,3})(?: (\d{1,2}))? (?=%d |$|\*)' % (k, k + 1))
        m = rx.search(txt, pos)
        if not m or (m.start() - pos) > 60:
            break
        name = m.group(1).strip()
        nums = [int(x) for x in m.groups()[1:8]]
        row = {'team': pretty(name), 'pt': nums[0], 'g': nums[1], 'v': nums[2], 'n': nums[3], 'p': nums[4], 'gf': nums[5], 'gs': nums[6]}
        if m.group(9) is not None:
            row['cd'] = int(m.group(9))  # punti disciplina
        rows.append(row)
        pos, k = m.end(), k + 1
    return rows


def standings_ok(rows):
    if len(rows) < 6:
        return False
    good = sum(1 for r in rows if r['g'] == r['v'] + r['n'] + r['p'] and abs(r['pt'] - (3 * r['v'] + r['n'])) <= 3)
    return good >= len(rows) * 0.8


def parse_results(lines, teams, default_n):
    res, rests = [], {}
    for n, text, raw in round_chunks(lines, default_n):
        rest = rest_team(raw, teams)
        if rest:
            rests[n] = rest
        text = re.sub(r'\([^)]*\)', ' ', text)
        for m in re.finditer(r'(.+?)\s(\d{1,2})\s*-\s*(\d{1,2})(?=\s|$)', text):
            p = teams.pair(m.group(1).strip(' -*'))
            if p:
                res.append({'n': n, 'home': p[0], 'away': p[1], 'hg': int(m.group(2)), 'ag': int(m.group(3))})
            else:
                log('  risultato non riconosciuto:', m.group(0)[:80])
    return res, rests


def parse_fixtures(lines, teams, default_n, ref):
    fx, rests = [], {}
    rx = re.compile(r'(.+?)\s' + DAYS + r'[A-Z]*\.?\s+(\d{1,2})\s*[-/.]?\s*([A-Z]{3}|\d{1,2})[A-Z]*\.?\s+(\d{1,2})[:.](\d{2})\s+([A-Z][A-Z\'. ]*?)(?=\s+[A-Z0-9][A-Z0-9\'.]*\s|$)')
    for n, text, raw in round_chunks(lines, default_n):
        rest = rest_team(raw, teams)
        if rest:
            rests[n] = rest
        pos = 0
        while True:
            m = rx.search(text, pos)
            if not m:
                break
            p = teams.pair(m.group(1).strip(' -'))
            day, mon = int(m.group(3)), m.group(4)
            mon = MONTHS.get(mon[:3]) if not mon.isdigit() else int(mon)
            field = m.group(7).split()[0].strip(" .'")
            # il campo può essere di più parole: prendo le parole fino all'inizio della partita successiva
            after = text[m.end(6) + 1:].split()
            words = []
            for i, w in enumerate(after):
                if i and teams.best(' '.join(after[i:i + 3]))[1] >= 0.8:
                    break
                if re.fullmatch(DAYS, w) or re.fullmatch(r'\d', w):
                    break
                words.append(w)
                if len(words) == 5:
                    break
            if words:
                field = ' '.join(words)
            if p and mon:
                y = ref.year + (1 if mon < ref.month - 6 else 0) - (1 if mon > ref.month + 6 else 0)
                try:
                    d = dt.date(y, mon, day)
                    fx.append({'n': n, 'home': p[0], 'away': p[1], 'date': d.isoformat(), 'time': '%02d:%s' % (int(m.group(5)), m.group(6)), 'field': pretty(field)})
                except ValueError:
                    pass
            else:
                log('  partita in programma non riconosciuta:', m.group(0)[:80])
            pos = m.end(6) + 1 + len(' '.join(words))
    return fx, rests


def parse_people(lines, teams):
    out = []
    for ln in lines:
        m = re.match(r"^([A-Z' .-]+?)\s*\(([^)]+)\)\s*(.*)$", ln)
        if m:
            t, s = teams.best(m.group(2))
            out.append({'name': title_name(m.group(1).strip()), 'team': t if s >= 0.6 else pretty(m.group(2)), 'note': m.group(3).strip().lower()})
    return out


def parse_scorers(lines, teams):
    out, goals = [], None
    for ln in lines:
        m = re.match(r'^(\d{1,3})\s*GOL', ln)
        if m:
            goals = int(m.group(1))
            continue
        if goals is None:
            continue
        for p in parse_people([ln], teams):
            out.append({'name': p['name'], 'team': p['team'], 'goals': goals})
    return out


def parse_discipline(lines, teams):
    cur, out = None, {'ammonizioni': [], 'diffide': [], 'squalifiche': []}
    for ln in lines:
        k = re.match(r'^(AMMONIZION|DIFFID|SQUALIFIC)', ln)
        if k:
            cur = {'AMMONIZION': 'ammonizioni', 'DIFFID': 'diffide', 'SQUALIFIC': 'squalifiche'}[k.group(1)]
            continue
        if cur:
            out[cur] += parse_people([ln], teams)
    return out


def parse(text, name, prev_teams):
    lines = clean_lines(text)
    sec = sections(lines)
    head = ' '.join(sec.get('TESTA', [])[:6])
    m = re.search(r'COMUNICATO\s*N\.?\s*(\d+)\s*DEL\s*(\d{1,2})/(\d{1,2})/(\d{2,4})', head)
    ref = file_date(name) or dt.date.today()
    if m:
        y = int(m.group(4))
        ref = dt.date(y + 2000 if y < 100 else y, int(m.group(3)), int(m.group(2)))
    gm = re.search(r'giornata\s*(\d+)|gg\s*(\d+)', name, re.I)
    default_n = int(gm.group(1) or gm.group(2)) if gm else 0
    standings = parse_standings(sec.get('CLASSIFICA', []))
    if not standings_ok(standings):
        standings = []
    teams = Teams([r['team'] for r in standings] + list(prev_teams))
    results, rests1 = parse_results(sec.get('RISULTATI', []), teams, default_n)
    nxt = default_n + 1 if default_n else 0
    fixtures, rests2 = parse_fixtures(sec.get('PROSSIMO', []), teams, nxt, ref)
    return {'date': ref.isoformat(), 'standings': standings, 'results': results, 'fixtures': fixtures,
            'rests': {**rests1, **rests2}, 'scorers': parse_scorers(sec.get('MARCATORI', []), teams),
            'discipline': parse_discipline(sec.get('DISCIPLINA', []), teams)}


def quality(p):
    return len(p['results']) * 2 + len(p['fixtures']) * 2 + (10 if p['standings'] else 0) + min(len(p['scorers']), 5)


# ---------------------------------------------------------------- unione
def same_pair(m, a, b):
    return {norm(m['home']), norm(m['away'])} == {norm(a), norm(b)}


def get_round(data, n):
    for r in data['rounds']:
        if r['n'] == n:
            return r
    r = {'n': n, 'matches': []}
    data['rounds'].append(r)
    data['rounds'].sort(key=lambda x: x['n'])
    return r


def merge(data, p):
    for res in p['results']:
        target = None
        rnd = get_round(data, res['n']) if res['n'] else None
        if rnd:
            target = next((m for m in rnd['matches'] if same_pair(m, res['home'], res['away'])), None)
        if not target:  # recupero: cerco la partita in tutte le giornate
            target = next((m for r in data['rounds'] for m in r['matches'] if same_pair(m, res['home'], res['away']) and m.get('hg') is None), None)
        if not target:
            if not rnd:
                continue
            target = {'home': res['home'], 'away': res['away']}
            rnd['matches'].append(target)
        target.pop('cal', None)   # confermata dal comunicato: non è più solo "dal calendario"
        swap = norm(target['home']) != norm(res['home'])
        target['hg'], target['ag'] = (res['ag'], res['hg']) if swap else (res['hg'], res['ag'])
    for fx in p['fixtures']:
        if not fx['n']:
            continue
        rnd = get_round(data, fx['n'])
        target = next((m for m in rnd['matches'] if same_pair(m, fx['home'], fx['away'])), None)
        if not target:
            target = {'home': fx['home'], 'away': fx['away']}
            rnd['matches'].append(target)
        target.update({'date': fx['date'], 'time': fx['time'], 'field': fx['field']})
        target.pop('cal', None)
    for n, t in p['rests'].items():
        if n:
            get_round(data, int(n))['rest'] = t
    if p['standings']:
        data['standings'] = p['standings']
    if p['scorers']:
        data['scorers'] = p['scorers']
    if any(p['discipline'].values()):
        data['discipline'] = p['discipline']
    # cartellini cumulati per squadra (ogni comunicato elenca solo i provvedimenti nuovi)
    cards = data.setdefault('cards', {})
    for kind, key in (('ammonizioni', 'amm'), ('squalifiche', 'esp'), ('diffide', 'diff')):
        for x in p['discipline'].get(kind, []):
            c = cards.setdefault(x['team'], {'amm': 0, 'esp': 0, 'diff': 0})
            c[key] += 1
    if p['date'] > data.get('updated', ''):
        data['updated'] = p['date']
    data['rounds'] = [r for r in data['rounds'] if r['matches']]


def process(data, text_variants, name):
    prev = [r['team'] for r in data.get('standings', [])]
    parsed = [parse(t, name, prev) for t in text_variants]
    best = max(parsed, key=quality, default=None)
    if not best or quality(best) < 4:
        log('  ATTENZIONE: non sono riuscito a leggere', name)
        return False
    log('  letto %s: %d risultati, %d partite in programma, classifica %s, %d marcatori' % (
        name, len(best['results']), len(best['fixtures']), 'ok' if best['standings'] else 'assente', len(best['scorers'])))
    merge(data, best)
    return True


def main():
    with open(JSON_PATH, encoding='utf-8') as f:
        data = json.load(f)
    before = json.dumps(data, sort_keys=True)
    data.setdefault('processed', [])
    data.setdefault('rounds', [])
    if '--check' in sys.argv:
        # controllo rapido: c'è un comunicato non ancora letto? (scrive new=true/false per GitHub Actions)
        new = [u for u, d in discover() if file_name(u) not in data['processed']]
        log('Comunicati nuovi:', len(new))
        out = os.environ.get('GITHUB_OUTPUT')
        if out:
            with open(out, 'a') as f:
                f.write('new=%s\n' % ('true' if new else 'false'))
        return
    if '--text' in sys.argv:
        txt = open(sys.argv[sys.argv.index('--text') + 1], encoding='utf-8').read()
        name = sys.argv[sys.argv.index('--name') + 1]
        process(data, [txt], name)
    else:
        found = discover()
        log('Comunicati trovati:', len(found))
        for url, d in found:
            name = file_name(url)
            if name in data['processed']:
                continue
            log('Nuovo comunicato:', name)
            try:
                texts = pdf_texts(http_get(url))
            except Exception as e:
                log('  download non riuscito:', e)
                continue
            if process(data, texts, name):
                data['processed'].append(name)
    if json.dumps(data, sort_keys=True) != before:
        with open(JSON_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        log('campionato.json aggiornato')
    else:
        log('Nessuna novità')


if __name__ == '__main__':
    main()
