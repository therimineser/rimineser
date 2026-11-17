// Simula il Worker delle notifiche (worker/src) senza rete: Google, Firestore e FCM finti, orologio controllato.
// Uso: node tests/test_worker.mjs
import { run, romeToMs } from '../worker/src/robot.js';
import worker, { counted } from '../worker/src/index.js';

const { subtle } = globalThis.crypto;
const b64u = b => Buffer.from(b).toString('base64url');

// chiave finta dell'account di servizio e chiave finta di Firebase Auth
const saKey = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pem = '-----BEGIN PRIVATE KEY-----\n' + Buffer.from(await subtle.exportKey('pkcs8', saKey.privateKey)).toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
const ENV = { FIREBASE_SA: JSON.stringify({ project_id: 'rimineser', client_email: 'robot@rimineser.iam.gserviceaccount.com', private_key: pem }), LEAGUE_URL: 'https://raw/league.json', EXAMPLE_URL: 'https://raw/esempio.json' };
const authKey = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const authJwk = { ...(await subtle.exportKey('jwk', authKey.publicKey)), kid: 'k1', use: 'sig', alg: 'RS256' };
async function idToken(over = {}, key = authKey.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify({ aud: 'rimineser', iss: 'https://securetoken.google.com/rimineser', sub: 'p2', iat: now, exp: now + 3600, ...over }));
  return h + '.' + p + '.' + b64u(await subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p)));
}

// ---------------------------------------------------------------- Firestore/FCM finti
let DB = {}, SENT = [], LEAGUE = null, EX = null, CALLS = 0, TIME = 0, FAIL_FCM = false;
const TOKOWNER = {};
const { toFs, toJs } = await import('../worker/src/google.js');
const fsDoc = (p) => ({ name: 'projects/rimineser/databases/(default)/documents/' + p, fields: Object.fromEntries(Object.entries(DB[p].d).map(([k, v]) => [k, toFs(v)])), updateTime: DB[p].t });
const res = (status, data) => new Response(typeof data === 'string' ? data : JSON.stringify(data ?? {}), { status });
const colOf = p => p.slice(0, p.lastIndexOf('/'));
const put = (p, d) => { DB[p] = { d, t: 'T' + (++TIME) }; };
const get = p => DB[p] && DB[p].d;
function cmp(a, op, b) { return { EQUAL: a === b, GREATER_THAN_OR_EQUAL: a >= b, LESS_THAN_OR_EQUAL: a <= b }[op] && a !== undefined; }

