// Accesso a Google dal Worker: gettone dell'account di servizio, Firestore REST, FCM v1, verifica dell'accesso Firebase.
// Tutto con WebCrypto e fetch: niente librerie.

const enc = new TextEncoder();
const b64u = bytes => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const pemToDer = pem => unb64u(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
const RS = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// ---------------------------------------------------------------- gettone OAuth dell'account di servizio
let tokCache = null;   // resta in memoria finché Cloudflare tiene vivo il Worker
export async function accessToken(sa, fetch) {
  const now = Date.now();
  if (tokCache && tokCache.email === sa.client_email && tokCache.exp > now + 120000) return tokCache.tok;
  const iat = Math.floor(now / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64u(enc.encode(JSON.stringify({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
  })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), RS, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign(RS.name, key, enc.encode(head + '.' + claim)));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig,
  });
  if (!r.ok) throw new Error('gettone Google non ottenuto: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  tokCache = { email: sa.client_email, tok: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return tokCache.tok;
}

// ---------------------------------------------------------------- verifica dell'accesso Firebase di chi chiama
let jwks = null;
export async function verifyIdToken(idToken, project, fetch) {
  const [h, p, s] = String(idToken || '').split('.');
  if (!s) throw new Error('gettone mancante');
  const head = JSON.parse(new TextDecoder().decode(unb64u(h)));
  const pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (!jwks || jwks.exp < Date.now() || !jwks.keys[head.kid]) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!r.ok) throw new Error('chiavi Google non disponibili');
    const j = await r.json();
    jwks = { exp: Date.now() + 3600000, keys: Object.fromEntries((j.keys || []).map(k => [k.kid, k])) };
  }
  const jwk = jwks.keys[head.kid];
  if (head.alg !== 'RS256' || !jwk) throw new Error('chiave sconosciuta');
  const key = await crypto.subtle.importKey('jwk', jwk, RS, false, ['verify']);
  if (!(await crypto.subtle.verify(RS.name, key, unb64u(s), enc.encode(h + '.' + p)))) throw new Error('firma non valida');
  const now = Date.now() / 1000;
  if (pay.aud !== project || pay.iss !== 'https://securetoken.google.com/' + project || !pay.sub || !(pay.exp > now) || pay.iat > now + 300) throw new Error('gettone non valido');
  return pay.sub;
}

// ---------------------------------------------------------------- Firestore REST
export const toJs = v => {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, toJs(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(toJs);
  return null;
};
export const toFs = v => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
  return { stringValue: String(v) };
};
const fields = d => Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, toJs(v)]));
const docId = d => d.name.slice(d.name.lastIndexOf('/') + 1);
const mask = keys => keys.map(k => 'updateMask.fieldPaths=' + encodeURIComponent(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '`' + k + '`')).join('&');

export class Store {
  constructor(project, token, fetch) {
    this.root = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
    this.h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    this.f = fetch;
  }
  async _j(r, what) { if (!r.ok) throw new Error(`Firestore ${what}: ${r.status} ${(await r.text()).slice(0, 200)}`); return r.json(); }
  async list(col) {
    const out = {}; let tok = '';
    do {
      const j = await this._j(await this.f(`${this.root}/${col}?pageSize=300${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`, { headers: this.h }), 'lettura ' + col);
      for (const d of j.documents || []) out[docId(d)] = fields(d);
      tok = j.nextPageToken || '';
    } while (tok);
    return out;
  }
  // documento + updateTime (serve per le scritture "solo se nessun altro l'ha cambiato")
  async getRaw(path) {
    const r = await this.f(`${this.root}/${path}`, { headers: this.h });
    if (r.status === 404) return null;
    const j = await this._j(r, 'lettura ' + path);
    return { data: fields(j), updateTime: j.updateTime };
  }
  async get(path) { const d = await this.getRaw(path); return d && d.data; }
  // where: [[campo, operatore, valore], ...] in AND (es. ['sent','EQUAL',false])
  async query(col, where) {
    const filters = where.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: field }, op, value: toFs(value) } }));
    const body = { structuredQuery: { from: [{ collectionId: col }], where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } } } };
    const j = await this._j(await this.f(`${this.root}:runQuery`, { method: 'POST', headers: this.h, body: JSON.stringify(body) }), 'ricerca ' + col);
    const out = {};
    for (const x of j || []) if (x.document) out[docId(x.document)] = fields(x.document);
    return out;
  }
  // aggiorna solo i campi dati; con updateTime fallisce (false) se qualcun altro ha cambiato il documento nel frattempo
  async patch(path, data, updateTime) {
    let q = mask(Object.keys(data));
    if (updateTime) q += '&currentDocument.updateTime=' + encodeURIComponent(updateTime);
    const r = await this.f(`${this.root}/${path}?${q}`, { method: 'PATCH', headers: this.h, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])) }) });
    if (updateTime && (r.status === 400 || r.status === 409 || r.status === 412) && /FAILED_PRECONDITION|ABORTED/.test(await r.clone().text())) return false;
    await this._j(r, 'scrittura ' + path);
    return true;
  }
  // crea il documento solo se non esiste: true = l'ho creato io (serve a non mandare due volte la stessa notifica)
  async create(col, id, data) {
    const r = await this.f(`${this.root}/${col}?documentId=${encodeURIComponent(id)}`, { method: 'POST', headers: this.h, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])) }) });
    if (r.status === 409) return false;
    await this._j(r, 'creazione ' + col + '/' + id);
    return true;
  }
}

// ---------------------------------------------------------------- FCM v1
export async function fcmSend(project, token, fetch, fcmToken, data) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token: fcmToken, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), webpush: { headers: { Urgency: 'high', TTL: '86400' } } } }),
  });
  if (r.ok) return 'ok';
  const t = await r.text();
  if ((r.status === 400 || r.status === 404) && (t.includes('UNREGISTERED') || (t.includes('INVALID_ARGUMENT') && t.toLowerCase().includes('token')))) return 'dead';
  return 'err ' + r.status + ' ' + t.slice(0, 150);
}
