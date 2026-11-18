// Test delle regole Firestore (eseguiti dal robot GitHub "Test regole" sull'emulatore ufficiale).
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection, deleteField, serverTimestamp, increment, query, orderBy, limit } from 'firebase/firestore';
import { readFileSync, writeFileSync } from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'rimineser-test',
  firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 },
});

const PEOPLE = {
  m1: 'mister', c1: 'capitano', pr1: 'preparatore', s1: 'social', a1: 'allenatore', p2: 'giocatore', d1: 'dirigente', f1: 'pubblico',
};
async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config/team'), { coaches: ['admin'], instagram: '' });
    await setDoc(doc(db, 'players/admin_g'), { name: 'Giacomo Lucidi', cat: 'giocatore', approved: true, owner: 'admin' });
    for (const [uid, cat] of Object.entries(PEOPLE)) await setDoc(doc(db, 'players/' + uid), { name: uid, cat, approved: true });
    await setDoc(doc(db, 'players/p4'), { name: 'Senza categoria', approved: true });
    await setDoc(doc(db, 'players/pend'), { name: 'In attesa', cat: 'giocatore', approved: false });
    await setDoc(doc(db, 'players/rej'), { name: 'Rifiutato', cat: 'giocatore', approved: false, rejected: true });
    await setDoc(doc(db, 'posts/x'), { text: 'Ciao', author: 'm1', createdAt: 1 });
    await setDoc(doc(db, 'events/ev'), { type: 'partita', date: '2026-12-01', lineups: [{ name: 'A', published: true }] });
    await setDoc(doc(db, 'events/tr'), { type: 'allenamento', date: '2026-12-02' });
    await setDoc(doc(db, 'private/robot'), { token: 'segreto' });
  });
}
const db = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

const results = [];
async function t(name, expectOk, fn) {
  await seed();
  let ok, err = '';
  try { await (expectOk ? assertSucceeds(fn()) : assertFails(fn())); ok = true; } catch (e) { ok = false; err = String(e.message || e).slice(0, 160); }
  results.push({ ok, name: `${expectOk ? 'PERMESSO ' : 'BLOCCATO '} ${name}`, err });
}

