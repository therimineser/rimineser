// Logica del robot notifiche (stessa di tools/notify.py, che resta come riserva su GitHub).
//
// Due modi:
//  - 'ping': l'app ha appena messo qualcosa in coda (comunicazione, formazione, richiesta di iscrizione) → invio immediato;
//  - 'cron': ogni minuto → coda, richieste, promemoria partite/allenamenti, comunicato UISP, notifica di esempio.
//
// Ogni notifica viene "prenotata" creando robotlog/<chiave> prima di inviarla: se due giri partono insieme,
// solo uno riesce a crearlo e quindi nessuno riceve la stessa notifica due volte.
// Cloudflare (piano gratuito) consente ~50 chiamate esterne per giro: gli invii che non ci stanno
// finiscono in robot/coda e partono al giro successivo (un minuto dopo).
import { accessToken, Store, fcmSend } from './google.js';
import { findPdfs } from './uisp.js';

const MATCH_REMINDERS = [24, 12, 2];   // partite: ore prima dell'inizio
const REMIND_FROM_HOUR = 12;           // allenamenti: il giorno prima, dalle 12
const RESERVE = 6;                     // chiamate tenute da parte per le scritture finali
const PREF_OF = { post: 'posts', poll: 'posts', lineup: 'lineup', remind: 'remind', uisp: 'uisp', event: 'events', test: null };
// promemoria partita: scelta separata per 24/12/2 ore (r24, r12, r2); chi non l'ha ancora fatta segue la vecchia scelta "remind"
const PREF_FALLBACK = { r24: 'remind', r12: 'remind', r2: 'remind' };
export const prefOn = (p, k) => { p = p || {}; if (p[k] !== undefined) return p[k] !== false; return PREF_FALLBACK[k] ? p[PREF_FALLBACK[k]] !== false : true; };
const CAT = { mister: 'Mister', capitano: 'Capitano', giocatore: 'Giocatore', allenatore: 'Allenatore', preparatore: 'Preparatore atletico', dirigente: 'Dirigente', social: 'Social media manager', pubblico: 'Pubblico' };