async function fakeFetch(url, init = {}) {
  CALLS++;
  url = String(url);
  const m = init.method || 'GET';
  if (url.startsWith('https://oauth2.googleapis.com/token')) return res(200, { access_token: 'acc', expires_in: 3600 });
  if (url.includes('securetoken@system')) return res(200, { keys: [authJwk] });
  if (url.startsWith('https://raw/league.json')) return LEAGUE ? res(200, LEAGUE) : res(404, 'no');
  if (url.startsWith('https://raw/esempio.json')) return EX ? res(200, EX) : res(404, 'no');
  if (url.startsWith('https://fcm.googleapis.com/')) {
    const msg = JSON.parse(init.body).message;
    if (FAIL_FCM) return res(500, 'boom');
    if (msg.token.startsWith('dead')) return res(404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}');
    SENT.push([TOKOWNER[msg.token], msg.data]);
    return res(200, { name: 'x' });
  }
  const root = 'https://firestore.googleapis.com/v1/projects/rimineser/databases/(default)/documents';
  if (!url.startsWith(root)) throw new Error('URL inatteso ' + url);
  const u = new URL(url.replace('(default)', 'DEFAULT'));
  const path = decodeURIComponent(u.pathname.split('/documents')[1] || '').replace(/^\//, '');
  if (url.startsWith(root + ':runQuery')) {
    const q = JSON.parse(init.body).structuredQuery, col = q.from[0].collectionId;
    const fl = q.where.compositeFilter ? q.where.compositeFilter.filters : [q.where];
    const out = Object.keys(DB).filter(p => colOf(p) === col && fl.every(x => cmp(DB[p].d[x.fieldFilter.field.fieldPath], x.fieldFilter.op, toJs(x.fieldFilter.value)))).map(p => ({ document: fsDoc(p) }));
    return res(200, out.length ? out : [{ readTime: 'x' }]);
  }
  const isCol = path.split('/').length % 2 === 1;
  if (m === 'GET' && isCol) return res(200, { documents: Object.keys(DB).filter(p => colOf(p) === path).map(fsDoc) });
  if (m === 'GET') return DB[path] ? res(200, fsDoc(path)) : res(404, { error: { status: 'NOT_FOUND' } });
  if (m === 'POST' && isCol) {
    const p = path + '/' + u.searchParams.get('documentId');
    if (DB[p]) return res(409, { error: { status: 'ALREADY_EXISTS' } });
    put(p, Object.fromEntries(Object.entries(JSON.parse(init.body).fields).map(([k, v]) => [k, toJs(v)])));
    return res(200, fsDoc(p));
  }
  if (m === 'PATCH') {
    const pre = u.searchParams.get('currentDocument.updateTime');
    if (pre && (!DB[path] || DB[path].t !== pre)) return res(400, { error: { status: 'FAILED_PRECONDITION' } });
    const d = { ...(get(path) || {}) };
    const body = JSON.parse(init.body).fields;
    for (const k of u.searchParams.getAll('updateMask.fieldPaths')) { const kk = k.replace(/`/g, ''); if (kk in body) d[kk] = toJs(body[kk]); else delete d[kk]; }
    put(path, d);
    return res(200, fsDoc(path));
  }
  throw new Error('richiesta inattesa ' + m + ' ' + url);
}

// ---------------------------------------------------------------- scenari (come tests/test_notify.py)
const R = [];
const check = (c, name, det = '') => R.push([!!c, name, det]);
let NOW = 0;
const at = (date, time) => romeToMs(date, time);
function base(now) {
  DB = {}; SENT = []; NOW = now; LEAGUE = null; EX = null; FAIL_FCM = false;
  for (const k of Object.keys(TOKOWNER)) delete TOKOWNER[k];
  const ppl = { admin_g: ['giocatore', true], m1: ['mister', true], c1: ['capitano', true], p2: ['giocatore', true], p3: ['giocatore', true], p4: ['giocatore', true], f1: ['pubblico', true], pend: ['giocatore', false] };
  put('config/team', { coaches: ['admin'] });
  for (const [k, [c, a]] of Object.entries(ppl)) put('players/' + k, { name: k, cat: c, approved: a });
  put('players/rej', { name: 'rej', cat: 'giocatore', approved: false, rejected: true });
  for (const u of ['admin', 'm1', 'c1', 'p2', 'p3', 'p4', 'f1', 'pend', 'rej']) { put('tokens/' + u, { tokens: { ['tok-' + u]: 1 }, prefs: {} }); TOKOWNER['tok-' + u] = u; }
  put('robot/state', { requests: ['pend', 'rej'], uisp: 'x', esempi: ['promemoria-esempio-4'] });
}
async function go(mode = 'cron', max = 48) { SENT = []; CALLS = 0; const f = counted(fakeFetch, max); await run(ENV, { mode, now: NOW, fetch: f }); return SENT; }
const who = (s, part = '') => [...new Set(s.filter(([, d]) => d.title.includes(part)).map(([u]) => u))].sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const T0 = at('2026-11-17', '14:00');

// orario di Roma (anche col cambio d'ora)
check(new Date(at('2026-11-20', '21:00')).toISOString() === '2026-11-20T20:00:00.000Z', 'Ora di Roma in inverno (UTC+1)');
check(new Date(at('2026-07-10', '21:00')).toISOString() === '2026-07-10T19:00:00.000Z', 'Ora di Roma in estate (UTC+2)');

// 1. richieste di iscrizione
base(T0); put('players/nuovo', { name: 'Mario Rossi', cat: 'dirigente', approved: false, createdAt: T0 - 5000 });
let s = await go('ping');
check(eq(who(s, 'Nuova richiesta'), ['admin']), 'Richiesta iscrizione: notifica solo all\'amministratore (subito, con la chiamata dell\'app)', s);
check(s.some(([, d]) => d.body.includes('Mario Rossi (Dirigente)')), 'Richiesta iscrizione: testo con nome e categoria');
check(s.length === 1, 'Richiesta iscrizione: nessun\'altra notifica', s);
check(!(await go()).length, 'Richiesta iscrizione: non ripetuta al giro dopo');
base(T0); delete DB['tokens/admin']; put('players/nuovo2', { name: 'N2', cat: 'giocatore', approved: false });
check(!(await go()).length, 'Richiesta con admin senza notifiche attive: non avvisa nessun altro');
base(T0); put('players/n3', { name: 'Sofia', cat: 'social', approved: false });
check((await go()).some(([, d]) => d.body.includes('Social media manager')), 'Richiesta: categoria Social media manager per esteso');

// 2. coda dell'app
base(T0); put('outbox/a', { kind: 'post', title: '📣 Nuova comunicazione', body: 'ciao', sent: false, createdAt: T0 - 1500 });
s = await go('ping');
check(eq(who(s), ['admin', 'c1', 'f1', 'm1', 'p2', 'p3', 'p4']), 'Comunicazione: a tutti gli approvati, non a in attesa/rifiutati', who(s));
check(get('outbox/a').sent === true, 'Comunicazione: segnata come inviata');
check(!(await go()).length && !(await go('ping')).length, 'Comunicazione: non reinviata');
check((get('robot/log').lines || []).some(l => l.includes('in coda da 2 s')), 'Registro: scrive il tempo di attesa', get('robot/log'));
base(T0); get('tokens/p2').prefs = { posts: false }; put('outbox/a', { kind: 'poll', title: 'Sondaggio', sent: false });
check(!who(await go('ping')).includes('p2'), 'Sondaggio: rispetta chi ha disattivato le comunicazioni');
base(T0); put('outbox/t', { kind: 'test', title: 'Prova', sent: false });
check(eq(who(await go('ping')), ['admin']), 'Notifica di prova: solo amministratore');
base(T0); delete DB['tokens/admin']; put('outbox/t', { kind: 'test', title: 'Prova', sent: false });
check(!(await go('ping')).length, 'Notifica di prova senza telefono admin: non va alla squadra');
base(T0); put('events/ev', { type: 'partita', date: '2026-11-25', time: '21:00', opponent: 'X' });
put('rsvp/p2', { answers: { ev: 'no' } }); put('rsvp/c1', { answers: { ev: 'si' } }); put('rsvp/admin_g', { answers: { ev: 'forse' } });
put('outbox/r', { kind: 'remind', eventId: 'ev', title: '⏰ promemoria', sent: false });
check(eq(who(await go('ping'), 'promemoria'), ['f1', 'm1', 'p3', 'p4']), 'Promemoria manuale: solo a chi non ha risposto');
// due giri contemporanei (chiamata dell'app + minuto): nessun doppione
base(T0); put('outbox/a', { kind: 'post', title: 'Doppia', sent: false });
SENT = []; await Promise.all([run(ENV, { mode: 'ping', now: NOW, fetch: counted(fakeFetch) }), run(ENV, { mode: 'cron', now: NOW, fetch: counted(fakeFetch) })]);
check(SENT.length === 7, 'Due giri insieme: ognuno riceve la comunicazione una volta sola', SENT.length);

// 3. promemoria partite 24/12/2 ore
async function match(now, answers) {
  base(now); put('events/ev', { type: 'partita', date: '2026-11-20', time: '21:00', opponent: 'Oasi', location: 'Riccione' });
  for (const [u, a] of Object.entries(answers)) put('rsvp/' + u, { answers: { ev: a } });
}
await match(at('2026-11-19', '20:00'), { p2: 'no', c1: 'si', m1: 'forse', admin_g: 'si' });
check(!who(await go(), 'Oasi').length, 'Partita: 25 ore prima nessun promemoria');
NOW = at('2026-11-19', '21:03'); s = await go();
check(s.length && s[0][1].title.includes('Domani'), 'Partita: 24 ore prima arriva "Domani"', s[0]);
check(eq(who(s, 'Oasi'), ['admin', 'c1', 'f1', 'm1', 'p3', 'p4']), 'Partita 24h: a presenti/forse e senza risposta, mai agli assenti', who(s));
check(s.filter(([u]) => ['p3', 'p4', 'f1'].includes(u)).every(([, d]) => d.body.includes('Non hai ancora risposto')) && s.filter(([u]) => ['c1', 'm1', 'admin'].includes(u)).every(([, d]) => d.body.includes('Ci vediamo')), 'Partita 24h: testo diverso per chi non ha risposto');
check(!(await go()).length, 'Partita 24h: non ripetuto');
NOW = at('2026-11-20', '09:05'); s = await go(); check(s.length && s[0][1].title.includes('Tra 12 ore'), 'Partita: promemoria 12 ore prima');
NOW = at('2026-11-20', '19:05'); s = await go(); check(s.length && s[0][1].title.includes('Tra 2 ore') && !who(s).includes('p2'), 'Partita: promemoria 2 ore prima (non agli assenti)');
NOW = at('2026-11-20', '22:00'); check(!(await go()).length, 'Partita iniziata: nessun promemoria');
await match(at('2026-11-20', '19:30'), {}); s = await go();
check(new Set(s.map(([, d]) => d.title)).size === 1 && s[0][1].title.includes('Tra 2 ore'), 'Robot in ritardo: solo il promemoria più vicino');
check(!(await go()).length, 'Robot in ritardo: poi niente doppioni');
// partita UISP dal campionato
base(at('2026-11-19', '21:01'));
LEAGUE = { team: 'The Rimineser F.P.', updated: 'x', standings: [], rounds: [{ n: 7, matches: [{ home: 'Oasi del Mare', away: 'THE RIMINESER F.P.', date: '2026-11-20', time: '21:00', field: 'Riccione' }] }] };
s = await go(); check(s.length === 7 && s[0][1].title === '⚽ Domani: The Rimineser F.P. vs Oasi del Mare' && s[0][1].body.includes('Campo Riccione'), 'Partita UISP: promemoria dal calendario del campionato', s[0]);

// allenamento
base(at('2026-11-18', '11:00')); put('events/tr', { type: 'allenamento', date: '2026-11-19', time: '20:30' }); put('rsvp/p2', { answers: { tr: 'si' } });
check(!(await go()).length, 'Allenamento: prima delle 12 del giorno prima niente');
NOW = at('2026-11-18', '12:10'); s = await go();
check(eq(who(s, 'Domani'), ['admin', 'c1', 'f1', 'm1', 'p3', 'p4']), 'Allenamento: dalle 12 del giorno prima solo a chi non ha risposto', who(s));
check(!(await go()).length, 'Allenamento: non ripetuto');

// 4. comunicato UISP
base(T0); LEAGUE = { team: 'The Rimineser F.P.', updated: '2026-11-17 nuovo', standings: [{ team: 'Altri' }, { team: 'The Rimineser F.P.' }], rounds: [{ n: 4, matches: [{ home: 'The Rimineser F.P.', away: 'Oasi', hg: 3, ag: 1 }] }, { n: 5, matches: [{ home: 'Bar', away: 'The Rimineser F.P.', date: '2026-11-27', time: '21:30' }] }] };
s = await go(); check(s.length === 7 && s[0][1].body === 'The Rimineser F.P. 3-1 Oasi · siamo 2° in classifica · prossima: Bar 27/11 21:30', 'UISP: nuovo comunicato a tutti con risultato, posizione e prossima', s[0]);
check(!(await go()).length, 'UISP: non ripetuto');
base(T0); delete get('robot/state').uisp; LEAGUE = { team: 'X', updated: 'primo', rounds: [], standings: [] };
check(!(await go()).length && get('robot/state').uisp === 'primo', 'UISP: al primissimo avvio non avvisa');

// notifica di esempio
base(T0); EX = { id: 'nuovo-esempio', title: 'Esempio', body: 'b' };
check(eq(who(await go()), ['admin']), 'Esempio: solo all\'amministratore'); check(!(await go()).length, 'Esempio: una volta sola');

// 5. token scaduto pulito
base(T0); put('tokens/p3', { tokens: { 'dead-1': 1, 'tok-p3': 2 } }); TOKOWNER['dead-1'] = 'p3'; put('outbox/a', { kind: 'post', title: 'x', sent: false });
await go('ping'); check(eq(Object.keys(get('tokens/p3').tokens), ['tok-p3']), 'Telefono non più valido: rimosso, l\'altro resta', get('tokens/p3'));

// 6. limite chiamate di Cloudflare: invii in eccesso al minuto dopo, nessuno perso o doppio
base(T0); for (let i = 0; i < 60; i++) { put('players/x' + i, { name: 'x' + i, approved: true }); put('tokens/x' + i, { tokens: { ['tok-x' + i]: 1 } }); TOKOWNER['tok-x' + i] = 'x' + i; }
put('outbox/a', { kind: 'post', title: 'Tanti', sent: false });
const first = (await go('ping')).length;
check(first > 0 && first < 67 && get('robot/coda').jobs.length === 67 - first, 'Tanti telefoni: parte subito il possibile, il resto va in coda', [first, (get('robot/coda').jobs || []).length]);
let total = first; for (let i = 0; i < 4; i++) total += (await go()).length;
check(total === 67 && get('robot/coda').jobs.length === 0, 'Tanti telefoni: entro pochi minuti arrivano tutti, una volta sola', total);
check(CALLS <= 48, 'Mai oltre 48 chiamate per giro', CALLS);
// più comunicazioni insieme con tanti telefoni: nessuna persa, nessun doppione, mai oltre il limite
base(T0); for (let i = 0; i < 60; i++) { put('players/x' + i, { name: 'x' + i, approved: true }); put('tokens/x' + i, { tokens: { ['tok-x' + i]: 1 } }); TOKOWNER['tok-x' + i] = 'x' + i; }
for (const k of ['a', 'b', 'c']) put('outbox/' + k, { kind: 'post', title: 'Multi ' + k, sent: false, createdAt: T0 });
let all = [], maxCalls = 0; for (let i = 0; i < 10; i++) { all.push(...await go(i ? 'cron' : 'ping')); maxCalls = Math.max(maxCalls, CALLS); }
const per = new Set(all.map(([u, d]) => u + '|' + d.title));
check(all.length === 201 && per.size === 201, 'Tre comunicazioni a 67 telefoni: 201 notifiche, nessun doppione', all.length);
check(maxCalls <= 48, 'Tre comunicazioni: mai oltre 48 chiamate per giro', maxCalls);
// giro tranquillo: poche letture di Firestore
base(T0); await go(); check(CALLS <= 9, 'Giro senza novità: poche chiamate (' + CALLS + ')', CALLS);
check(typeof get('robot/state').workerAt === 'number', 'Battito del Worker salvato per il robot di riserva');

// 7. chiamata dall'app: accesso verificato
globalThis.fetch = fakeFetch;
base(T0); put('outbox/a', { kind: 'post', title: 'Da app', sent: false });
const req = async tok => worker.fetch(new Request('https://w/', { method: 'POST', headers: tok ? { Authorization: 'Bearer ' + tok } : {} }), ENV);
check((await req(null)).status === 401 && !get('outbox/a').sent, 'App: senza accesso rifiutata');
check((await req(await idToken({ aud: 'altro' }))).status === 401, 'App: accesso di un altro progetto rifiutato');
check((await req(await idToken({}, saKey.privateKey))).status === 401, 'App: firma falsa rifiutata');
check((await req(await idToken({ exp: Math.floor(Date.now() / 1000) - 10 }))).status === 401, 'App: accesso scaduto rifiutato');
const ok = await req(await idToken());
check(ok.status === 200 && (await ok.json()).sent === 7 && get('outbox/a').sent, 'App: accesso valido → invio immediato');
check((await worker.fetch(new Request('https://w/', { method: 'OPTIONS' }), ENV)).headers.get('Access-Control-Allow-Origin') === '*', 'App: CORS per il browser');

const bad = R.filter(r => !r[0]);
for (const r of bad) console.log('FALLITO', r[1], '->', JSON.stringify(r[2]).slice(0, 300));
console.log(`Worker notifiche: ${R.length - bad.length}/${R.length} controlli superati`);
process.exit(bad.length ? 1 : 0);