const POSTERS = ['admin', 'm1', 'c1', 'pr1', 's1'];
const ALL = ['admin', ...Object.keys(PEOPLE), 'p4'];
for (const u of ALL) {
  const can = POSTERS.includes(u), lu = ['admin', 'c1', 'm1'].includes(u);
  await t(`${u}: nuova comunicazione`, can, () => addDoc(collection(db(u), 'posts'), { text: 'Prova', author: u, createdAt: 2 }));
  await t(`${u}: nuovo sondaggio`, can, () => addDoc(collection(db(u), 'posts'), { text: 'Sondaggio', options: ['a', 'b'], author: u, createdAt: 2 }));
  await t(`${u}: elimina comunicazione`, can, () => deleteDoc(doc(db(u), 'posts/x')));
  await t(`${u}: legge comunicazioni`, true, () => getDoc(doc(db(u), 'posts/x')));
  await t(`${u}: modifica formazione`, lu, () => updateDoc(doc(db(u), 'events/ev'), { lineups: [{ name: 'B', published: true }], lockAt: Date.now() + 86400000 }));
  await t(`${u}: crea partita già con formazione`, lu, () => setDoc(doc(db(u), 'events/nuovo'), { type: 'partita', date: '2026-12-09', lineups: [{ name: 'A' }], lockAt: Date.now() + 86400000 }));
  await t(`${u}: crea evento senza formazione`, true, () => setDoc(doc(db(u), 'events/nuovo2'), { type: 'allenamento', date: '2026-12-09' }));
  await t(`${u}: modifica orario partita (formazione invariata)`, true, () => setDoc(doc(db(u), 'events/ev'), { type: 'partita', date: '2026-12-01', time: '21:00', lineups: [{ name: 'A', published: true }] }, { merge: true }));
  await t(`${u}: segna presenza`, true, () => setDoc(doc(db(u), 'rsvp/' + u), { answers: { ev: 'si' } }, { merge: true }));
  await t(`${u}: vota sondaggio`, true, () => setDoc(doc(db(u), 'votes/' + u), { answers: { x: 0 } }, { merge: true }));
  await t(`${u}: notifica "comunicazione" in coda`, can, () => addDoc(collection(db(u), 'outbox'), { kind: 'post', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica "formazione" in coda`, lu, () => addDoc(collection(db(u), 'outbox'), { kind: 'lineup', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica "promemoria presenze" in coda`, u === 'admin', () => addDoc(collection(db(u), 'outbox'), { kind: 'remind', eventId: 'ev', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica di prova`, u === 'admin', () => addDoc(collection(db(u), 'outbox'), { kind: 'test', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica senza tipo (= comunicazione)`, can, () => addDoc(collection(db(u), 'outbox'), { title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica di tipo inventato`, false, () => addDoc(collection(db(u), 'outbox'), { kind: 'boh', title: 't', sent: false }));
}
for (const u of Object.keys(PEOPLE)) {
  const priv = ['mister', 'capitano', 'preparatore', 'social'].includes(PEOPLE[u]);
  if (PEOPLE[u] !== 'capitano') await t(`${u}: si promuove Capitano da solo`, false, () => updateDoc(doc(db(u), 'players/' + u), { cat: 'capitano' }));
  if (PEOPLE[u] !== 'mister') await t(`${u}: si promuove Mister da solo`, false, () => updateDoc(doc(db(u), 'players/' + u), { cat: 'mister' }));
  if (PEOPLE[u] !== 'social') await t(`${u}: si promuove Social da solo`, false, () => updateDoc(doc(db(u), 'players/' + u), { cat: 'social' }));
  await t(`${u}: cambia la propria categoria in "pubblico"`, !priv, () => updateDoc(doc(db(u), 'players/' + u), { cat: 'pubblico' }));
  await t(`${u}: cambia nome e numero`, true, () => updateDoc(doc(db(u), 'players/' + u), { name: 'Nuovo nome', number: '12' }));
  await t(`${u}: salva profilo con stessa categoria`, true, () => updateDoc(doc(db(u), 'players/' + u), { name: 'X', number: '', cat: PEOPLE[u] }));
  await t(`${u}: si dà un'etichetta/campo extra`, false, () => updateDoc(doc(db(u), 'players/' + u), { tag: 'capitano' }));
  await t(`${u}: modifica categoria di un altro`, false, () => updateDoc(doc(db(u), 'players/p2'), { cat: 'mister' }));
  await t(`${u}: legge il gettone del robot`, false, () => getDoc(doc(db(u), 'private/robot')));
  await t(`${u}: scrive il gettone del robot`, false, () => setDoc(doc(db(u), 'private/robot'), { token: 'x' }));
  await t(`${u}: si fa amministratore`, false, () => updateDoc(doc(db(u), 'config/team'), { coaches: ['admin', u] }));
  await t(`${u}: cambia Instagram`, true, () => updateDoc(doc(db(u), 'config/team'), { instagram: 'pagina' }));
}
// amministratore
await t('admin: assegna Capitano', true, () => updateDoc(doc(db('admin'), 'players/p2'), { cat: 'capitano' }));
await t('admin: assegna Social media manager', true, () => updateDoc(doc(db('admin'), 'players/p2'), { cat: 'social' }));
await t('admin: toglie Mister', true, () => updateDoc(doc(db('admin'), 'players/m1'), { cat: 'giocatore' }));
await t('admin: approva richiesta', true, () => updateDoc(doc(db('admin'), 'players/pend'), { approved: true }));
await t('admin: rifiuta richiesta', true, () => updateDoc(doc(db('admin'), 'players/pend'), { rejected: true }));
await t('admin: salva profilo Giacomo come Capitano', true, () => setDoc(doc(db('admin'), 'players/admin_g'), { cat: 'capitano', approved: true }, { merge: true }));
await t('admin: presenza per Giacomo', true, () => setDoc(doc(db('admin'), 'rsvp/admin_g'), { answers: { ev: 'si' } }, { merge: true }));
await t('admin: legge il gettone del robot', true, () => getDoc(doc(db('admin'), 'private/robot')));
await t('admin: scrive il gettone del robot', true, () => setDoc(doc(db('admin'), 'private/robot'), { token: 'x' }, { merge: true }));
// iscrizione, attesa, rifiuto, estranei
await t('nuovo utente: si iscrive come giocatore', true, () => setDoc(doc(db('nuovo'), 'players/nuovo'), { name: 'N', number: '', cat: 'giocatore', approved: false, createdAt: 1 }));
await t('nuovo utente: si iscrive come preparatore', false, () => setDoc(doc(db('nuovo'), 'players/nuovo'), { name: 'N', cat: 'preparatore', approved: false }));
await t('nuovo utente: si iscrive come Capitano', false, () => setDoc(doc(db('nuovo'), 'players/nuovo'), { name: 'N', cat: 'capitano', approved: false }));
await t('nuovo utente: si iscrive già approvato', false, () => setDoc(doc(db('nuovo'), 'players/nuovo'), { name: 'N', cat: 'giocatore', approved: true }));
await t('nuovo utente: iscrive un altro', false, () => setDoc(doc(db('nuovo'), 'players/altro'), { name: 'N', cat: 'giocatore', approved: false }));
await t('in attesa: si approva da solo', false, () => updateDoc(doc(db('pend'), 'players/pend'), { approved: true }));
await t('in attesa: legge le comunicazioni', false, () => getDoc(doc(db('pend'), 'posts/x')));
await t('in attesa: legge la rosa degli altri', false, () => getDoc(doc(db('pend'), 'players/m1')));
await t('in attesa: legge il proprio profilo', true, () => getDoc(doc(db('pend'), 'players/pend')));
await t('in attesa: cambia categoria in dirigente', true, () => updateDoc(doc(db('pend'), 'players/pend'), { cat: 'dirigente' }));
await t('in attesa: cambia categoria in Mister', false, () => updateDoc(doc(db('pend'), 'players/pend'), { cat: 'mister' }));
await t('in attesa: legge il gettone del robot', false, () => getDoc(doc(db('pend'), 'private/robot')));
await t('in attesa: mette notifiche in coda', false, () => addDoc(collection(db('pend'), 'outbox'), { kind: 'remind', sent: false }));
await t('rifiutato: si toglie il rifiuto', false, () => updateDoc(doc(db('rej'), 'players/rej'), { rejected: deleteField() }));
await t('rifiutato: legge le comunicazioni', false, () => getDoc(doc(db('rej'), 'posts/x')));
await t('non registrato: legge le comunicazioni', false, () => getDoc(doc(db(null), 'posts/x')));
await t('non registrato: legge la rosa', false, () => getDoc(doc(db(null), 'players/m1')));
// config/team: leggibile da iscritti e da chi non ha ancora un profilo; NON da chi è in attesa/rifiutato
await t('membro: legge config/team', true, () => getDoc(doc(db('p2'), 'config/team')));
await t('admin: legge config/team', true, () => getDoc(doc(db('admin'), 'config/team')));
await t('nuovo senza profilo: legge config/team (serve al primo avvio/registrazione)', true, () => getDoc(doc(db('nuovo'), 'config/team')));
await t('in attesa: NON legge config/team (uid admin nascosti)', false, () => getDoc(doc(db('pend'), 'config/team')));
await t('rifiutato: NON legge config/team', false, () => getDoc(doc(db('rej'), 'config/team')));
await t('in attesa: legge comunque il proprio profilo (schermata attesa)', true, () => getDoc(doc(db('pend'), 'players/pend')));
await t('rifiutato: legge comunque il proprio profilo (schermata rifiuto)', true, () => getDoc(doc(db('rej'), 'players/rej')));
// scouting: tutti gli iscritti approvati, ma UNO SOLO alla volta (lock)
const ACTS = [{ id: 'a1', k: 'pass_ok', t: 'us', s: 10, h: 1, ts: 1 }];
const SC = { acts: ACTS, half: 1, base: 0, start: null };
const LK = (uid, ago = 0) => ({ uid, name: uid, at: new Date(Date.now() - ago) });
const MY = () => ({ uid: 'x', name: 'x', at: serverTimestamp() });
const seedSc = (lock) => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'scout/ev'), lock ? { ...SC, lock } : SC));
const ALLM = ['admin', 'm1', 'c1', 'p2', 'pr1', 's1', 'a1', 'f1', 'd1', 'p4'];
for (const u of ALLM) {
  await t(`${u}: legge lo scouting`, true, async () => { await seedSc(LK('qualcuno')); return getDoc(doc(db(u), 'scout/ev')); });
  await t(`${u}: crea lo scouting prendendo il lock`, true, () => setDoc(doc(db(u), 'scout/ev'), { ...SC, lock: { uid: u, name: u, at: serverTimestamp() } }));
  await t(`${u}: prende il lock libero`, true, async () => { await seedSc(null); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: serverTimestamp() } }); });
  await t(`${u}: segna azioni senza avere il lock`, false, async () => { await seedSc(null); return updateDoc(doc(db(u), 'scout/ev'), { acts: [...ACTS, { id: 'a2', k: 'goal', t: 'us', s: 20, h: 1, ts: 2 }] }); });
  await t(`${u}: segna azioni con il proprio lock`, true, async () => { await seedSc(LK(u)); return updateDoc(doc(db(u), 'scout/ev'), { acts: [...ACTS, { id: 'a2', k: 'goal', t: 'us', s: 20, h: 1, ts: 2 }] }); });
  await t(`${u}: segna azioni mentre un altro ha il lock`, false, async () => { await seedSc(LK('altro', 5000)); return updateDoc(doc(db(u), 'scout/ev'), { acts: [...ACTS, { id: 'a2', k: 'goal', t: 'us', s: 20, h: 1, ts: 2 }] }); });
  await t(`${u}: ruba il lock a chi sta segnando`, false, async () => { await seedSc(LK('altro', 5000)); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: serverTimestamp() } }); });
  await t(`${u}: prende il lock scaduto (3 minuti)`, true, async () => { await seedSc(LK('altro', 3 * 60000)); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: serverTimestamp() } }); });
  await t(`${u}: rinnova il proprio lock`, true, async () => { await seedSc(LK(u, 40000)); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: serverTimestamp() } }); });
  await t(`${u}: lascia il proprio lock`, true, async () => { await seedSc(LK(u)); return updateDoc(doc(db(u), 'scout/ev'), { lock: deleteField() }); });
  await t(`${u}: toglie il lock di un altro`, false, async () => { await seedSc(LK('altro', 5000)); return updateDoc(doc(db(u), 'scout/ev'), { lock: deleteField() }); });
  await t(`${u}: prende il lock a nome di un altro`, false, async () => { await seedSc(null); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: 'altro', name: 'altro', at: serverTimestamp() } }); });
  await t(`${u}: lock con ora finta`, false, async () => { await seedSc(null); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: new Date(2030, 0, 1) } }); });
  await t(`${u}: lock con campi inventati`, false, async () => { await seedSc(null); return updateDoc(doc(db(u), 'scout/ev'), { lock: { uid: u, name: u, at: serverTimestamp(), x: 1 } }); });
}
await t('in attesa: legge lo scouting', false, () => getDoc(doc(db('pend'), 'scout/ev')));
await t('in attesa: prende il lock', false, async () => { await seedSc(null); return updateDoc(doc(db('pend'), 'scout/ev'), { lock: { uid: 'pend', name: 'p', at: serverTimestamp() } }); });
await t('rifiutato: scrive lo scouting', false, () => setDoc(doc(db('rej'), 'scout/ev'), SC));
await t('non registrato: legge lo scouting', false, () => getDoc(doc(db(null), 'scout/ev')));
await t('membro: scouting con campi inventati', false, () => setDoc(doc(db('d1'), 'scout/ev'), { ...SC, nome: 'x' }));
await t('membro: cancella lo scouting', false, async () => { await seedSc(LK('d1')); return deleteDoc(doc(db('d1'), 'scout/ev')); });
await t('admin: cancella lo scouting', true, async () => { await seedSc(LK('d1')); return deleteDoc(doc(db('admin'), 'scout/ev')); });
await t('due prendono il lock insieme: il secondo no', false, async () => { await seedSc(null); await updateDoc(doc(db('p2'), 'scout/ev'), { lock: { uid: 'p2', name: 'p2', at: serverTimestamp() } }); return updateDoc(doc(db('p4'), 'scout/ev'), { lock: { uid: 'p4', name: 'p4', at: serverTimestamp() } }); });
// formazioni bloccate per sempre dall'inizio della partita (lockAt)
const seedEv = (lockAt) => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'events/blk'), { type: 'partita', date: '2026-11-01', time: '21:00', lineups: [{ name: 'A', published: true, slots: ['p2'] }], lockAt }));
const PAST = () => Date.now() - 60000, NEXT = () => Date.now() + 3600000;
for (const u of ['admin', 'c1', 'm1']) {
  await t(`${u}: modifica formazione PRIMA dell'inizio`, true, async () => { await seedEv(NEXT()); return updateDoc(doc(db(u), 'events/blk'), { lineups: [{ name: 'B' }], lockAt: NEXT() }); });
  await t(`${u}: modifica formazione DOPO l'inizio`, false, async () => { await seedEv(PAST()); return updateDoc(doc(db(u), 'events/blk'), { lineups: [{ name: 'B' }], lockAt: NEXT() }); });
  await t(`${u}: toglie le formazioni DOPO l'inizio`, false, async () => { await seedEv(PAST()); return updateDoc(doc(db(u), 'events/blk'), { lineups: deleteField() }); });
  await t(`${u}: sposta in avanti il blocco DOPO l'inizio (per sbloccare)`, false, async () => { await seedEv(PAST()); return updateDoc(doc(db(u), 'events/blk'), { lockAt: NEXT() }); });
  await t(`${u}: toglie il blocco DOPO l'inizio`, false, async () => { await seedEv(PAST()); return updateDoc(doc(db(u), 'events/blk'), { lockAt: deleteField() }); });
  await t(`${u}: cancella l'evento DOPO l'inizio`, false, async () => { await seedEv(PAST()); return deleteDoc(doc(db(u), 'events/blk')); });
  await t(`${u}: salva formazione con blocco nel passato`, false, async () => { await seedEv(NEXT()); return updateDoc(doc(db(u), 'events/blk'), { lineups: [{ name: 'B' }], lockAt: PAST() }); });
  await t(`${u}: salva formazione senza blocco`, false, () => setDoc(doc(db(u), 'events/nuovo2'), { type: 'partita', date: '2026-12-09', lineups: [{ name: 'A' }] }));
  await t(`${u}: sposta la partita (e il blocco) PRIMA dell'inizio`, true, async () => { await seedEv(NEXT()); return updateDoc(doc(db(u), 'events/blk'), { time: '22:00', lockAt: NEXT() + 3600000 }); });
}
await t('admin: segna il risultato DOPO l\'inizio (formazioni intatte)', true, async () => { await seedEv(PAST()); return updateDoc(doc(db('admin'), 'events/blk'), { result: { us: 3, them: 1 } }); });
await t('membro: aggiunge note DOPO l\'inizio (formazioni intatte)', true, async () => { await seedEv(PAST()); return updateDoc(doc(db('p2'), 'events/blk'), { notes: 'bella partita' }); });
await t('membro: imposta il blocco (non può)', false, async () => { await seedEv(NEXT()); return updateDoc(doc(db('p2'), 'events/blk'), { lockAt: NEXT() + 1000 }); });
await t('membro: cancella evento futuro senza blocco attivo', true, async () => { await seedEv(NEXT()); return deleteDoc(doc(db('p2'), 'events/blk')); });
// chi sta facendo lo scouting può cambiare la formazione (fino a 5 ore dopo l'inizio)
const seedLive = (lockAt, scLock) => env.withSecurityRulesDisabled(async c => { const d = c.firestore();
  await setDoc(doc(d, 'events/live'), { type: 'partita', date: '2026-11-18', time: '22:00', lineups: [{ name: 'A', published: true, module: '2-3-1', slots: ['p2'], bench: ['p4'] }], lockAt });
  if (scLock) await setDoc(doc(d, 'scout/live'), { acts: [], half: 1, base: 0, start: null, lock: scLock }); });
