// Robot notifiche The Rimineser F.P. su Cloudflare Workers.
//  - POST (dall'app, con l'accesso Firebase di chi ha pubblicato): invia subito quello che c'è in coda;
//  - ogni minuto (Cron Trigger): coda, promemoria, comunicato UISP.
// Segreto necessario: FIREBASE_SA (la stessa chiave JSON dell'account di servizio usata su GitHub).
import { run } from './robot.js';
import { verifyIdToken, accessToken, Store } from './google.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' };
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex' } });

// Cloudflare (piano gratuito) permette circa 50 chiamate esterne per giro: le contiamo.
export function counted(fetchFn, max = 48) {
  let n = 0;
  const f = (...a) => { n++; return fetchFn(...a); };
  f.left = () => max - n;
  return f;
}

// L'errore finisce in robot/state.workerErr: il robot di riserva su GitHub lo copia nel ramo "registro".
async function reportError(env, e) {
  console.log('ERRORE', e && e.message);
  try {
    const sa = JSON.parse(env.FIREBASE_SA);
    const st = new Store(sa.project_id, await accessToken(sa, fetch), fetch);
    await st.patch('robot/state', { workerErr: String((e && e.message) || e).slice(0, 300), workerErrAt: Date.now() });
  } catch (_) {}
}

// Accesso rifiutato: se il gettone sembra davvero dell'app (aud = progetto) annota il motivo per il registro.
async function reportAuthError(env, req, e) {
  try {
    const sa = JSON.parse(env.FIREBASE_SA);
    const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const pay = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (pay.aud !== sa.project_id) return;
    await reportError(env, new Error('accesso dall\'app rifiutato: ' + e.message));
  } catch (_) {}
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return reply(200, { robot: 'notifiche The Rimineser F.P.', ok: !!env.FIREBASE_SA });
    if (!env.FIREBASE_SA) return reply(503, { error: 'FIREBASE_SA mancante' });
    const f = counted(fetch);
    try {
      const sa = JSON.parse(env.FIREBASE_SA);
      await verifyIdToken((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), sa.project_id, f);
    } catch (e) {
      await reportAuthError(env, req, e);
      return reply(401, { error: 'accesso non valido: ' + e.message });
    }
    try {
      const r = await run(env, { mode: 'ping', fetch: f });
      return reply(200, { ok: true, sent: r.sent });
    } catch (e) {
      await reportError(env, e);
      return reply(500, { error: 'errore del robot' });
    }
  },
  async scheduled(event, env, ctx) {
    if (!env.FIREBASE_SA) return console.log('FIREBASE_SA mancante: niente da fare');
    ctx.waitUntil(run(env, { mode: 'cron', fetch: counted(fetch) }).catch(e => reportError(env, e)));
  },
};
