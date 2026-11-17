// Test delle regole Firestore (eseguiti dal robot GitHub "Test regole" sull'emulatore ufficiale).
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, deleteField } from 'firebase/firestore';
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
  const can = POSTERS.includes(u), lu = ['admin', 'c1'].includes(u);
  await t(`${u}: nuova comunicazione`, can, () => addDoc(collection(db(u), 'posts'), { text: 'Prova', author: u, createdAt: 2 }));
  await t(`${u}: nuovo sondaggio`, can, () => addDoc(collection(db(u), 'posts'), { text: 'Sondaggio', options: ['a', 'b'], author: u, createdAt: 2 }));
  await t(`${u}: elimina comunicazione`, can, () => deleteDoc(doc(db(u), 'posts/x')));
  await t(`${u}: legge comunicazioni`, true, () => getDoc(doc(db(u), 'posts/x')));
  await t(`${u}: modifica formazione`, lu, () => updateDoc(doc(db(u), 'events/ev'), { lineups: [{ name: 'B', published: true }] }));
  await t(`${u}: crea partita già con formazione`, lu, () => setDoc(doc(db(u), 'events/nuovo'), { type: 'partita', date: '2026-12-09', lineups: [{ name: 'A' }] }));
  await t(`${u}: crea evento senza formazione`, true, () => setDoc(doc(db(u), 'events/nuovo2'), { type: 'allenamento', date: '2026-12-09' }));
  await t(`${u}: modifica orario partita (formazione invariata)`, true, () => setDoc(doc(db(u), 'events/ev'), { type: 'partita', date: '2026-12-01', time: '21:00', lineups: [{ name: 'A', published: true }] }, { merge: true }));
  await t(`${u}: segna presenza`, true, () => setDoc(doc(db(u), 'rsvp/' + u), { answers: { ev: 'si' } }, { merge: true }));
  await t(`${u}: vota sondaggio`, true, () => setDoc(doc(db(u), 'votes/' + u), { answers: { x: 0 } }, { merge: true }));
  await t(`${u}: notifica "comunicazione" in coda`, can, () => addDoc(collection(db(u), 'outbox'), { kind: 'post', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica "formazione" in coda`, lu, () => addDoc(collection(db(u), 'outbox'), { kind: 'lineup', title: 't', body: 'b', sent: false }));
  await t(`${u}: notifica "promemoria presenze" in coda`, true, () => addDoc(collection(db(u), 'outbox'), { kind: 'remind', eventId: 'ev', title: 't', body: 'b', sent: false }));
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
  await t(`${u}: legge il gettone del robot`, true, () => getDoc(doc(db(u), 'private/robot')));
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
await t('qualsiasi: crea squadra già esistente', false, () => setDoc(doc(db('nuovo'), 'config/team'), { coaches: ['nuovo'] }));
await t('membro: legge la coda notifiche', false, () => getDoc(doc(db('p2'), 'outbox/qualcosa')));
await t('membro: comunicazione troppo lunga (capitano)', false, () => addDoc(collection(db('c1'), 'posts'), { text: 'x'.repeat(6000) }));

await env.cleanup();
const bad = results.filter(r => !r.ok);
const out = [`Test regole Firestore: ${results.length - bad.length}/${results.length} superati`, '', ...bad.map(r => `FALLITO ${r.name} ${r.err}`)].join('\n');
writeFileSync(new URL('./risultato.txt', import.meta.url), out + '\n');
console.log(out);
process.exit(bad.length ? 1 : 0);