const SUB = { lineups: [{ name: 'A', published: true, module: '2-3-1', slots: ['p4'], bench: ['p2'] }] };
await t('scouting (giocatore col lock): fa una sostituzione', true, async () => { await seedLive(NEXT(), LK('p2')); return updateDoc(doc(db('p2'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('scouting (dirigente col lock): cambia modulo', true, async () => { await seedLive(NEXT(), LK('d1')); return updateDoc(doc(db('d1'), 'events/live'), { lineups: [{ name: 'A', published: true, module: '3-2-1', slots: ['p2'], bench: ['p4'] }], lockAt: NEXT() }); });
await t('scouting: crea la formazione se non c\'è', true, async () => { await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'scout/nuova'), { acts: [], lock: LK('p2') })); return setDoc(doc(db('p2'), 'events/nuova'), { lineups: [{ name: 'A' }], lockAt: NEXT() }); });
await t('giocatore senza lock: cambia la formazione', false, async () => { await seedLive(NEXT(), LK('altro')); return updateDoc(doc(db('p2'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('giocatore con lock scaduto (3 minuti): cambia la formazione', false, async () => { await seedLive(NEXT(), LK('p2', 3 * 60000)); return updateDoc(doc(db('p2'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('giocatore col lock di UN\'ALTRA partita: cambia questa', false, async () => { await seedLive(NEXT(), null); await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'scout/altra'), { acts: [], lock: LK('p2') })); return updateDoc(doc(db('p2'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('scouting col lock: cambia la formazione DOPO il blocco (5 ore)', false, async () => { await seedLive(PAST(), LK('p2')); return updateDoc(doc(db('p2'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('capitano: cambia la formazione durante la partita (prima delle 5 ore)', true, async () => { await seedLive(NEXT(), LK('p2')); return updateDoc(doc(db('c1'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('mister: cambia la formazione durante la partita', true, async () => { await seedLive(NEXT(), LK('p2')); return updateDoc(doc(db('m1'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('in attesa con un lock finto: cambia la formazione', false, async () => { await seedLive(NEXT(), LK('pend')); return updateDoc(doc(db('pend'), 'events/live'), { ...SUB, lockAt: NEXT() }); });
await t('qualsiasi: crea squadra già esistente', false, () => setDoc(doc(db('nuovo'), 'config/team'), { coaches: ['nuovo'] }));
// "chi è online"
await t('membro: scrive il proprio battito online', true, () => setDoc(doc(db('p2'), 'presence/p2'), { at: serverTimestamp() }));
await t('admin: scrive il proprio battito online', true, () => setDoc(doc(db('admin'), 'presence/admin'), { at: serverTimestamp() }));
await t('membro: battito online di un altro', false, () => setDoc(doc(db('p2'), 'presence/m1'), { at: serverTimestamp() }));
await t('membro: battito online con ora finta', false, () => setDoc(doc(db('p2'), 'presence/p2'), { at: new Date(2030, 0, 1) }));
await t('membro: battito online con altri campi', false, () => setDoc(doc(db('p2'), 'presence/p2'), { at: serverTimestamp(), x: 1 }));
await t('in attesa: scrive battito online', false, () => setDoc(doc(db('pend'), 'presence/pend'), { at: serverTimestamp() }));
await t('membro: legge chi è online', false, () => getDoc(doc(db('p2'), 'presence/m1')));
await t('admin: legge chi è online', false, () => getDoc(doc(db('admin'), 'presence/m1')));
await t('membro: legge il proprio battito', false, () => getDoc(doc(db('p2'), 'presence/p2')));
await t('membro: elenca chi è online', false, () => getDocs(collection(db('p2'), 'presence')));
await t('membro: legge quante persone sono online', true, () => getDoc(doc(db('p2'), 'stats/online')));
await t('in attesa: legge quante persone sono online', false, () => getDoc(doc(db('pend'), 'stats/online')));
await t('admin: scrive il numero di online', false, () => setDoc(doc(db('admin'), 'stats/online'), { n: 99 }));
await t('in attesa: legge chi è online', false, () => getDoc(doc(db('pend'), 'presence/m1')));
await t('non registrato: legge chi è online', false, () => getDoc(doc(db(null), 'presence/m1')));
await t('membro: toglie il proprio battito', true, () => deleteDoc(doc(db('p2'), 'presence/p2')));
await t('membro: toglie il battito di un altro', false, () => deleteDoc(doc(db('p2'), 'presence/m1')));
// visualizzazioni (solo conteggi anonimi)
await t('membro: conta un\'apertura (mese nuovo)', true, () => setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d17: increment(1), day: 'd17' }, { merge: true }));
await t('membro: conta un\'apertura (mese esistente)', true, async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'stats/views-2026-11'), { total: 5, d17: 3, day: 'd17' }));
  return setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d17: increment(1), day: 'd17' }, { merge: true }); });
await t('membro: conta un\'apertura in un giorno nuovo del mese', true, async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'stats/views-2026-11'), { total: 5, d17: 3, day: 'd17' }));
  return setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d18: increment(1), day: 'd18' }, { merge: true }); });
await t('membro: aggiunge +5 visualizzazioni', false, async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'stats/views-2026-11'), { total: 5, d17: 3, day: 'd17' }));
  return setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(5), d17: increment(5), day: 'd17' }, { merge: true }); });
await t('membro: azzera le visualizzazioni', false, async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'stats/views-2026-11'), { total: 5, d17: 3, day: 'd17' }));
  return setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: 0, d17: 0, day: 'd17' }); });
await t('membro: scrive il proprio nome nelle visualizzazioni', false, () => setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d17: increment(1), day: 'd17', chi: 'p2' }, { merge: true }));
await t('membro: +1 su due giorni insieme', false, () => setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d17: increment(1), d18: increment(1), day: 'd17' }, { merge: true }));
await t('membro: +1 al totale senza giorno', false, () => setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1) }, { merge: true }));
await t('membro: "day" che non corrisponde al giorno incrementato', false, async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'stats/views-2026-11'), { total: 5, d17: 3, day: 'd17' }));
  return setDoc(doc(db('p2'), 'stats/views-2026-11'), { total: increment(1), d18: increment(1), day: 'd17' }, { merge: true }); });