// ---------------------------------------------------------------- ora di Roma
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function rome(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`,
           utc: Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) };
}
// "2026-11-20" + "21:00" (ora di Roma) → millisecondi
export function romeToMs(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || ''); const t = /^(\d{1,2})[:.](\d{2})$/.exec((time || '00:00').trim());
  if (!d || !t) return null;
  const wall = Date.UTC(+d[1], d[2] - 1, +d[3], +t[1], +t[2]);
  let ms = wall;
  for (let i = 0; i < 2; i++) ms = wall - (rome(ms).utc - Math.floor(ms / 1000) * 1000);
  return ms;
}
// orario per le notifiche: "Ritrovo 21:15 · inizio 22:00" (partite: ritrovo sempre 45 minuti prima; altri eventi: events.meet)
const hmMinus = (t, min) => { const m = /^(\d{1,2})[:.](\d{2})$/.exec(t || ''); if (!m) return ''; const x = ((+m[1]) * 60 + (+m[2]) - min + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
export const timesOf = e => { const meet = e.type === 'partita' ? hmMinus(e.time, 45) : (e.meet || ''); return meet ? `Ritrovo ${meet} · inizio ${e.time || ''}` : `Ore ${e.time || ''}`; };
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const keyOf = s => String(s).replace(/[^\w.:-]/g, '_').slice(0, 200);

// ---------------------------------------------------------------- un giro
export async function run(env, opt) {
  const f = opt.fetch;                  // fetch con contatore (vedi index.js)
  const nowMs = opt.now ?? Date.now();
  const R = rome(nowMs);
  const sa = JSON.parse(env.FIREBASE_SA);
  const project = sa.project_id;
  const token = await accessToken(sa, f);
  const st = new Store(project, token, f);
  const lines = [];
  const log = s => { lines.push(s); console.log(s); };

  // ---- dati caricati solo se servono
  const cache = {};
  const once = (k, fn) => cache[k] || (cache[k] = fn());
  const team = () => once('team', async () => (await st.get('config/team')) || {});
  const tokens = () => once('tokens', () => st.list('tokens'));
  const rsvp = () => once('rsvp', () => st.list('rsvp'));
  const coaches = async () => (await team()).coaches || [];
  const everyone = () => once('everyone', async () => {
    const [t, tm, pl] = await Promise.all([tokens(), team(), once('players', () => st.list('players'))]);
    const members = new Set([...(tm.coaches || []), ...Object.keys(pl).filter(k => pl[k].approved)]);
    return Object.keys(t).filter(u => members.has(u));
  });
  const answer = async (u, eid) => { const r = await rsvp(); for (const k of [u + '_g', u]) { const a = ((r[k] || {}).answers || {})[eid]; if (a) return a; } return ''; };
  const busy = () => f.left() < RESERVE + 4;   // poche chiamate rimaste: il resto al prossimo minuto
  const claim = key => st.create('robotlog', keyOf(key), { at: nowMs, mode: opt.mode });

  // ---- avvia il robot UISP su GitHub (uisp.yml) con il gettone salvato in private/robot
  async function startUisp(why) {
    const tok = ((await st.get('private/robot')) || {}).token;
    if (!tok) { log(`${why}, ma manca il gettone GitHub (private/robot): resta il controllo di GitHub`); return false; }
    const r = await f(`https://api.github.com/repos/${env.GH_REPO || 'therimineser/rimineser'}/actions/workflows/uisp.yml/dispatches`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'rimineser-robot', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }) }).catch(e => ({ ok: false, status: e.message }));
    log(`${why} → robot UISP avviato: ${r.ok ? 'ok' : 'errore ' + r.status}`);
    return true;
  }

  // ---- invio
  let sent = 0;
  const leftover = [], dead = {};
  async function deliver(jobs) {
    const room = Math.max(0, f.left() - RESERVE);
    const now = jobs.slice(0, room);
    leftover.push(...jobs.slice(room));
    // un po' alla volta: Cloudflare tiene al massimo 6 connessioni aperte
    for (let i = 0; i < now.length; i += 6) {
      await Promise.all(now.slice(i, i + 6).map(async j => {
        const res = await fcmSend(project, token, f, j.t, j.m).catch(e => 'err ' + e.message);
        if (res === 'ok') sent++;
        else if (res === 'dead') (dead[j.u] ||= new Set()).add(j.t);
        else log('  invio non riuscito: ' + res);
      }));
    }
  }
  async function send(uids, msg, pref) {
    const t = await tokens(), jobs = [];
    for (const u of uids) {
      const d = t[u] || {};
      if (pref && !prefOn(d.prefs, pref)) continue;
      for (const tok of Object.keys(d.tokens || {})) jobs.push({ u, t: tok, m: msg });
    }
    await deliver(jobs);
    return jobs.length;
  }

  const stateRaw = await st.getRaw('robot/state');
  const state = (stateRaw && stateRaw.data) || {};
  const changed = {};

  // 0) invii rimasti indietro dal giro prima
  const coda = await st.getRaw('robot/coda');
  if (coda && (coda.data.jobs || []).length && await st.patch('robot/coda', { jobs: [] }, coda.updateTime)) {
    log(`Coda arretrata: ${coda.data.jobs.length} invii`);
    await deliver(coda.data.jobs);
  }

  // 1) notifiche messe in coda dall'app
  const out = await st.query('outbox', [['sent', 'EQUAL', false]]);
  for (const [oid, o] of Object.entries(out).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))) {
    if (busy()) break;
    if (await claim('out-' + oid)) {
      const kind = o.kind || 'post';
      let targets = await everyone();
      if (kind === 'remind' && o.eventId) {
        const r = await rsvp();
        targets = targets.filter(u => ![u, u + '_g'].some(k => ((r[k] || {}).answers || {})[o.eventId]));
      }
      if (kind === 'test') { const c = await coaches(); targets = targets.filter(u => c.includes(u)); }
      const n = await send(targets, { title: o.title || 'The Rimineser F.P.', body: o.body || '', url: o.url || '#home', tag: kind + '-' + oid, ...(kind === 'event' && o.eventId ? { eid: o.eventId, rsvp: '1' } : {}) }, PREF_OF[kind]);   // rsvp: tasti Presente/Assente
      const wait = typeof o.createdAt === 'number' && o.createdAt > 0 ? ` (in coda da ${Math.max(0, Math.round((nowMs - o.createdAt) / 1000))} s)` : '';
      log(`Coda: "${o.title || ''}" → ${n} telefoni${wait}`);
    }
    await st.patch('outbox/' + oid, { sent: true, sentAt: nowMs });
  }

  // 2) nuove richieste di iscrizione: avviso solo all'amministratore
  const seen = new Set(state.requests || []);
  const pend = await st.query('players', [['approved', 'EQUAL', false]]);
  const cs = Object.keys(pend).length ? await coaches() : [];
  for (const [k, v] of Object.entries(pend)) {
    if (v.rejected || seen.has(k) || cs.includes(k)) continue;
    if (busy()) break;
    seen.add(k);
    if (!(await claim('req-' + k))) continue;
    const t = await tokens();
    const admins = cs.filter(u => u in t);
    const name = v.name || 'Qualcuno';
    if (!admins.length) { log(`Nuova richiesta di ${name}: l'amministratore non ha telefoni con notifiche attive`); continue; }
    await send(admins, { title: '👤 Nuova richiesta di iscrizione', body: `${name} (${CAT[v.cat] || 'Giocatore'}) vuole entrare in squadra: approvalo in Impostazioni.`, url: '#impostazioni', tag: 'req-' + k }, null);
    const wait = typeof v.createdAt === 'number' && v.createdAt > 0 ? ` (iscritto ${Math.max(0, Math.round((nowMs - v.createdAt) / 1000))} s fa)` : '';
    log(`Nuova richiesta di ${name} → amministratore${wait}`);
  }
  if (seen.size !== (state.requests || []).length) changed.requests = [...seen].sort().slice(-300);

  // 2a) calendario completo UISP caricato dall'app (uploads/calendar, status 'new'): avvia subito la lettura su GitHub (una volta per caricamento)
  if (!busy()) {
    const cal = await st.get('uploads/calendar');
    const calKey = cal && cal.status === 'new' ? String(cal.at || '') + '|' + (cal.name || '') : '';
    if (calKey && calKey !== state.calTrig && await claim('calendario-' + calKey)) {
      await startUisp(`Calendario UISP caricato dall'app (${cal.name || 'file'})`);
      changed.calTrig = calKey;
    }
  }

  if (opt.mode === 'cron' && !busy()) {
    const L = await getJson(f, env.LEAGUE_URL);

    // 2b) VENERDÌ (giorno dei comunicati UISP): controllo del sito ogni minuto. Se c'è un PDF "Calcio a 7" che
    //     campionato.json non ha ancora letto, avvia subito il robot UISP su GitHub (uisp.yml) con il gettone salvato
    //     in private/robot. Se dopo 10 minuti non risulta ancora letto, lo riavvia. Gli altri giorni resta il controllo di GitHub.
    const weekday = new Date(R.date + 'T12:00:00Z').getUTCDay();
    if (weekday === 5 && L && !busy()) {
      const found = await findPdfs(f, nowMs), done = new Set(L.processed || []);
      const fresh = Object.keys(found).filter(n => !done.has(n)).sort();
      const last = state.uispTrig || {}, key = fresh.join('|');
      if (fresh.length && (last.key !== key || nowMs - (last.at || 0) > 10 * 60000)) {
        if (await startUisp(`Nuovo comunicato UISP sul sito (${fresh.join(', ')})`)) changed.uispTrig = { key, at: nowMs };
      }
    }

    // 2c) nuova partita del campionato (arriva in automatico dai comunicati UISP): notifica a tutti, con i tasti Presente/Assente.
    //     Una volta per partita (uisp-<giornata>), quando compare con la data; al primissimo avvio segna tutte quelle già note senza avvisare.
    if (L && !busy()) {
      const us = norm(L.team), known = new Set(state.uispMatches || []), first = !state.uispMatches, now = [];
      const fromCal = (L.rounds || []).filter(r => (r.matches || []).some(m => m.cal && m.date && m.date >= R.date && !known.has('uisp-' + r.n) && [norm(m.home), norm(m.away)].includes(us)));
      if (!first && fromCal.length > 1 && !busy() && await claim('calendario-partite-' + fromCal.map(r => r.n).join('-'))) {
        const n = await send(await everyone(), { title: '📅 Calendario UISP completo', body: `${fromCal.length} nuove partite in calendario: dalla ${fromCal[0].n}ª alla ${fromCal[fromCal.length - 1].n}ª giornata`, url: '#calendario', tag: 'calendario-' + fromCal[0].n }, 'events');
        log(`Calendario completo: ${fromCal.length} partite nuove → una notifica a ${n} telefoni`);
        for (const r of fromCal) known.add('uisp-' + r.n);
      }
      for (const r of L.rounds || []) for (const m of r.matches || []) {
        const home = norm(m.home) === us;
        if ((!home && norm(m.away) !== us) || !m.date) continue;
        const eid = 'uisp-' + r.n; now.push(eid);
        if (first || known.has(eid) || m.date < R.date || busy()) continue;
        if (await claim('nuovapartita-' + eid)) {
          const e = { type: 'partita', time: m.time || '' }, opp = home ? m.away : m.home;
          const day = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(m.date + 'T12:00:00Z'));
          const n = await send(await everyone(), { title: '📅 Nuova partita', body: `vs ${opp} · ${r.n}ª giornata · ${day} · ${timesOf(e)}${m.field ? ' · Campo ' + m.field : ''}`,
            url: '#calendario', tag: 'nuovapartita-' + eid, eid, rsvp: '1' }, 'events');
          log(`Nuova partita ${eid} (vs ${opp}) → ${n} telefoni`);
        }
      }
      const all = [...new Set([...known, ...now])].sort();
      if (all.join() !== (state.uispMatches || []).slice().sort().join()) changed.uispMatches = all.slice(-80);
    }

    // 3) promemoria
    //    partite: 24, 12 e 2 ore prima, a chi ha detto Presente/Forse e a chi non ha risposto; mai agli Assenti
    //    allenamenti: il giorno prima, dalle 12, solo a chi non ha risposto
    const tomorrow = rome(nowMs + 86400000).date;
    const evs = await st.query('events', [['date', 'GREATER_THAN_OR_EQUAL', R.date], ['date', 'LESS_THAN_OR_EQUAL', tomorrow]]);
    for (const k of Object.keys(evs)) evs[k].id = k;
    if (L) {
      const us = norm(L.team);
      for (const r of L.rounds || []) for (const m of r.matches || []) {
        const home = norm(m.home) === us;
        if ((!home && norm(m.away) !== us) || !m.date || m.date < R.date || m.date > tomorrow) continue;
        const eid = 'uisp-' + r.n;
        const base = evs[eid] || (await st.get('events/' + eid)) || {};
        evs[eid] = { ...base, id: eid, type: 'partita', date: m.date, time: m.time || '', opponent: home ? m.away : m.home, location: m.field ? 'Campo ' + m.field : base.location || '' };
      }
    }
    const reminded = { ...(state.reminded || {}) };
    for (const e of Object.values(evs)) {
      const where = e.location ? ' · ' + e.location : '';
      if (e.type === 'partita') {
        const start = romeToMs(e.date, e.time);
        if (start == null) continue;
        const left = (start - nowMs) / 3600000;
        if (left <= 0) continue;
        const due = MATCH_REMINDERS.filter(h => left <= h);
        if (!due.length) continue;
        const h = Math.min(...due);                     // il promemoria più vicino già "scaduto"
        if (reminded[`${e.id}:${h}`] || busy()) continue;
        for (const x of due) reminded[`${e.id}:${x}`] = true;   // se in ritardo non manda quelli vecchi
        if (!(await claim(`match-${e.id}-${h}`))) continue;
        const when = { 24: 'Domani', 12: 'Tra 12 ore', 2: 'Tra 2 ore' }[h] || 'Presto';
        const title = `⚽ ${when}: The Rimineser F.P. vs ${e.opponent || 'avversario'}`;
        const all = await everyone(), yes = [], none = [];
        for (const u of all) { const a = await answer(u, e.id); if (a === 'si' || a === 'forse') yes.push(u); else if (!a) none.push(u); }
        let n = await send(yes, { title, body: `${timesOf(e)}${where}. Ci vediamo in campo!`, url: '#home', tag: 'match-' + e.id }, 'r' + h);
        n += await send(none, { title, body: `${timesOf(e)}${where}. Non hai ancora risposto: ci sei?`, url: '#presenze', tag: 'match-' + e.id }, 'r' + h);
        log(`Promemoria partita ${e.id} (${h} ore prima) → ${n} telefoni`);
      } else if (e.date === tomorrow && R.hour >= REMIND_FROM_HOUR && !reminded[e.id] && !busy()) {
        reminded[e.id] = true;
        if (!(await claim('train-' + e.id))) continue;
        const none = [];
        for (const u of await everyone()) if (!(await answer(u, e.id))) none.push(u);
        const n = await send(none, { title: '⏰ Domani: Allenamento', body: `${timesOf(e)}${where}. Non hai ancora risposto: ci sei?`, url: '#presenze', tag: 'remind-' + e.id }, 'remind');
        log(`Promemoria allenamento ${e.id} → ${n} telefoni`);
      }
    }
    if (JSON.stringify(reminded) !== JSON.stringify(state.reminded || {})) changed.reminded = Object.fromEntries(Object.entries(reminded).slice(-150));

    // notifica di esempio (tools/esempio-notifica.json caricato da Claude): solo all'amministratore, una volta
    const ex = await getJson(f, env.EXAMPLE_URL);
    if (ex && ex.id && !ex.unaAlMinuto && !(state.esempi || []).includes(ex.id) && !busy()) {
      changed.esempi = [...(state.esempi || []), ex.id].slice(-20);
      if (await claim('esempio-' + ex.id)) {
        const t = await tokens();
        const admins = (await coaches()).filter(u => u in t);
        const list = Array.isArray(ex.notifiche) ? ex.notifiche : [ex];
        let n = 0;   // una alla volta, così arrivano nell'ordine del file
        for (const [i, m] of list.entries()) n += await send(admins, { title: m.title || 'Prova', body: m.body || '', url: m.url || '#home', tag: `esempio-${ex.id}-${i}` }, null);
        log(`Notifiche di esempio "${ex.id}" (${list.length}) → ${n} invii all'amministratore`);
      }
    } else if (ex && ex.id && ex.unaAlMinuto && Array.isArray(ex.notifiche) && !(state.esempi || []).includes(ex.id) && !busy()) {
      // una al minuto (troppe notifiche insieme Chrome le scambia per spam): avanzamento in esempi come "id#n"
      const done = new Set(state.esempi || []);
      const i = ex.notifiche.findIndex((_, k) => !done.has(`${ex.id}#${k}`));
      const finished = i < 0;
      changed.esempi = [...(state.esempi || []), finished ? ex.id : `${ex.id}#${i}`].slice(-40);
      if (!finished && await claim(`esempio-${ex.id}-${i}`)) {
        const t = await tokens(), m = ex.notifiche[i];
        const n = await send((await coaches()).filter(u => u in t), { title: m.title || 'Prova', body: m.body || '', url: m.url || '#home', tag: `esempio-${ex.id}-${i}` }, null);
        log(`Notifica di esempio ${i + 1}/${ex.notifiche.length} "${m.title}" → ${n} telefoni`);
      }
    }

    // 4) nuovo comunicato UISP
    if (L && L.updated && L.updated !== state.uisp && !busy()) {
      changed.uisp = L.updated;
      if (state.uisp && await claim('uisp-' + L.updated)) {   // al primissimo avvio non avvisa
        const us = norm(L.team);
        const pos = (L.standings || []).findIndex(r => norm(r.team) === us) + 1;
        let last = null, nxt = null;
        for (const r of L.rounds || []) for (const m of r.matches || []) {
          if (norm(m.home) !== us && norm(m.away) !== us) continue;
          if (m.hg != null) last = m; else if (!nxt) nxt = m;
        }
        const parts = [];
        if (last) parts.push(`${last.home} ${last.hg}-${last.ag} ${last.away}`);
        if (pos) parts.push(`siamo ${pos}° in classifica`);
        if (nxt) parts.push('prossima: ' + (norm(nxt.home) === us ? nxt.away : nxt.home) + (nxt.date ? ` ${nxt.date.slice(8, 10)}/${nxt.date.slice(5, 7)} ${nxt.time || ''}`.trimEnd() : ''));
        const n = await send(await everyone(), { title: '🏆 Nuovo comunicato UISP', body: parts.join(' · ') || 'Risultati e classifica aggiornati', url: '#campionato', tag: 'uisp-' + L.updated }, 'uisp');
        log(`Comunicato UISP → ${n} telefoni`);
      }
    }
    // 5) quante persone sono online: conta i battiti degli ultimi 3 minuti e pubblica SOLO il numero (stats/online)
    if (!busy()) {
      const on = await st.query('presence', [['at', 'GREATER_THAN_OR_EQUAL', new Date(nowMs - 3 * 60000)]]);
      const n = Object.keys(on).length;
      if (n !== state.online) { await st.patch('stats/online', { n, at: nowMs }); changed.online = n; }
    }
    changed.workerAt = nowMs;   // il robot su GitHub vede che il Worker è vivo e non fa doppioni
  }

  // ---- chiusura: invii rimasti, token scaduti, stato, registro
  if (leftover.length) {
    const c = await st.getRaw('robot/coda');
    await st.patch('robot/coda', { jobs: [...((c && c.data.jobs) || []), ...leftover].slice(-500) });
    log(`${leftover.length} invii rimandati al prossimo minuto`);
  }
  if (Object.keys(changed).length) await st.patch('robot/state', changed);
  if (Object.keys(dead).length) {
    const t = await tokens();
    for (const [u, toks] of Object.entries(dead)) {
      if (f.left() < 2) break;
      const keep = Object.fromEntries(Object.entries((t[u] || {}).tokens || {}).filter(([k]) => !toks.has(k)));
      await st.patch('tokens/' + u, { tokens: keep }).catch(e => console.log('pulizia token non riuscita', e.message));
    }
  }
  if (lines.length && f.left() >= 2) {
    lines.push(`Fatto: ${sent} notifiche consegnate a Google.`);
    const old = await st.get('robot/log').catch(() => null);
    const stamped = lines.map(l => `${R.text} · ${opt.mode} · ${l}`);
    await st.patch('robot/log', { lines: [...((old && old.lines) || []), ...stamped].slice(-200) }).catch(e => console.log('registro non salvato', e.message));
  }
  return { sent, lines };
}

async function getJson(f, url) {
  if (!url) return null;
  try { const r = await f(url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), { cf: { cacheTtl: 0 } }); return r.ok ? await r.json() : null; }
  catch (_) { return null; }
}