await t('membro: documento visualizzazioni con nome inventato', false, () => setDoc(doc(db('p2'), 'stats/views-p2'), { total: 1, d17: 1 }));
await t('membro: scrive il numero di online', false, () => setDoc(doc(db('p2'), 'stats/online'), { n: 1 }));
await t('membro: legge le visualizzazioni', false, () => getDoc(doc(db('p2'), 'stats/views-2026-11')));
await t('admin: legge le visualizzazioni', true, () => getDoc(doc(db('admin'), 'stats/views-2026-11')));
await t('in attesa: conta un\'apertura', false, () => setDoc(doc(db('pend'), 'stats/views-2026-11'), { total: increment(1), d17: increment(1), day: 'd17' }, { merge: true }));
await t('membro: cancella le visualizzazioni', false, () => deleteDoc(doc(db('p2'), 'stats/views-2026-11')));
await t('membro: legge la coda notifiche', false, () => getDoc(doc(db('p2'), 'outbox/qualcosa')));
await t('membro: comunicazione troppo lunga (capitano)', false, () => addDoc(collection(db('c1'), 'posts'), { text: 'x'.repeat(6000) }));

// diretta (live/{evento}): la legge chiunque, anche senza account; la scrive solo chi ha il lock dello scouting di quella partita
const LV = () => ({ eid: 'ev', us: 'The Rimineser F.P.', opp: 'Oasi del Mare', half: 1, base: 0, start: null, ended: false, gu: 0, gt: 0, acts: ACTS, lu: { m: '2-3-1', f: [{ id: 'm1', n: '7' }], b: [] }, updatedAt: serverTimestamp() });
const seedLv = () => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'live/ev'), { ...LV(), updatedAt: new Date() }));
await t('non registrato: legge la diretta', true, async () => { await seedLv(); return getDoc(doc(db(null), 'live/ev')); });
await t('non registrato: cerca la diretta più recente', true, async () => { await seedLv(); return getDocs(query(collection(db(null), 'live'), orderBy('updatedAt', 'desc'), limit(1))); });
await t('in attesa: legge la diretta', true, async () => { await seedLv(); return getDoc(doc(db('pend'), 'live/ev')); });
await t('membro: legge la diretta', true, async () => { await seedLv(); return getDoc(doc(db('p2'), 'live/ev')); });
await t('non registrato: scrive la diretta', false, async () => { await seedSc(LK('p2')); return setDoc(doc(db(null), 'live/ev'), LV()); });
for (const u of ['admin', 'p2', 'd1']) {
  await t(`${u}: scrive la diretta con il proprio lock dello scouting`, true, async () => { await seedSc(LK(u)); return setDoc(doc(db(u), 'live/ev'), LV()); });
  await t(`${u}: scrive la diretta senza lock`, false, async () => { await seedSc(null); return setDoc(doc(db(u), 'live/ev'), LV()); });
  await t(`${u}: scrive la diretta mentre lo scouting lo fa un altro`, false, async () => { await seedSc(LK('altro', 5000)); return setDoc(doc(db(u), 'live/ev'), LV()); });
  await t(`${u}: scrive la diretta con il lock scaduto`, false, async () => { await seedSc(LK(u, 3 * 60000)); return setDoc(doc(db(u), 'live/ev'), LV()); });
}
await t('membro: diretta con campi inventati (es. nomi)', false, async () => { await seedSc(LK('p2')); return setDoc(doc(db('p2'), 'live/ev'), { ...LV(), nomi: ['Mario Rossi'] }); });
await t('membro: diretta di un\'altra partita nel documento', false, async () => { await seedSc(LK('p2')); return setDoc(doc(db('p2'), 'live/ev'), { ...LV(), eid: 'altra' }); });
await t('membro: diretta con ora finta', false, async () => { await seedSc(LK('p2')); return setDoc(doc(db('p2'), 'live/ev'), { ...LV(), updatedAt: new Date(2030, 0, 1) }); });
await t('in attesa: scrive la diretta', false, async () => { await seedSc(LK('pend')); return setDoc(doc(db('pend'), 'live/ev'), LV()); });
await t('membro: cancella la diretta', false, async () => { await seedLv(); return deleteDoc(doc(db('p2'), 'live/ev')); });
await t('admin: cancella la diretta', true, async () => { await seedLv(); return deleteDoc(doc(db('admin'), 'live/ev')); });

await env.cleanup();
const bad = results.filter(r => !r.ok);
const out = [`Test regole Firestore: ${results.length - bad.length}/${results.length} superati`, '', ...bad.map(r => `FALLITO ${r.name} ${r.err}`)].join('\n');
writeFileSync(new URL('./risultato.txt', import.meta.url), out + '\n');
console.log(out);
process.exit(bad.length ? 1 : 0);
