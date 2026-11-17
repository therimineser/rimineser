// The Rimineser F.P. – app della squadra (PWA + Firebase)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile, GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, deleteField, addDoc, getDoc, query, orderBy, limit, serverTimestamp, increment } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import * as CFG from './firebase-config.js';
const firebaseConfig = CFG.firebaseConfig;
const DEMO = firebaseConfig.apiKey === 'demo';
const MSG_URL = 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const val = (f, n) => (f.elements[n]?.value ?? '').trim();

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('INCOLLA')) {
  $('#root').innerHTML = `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><h1>Quasi pronta!</h1><p style="max-width:380px;text-align:center">Manca la configurazione di Firebase: apri il file <b>firebase-config.js</b> e incolla i dati del tuo progetto, come spiegato nella guida.</p></div>`;
  throw new Error('firebase-config.js non compilato');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (_) { fs = initializeFirestore(app, {}); }
const D = p => doc(fs, p);
const C = p => collection(fs, p);

/* ---------- stato ---------- */
const S = { phase:'loading', uid:null, authName:'', coach:false, admin:false, config:{}, me:null, posts:[], events:[], players:{}, rsvp:{}, votes:{},
  tab:'home', fe:null, fsEvents:[], leagueDef:null, ltab:'classifica', lround:null, draft:null, loaded:new Set(), slow:false, pending:false, login:'in' };
let baseSubs = [], memberSubs = [], memberOn = false, meOn = false, installEvt = null, regName = '', regCat = 'giocatore';

const MODS = {
  '2-3-1':[[50,89,'POR'],[30,69,'DIF'],[70,69,'DIF'],[15,46,'CEN'],[50,48,'CEN'],[85,46,'CEN'],[50,20,'ATT']],
  '3-2-1':[[50,89,'POR'],[17,67,'DIF'],[50,70,'DIF'],[83,67,'DIF'],[31,45,'CEN'],[69,45,'CEN'],[50,20,'ATT']],
  '3-1-2':[[50,89,'POR'],[17,67,'DIF'],[50,70,'DIF'],[83,67,'DIF'],[50,47,'CEN'],[30,22,'ATT'],[70,22,'ATT']],
  '2-2-2':[[50,89,'POR'],[30,69,'DIF'],[70,69,'DIF'],[30,46,'CEN'],[70,46,'CEN'],[30,22,'ATT'],[70,22,'ATT']],
  '2-1-2-1':[[50,89,'POR'],[30,71,'DIF'],[70,71,'DIF'],[50,56,'CEN'],[20,40,'CEN'],[80,40,'CEN'],[50,19,'ATT']]
};
const ROLES = ['Portiere','Difensore','Centrocampista','Attaccante','Jolly'];
const CATS = [['mister','Mister','Mister'],['capitano','Capitano','Capitano'],['giocatore','Giocatori','Giocatore'],['allenatore','Allenatori','Allenatore'],['preparatore','Preparatori atletici','Preparatore atletico'],['dirigente','Dirigenza','Dirigente'],['social','Social media manager','Social media manager'],['pubblico','Pubblico','Pubblico / tifoso']];
const catOf = id => S.players[id]?.cat || 'giocatore';
const STAFFCATS = ['mister','capitano','preparatore','social'];   // le assegna solo l'amministratore
const isPl = id => ['giocatore','capitano'].includes(catOf(id));
const catSel = (v, all = S.admin) => `<select name="cat">${CATS.filter(([k])=>all||!STAFFCATS.includes(k)||k===v).map(([k,,l])=>`<option value="${k}" ${(v||'giocatore')===k?'selected':''}>${l}</option>`).join('')}</select>`;
const getLus = e => Array.isArray(e?.lineups) ? e.lineups : (e?.lineup ? [{name:'Formazione 1', ...e.lineup}] : []);
const blankLu = n => ({name:'Formazione '+n, module:'2-3-1', slots:Array(7).fill(''), bench:[], tactic:'', published:false});
const LAB = { si:'Presente', forse:'Forse', no:'Assente' };
const evT = e => new Date((e.date||'1970-01-01')+'T'+(e.time||'00:00')).getTime();
const isUp = e => evT(e) > Date.now() - 3*36e5;
const upcoming = () => S.events.filter(isUp).sort((a,b)=>evT(a)-evT(b));
const past = () => S.events.filter(e=>!isUp(e)).sort((a,b)=>evT(b)-evT(a));
const fmtD = (e,o) => { const [y,m,d]=(e.date||'').split('-').map(Number); return y ? new Date(y,m-1,d).toLocaleDateString('it-IT', o||{weekday:'short',day:'numeric',month:'short'}) : ''; };
const evName = e => e.type==='partita' ? 'vs '+(e.opponent||'Avversario') : 'Allenamento';
const nameOf = id => isAdminId(id) ? (S.players[id+'_g']?.name || 'Amministratore') : (S.players[id]?.name || 'Giocatore');
const short = n => n.split(' ')[0];
const roster = () => Object.keys(S.players).filter(id=>S.players[id].approved && !isAdminId(id)).sort((a,b)=>((+S.players[a].number)||999)-((+S.players[b].number)||999)||nameOf(a).localeCompare(nameOf(b)));
const squad = () => roster().filter(isPl);
const pendingP = () => Object.keys(S.players).filter(id=>!S.players[id].approved && !S.players[id].rejected && !isAdminId(id));
const ans = (id,eid) => S.rsvp[id]?.answers?.[eid] || '';
// L'amministratore ha due profili: "Amministratore" (account) e il suo profilo giocatore (id = uid + "_g").
const gid = () => S.uid + '_g';
const isAdminId = id => (S.config.coaches||[]).includes(id);
let mode = 'admin'; try { mode = localStorage.getItem('rim-mode') || 'admin'; } catch(_) {}
const asAdmin = () => S.admin && mode !== 'player';
const actId = () => S.admin ? gid() : S.uid;   // chi risponde alle presenze / profilo giocatore
const mine = id => id === S.uid || (S.admin && id === gid());
// Etichette: "mister" e "capitano" (assegnate dall'amministratore). Comunicazioni: mister, capitano, admin. Formazioni: capitano, admin.
const canPost = () => S.admin || STAFFCATS.includes(S.players[S.uid]?.cat);      // comunicazioni: Mister, Capitano, Preparatore, Social, admin
const canLineup = () => S.admin || S.players[S.uid]?.cat === 'capitano';          // formazioni: Capitano, admin
const tagLabel = id => STAFFCATS.includes(catOf(id)) ? ` <span class="chip tag">${CATS.find(c=>c[0]===catOf(id))[2]}</span>` : '';
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

let tt;
function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('on'); clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('on'),2800); }
async function write(fn, ok){
  try { await fn(); if (ok) toast(ok); return true; }
  catch(e){ console.error(e); toast(e?.code==='permission-denied' ? 'Non hai il permesso per questa operazione.' : e?.code==='unavailable' ? 'Sei offline: riprova quando torna la rete.' : 'Salvataggio non riuscito, riprova.'); return false; }
}

/* ---------- dati ---------- */
function stop(list){ list.forEach(u=>{ try{u()}catch(_){} }); list.length = 0; }
function watch(list, key, ref, cb){
  const t = setTimeout(()=>{ S.slow = true; draw(); }, 10000);
  list.push(onSnapshot(ref, s=>{ clearTimeout(t); S.slow=false; cb(s); S.loaded.add(key); draw(); },
    e=>{ clearTimeout(t); console.error(key, e); S.loaded.add(key); if (e.code!=='permission-denied') S.slow = true; draw(); }));
}
// Dati del campionato: li aggiorna da solo il robot sul server; l'app li ricontrolla spesso.
let lastLeague = '';
function loadLeague(){ fetch('campionato.json?t='+Date.now(), {cache:'no-store'}).then(r=>r.text()).then(t=>{ if (t===lastLeague) return; lastLeague = t; S.leagueDef = JSON.parse(t); mergeEvents(); draw(); }).catch(()=>{}); }
loadLeague(); setInterval(loadLeague, 10*60*1000);
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState==='visible') loadLeague(); });
// Le nostre partite di campionato diventano eventi del calendario in automatico (id "uisp-<giornata>").
function mergeEvents(){
  const L = S.leagueDef, virt = {};
  if (L) for (const r of L.rounds||[]) for (const m of r.matches||[]) {
    const home = isUs(m.home); if (!home && !isUs(m.away)) continue; if (!m.date && m.hg==null) continue;   // senza data solo se già giocata
    virt['uisp-'+r.n] = {id:'uisp-'+r.n, uisp:r.n, type:'partita', date:m.date||'', time:m.time||'', opponent:home?m.away:m.home, location:m.field?'Campo '+m.field:'', home,
      result: m.hg!=null ? {us: home?m.hg:m.ag, them: home?m.ag:m.hg} : null, notes:`${r.n}ª giornata campionato UISP`};
  }
  const out = S.fsEvents.map(e=>{ const v = virt[e.id]; if (!v) return e; delete virt[e.id];
    return {...e, uisp:v.uisp, type:'partita', date:v.date, time:v.time, opponent:v.opponent, location:v.location||e.location, home:v.home, result:v.result||e.result||null, notes:e.notes||v.notes}; });
  S.events = out.concat(Object.values(virt));
}
const toMap = s => Object.fromEntries(s.docs.map(d=>[d.id, d.data()]));
function startMember(){
  if (memberOn) return; memberOn = true;
  presenceOn(true);
  if (!viewCounted) { viewCounted = true; setTimeout(countView, 0); }
  let tokChecked = false;
  watch(memberSubs, 'mytok', D('tokens/'+S.uid), s=>{ S.myTok = s.exists() ? s.data() : null; if (!tokChecked) { tokChecked = true; refreshPush(); } });
  watch(memberSubs, 'posts', query(C('posts'), orderBy('createdAt','desc'), limit(60)), s=>{ S.posts = s.docs.map(d=>({id:d.id, ...d.data()})); });
  watch(memberSubs, 'events', C('events'), s=>{ S.fsEvents = s.docs.map(d=>({id:d.id, ...d.data()})); mergeEvents(); });
  watch(memberSubs, 'players', C('players'), s=>{ S.players = toMap(s); ensureAdminPlayer(); });
  watch(memberSubs, 'rsvp', C('rsvp'), s=>{ S.rsvp = toMap(s); ensureAdminPlayer(); });
  watch(memberSubs, 'votes', C('votes'), s=>{ S.votes = toMap(s); });
}
// L'amministratore è anche un iscritto come gli altri (di base giocatore): se non ha ancora la scheda, la creo.
let adminFixed = false;
function ensureAdminPlayer(){
  if (!S.admin || adminFixed || !S.loaded.has('players') || !S.loaded.has('rsvp')) return;
  adminFixed = true;
  const g = gid(), old = S.players[S.uid];
  if (!S.players[g]) write(()=>setDoc(D('players/'+g), {name:(old&&old.name)||S.authName, number:(old&&old.number)||'', cat:'giocatore', approved:true, owner:S.uid, createdAt:Date.now()}));
  if (old) write(()=>deleteDoc(D('players/'+S.uid)));
  // il profilo giocatore dell'amministratore non deve chiamarsi "Amministratore"
  const pg = S.players[g]; if (pg && /amministratore/i.test(pg.name||'')) write(()=>updateDoc(D('players/'+g), {name:'Giacomo Lucidi'}));
  const r = S.rsvp[S.uid]; if (r && r.answers && Object.keys(r.answers).length && !S.rsvp[g]) write(()=>setDoc(D('rsvp/'+g), {answers:{...r.answers}}));
}
function stopMember(){ stop(memberSubs); memberOn = false; presenceOn(false); watchPresence(false); S.loaded = new Set(['team']); }
function watchMe(){
  if (meOn) return; meOn = true;
  watch(baseSubs, 'me', D('players/'+S.uid), async s=>{
    if (!s.exists()) { S.me = null; S.phase = 'pending';
      if (await write(()=>setDoc(D('players/'+S.uid), { name:S.authName, number:'', cat:regCat||'giocatore', approved:false, createdAt:Date.now() }))) pingRobot();
      return; }
    S.me = s.data();
    if (S.me.rejected && !S.me.approved) { S.coach = false; S.phase = 'rejected'; stopMember(); return; }
    if (S.me.approved) { S.coach = true; S.phase = 'app'; startMember(); } else { S.coach = false; S.phase = 'pending'; stopMember(); }
  });
}
onAuthStateChanged(auth, u=>{
  stop(baseSubs); stopMember(); meOn = false;
  Object.assign(S, { posts:[], events:[], players:{}, rsvp:{}, votes:{}, config:{}, me:null, coach:false, draft:null, loaded:new Set() });
  if (!u) { S.uid = null; S.phase = 'login'; draw(); return; }
  S.uid = u.uid; S.authName = u.displayName || regName || (u.email||'').split('@')[0]; S.phase = 'loading'; draw();
  watch(baseSubs, 'team', D('config/team'), s=>{
    if (!s.exists()) { S.config = {}; S.coach = S.admin = false; S.phase = 'setup'; stopMember(); return; }
    // Tutti gli iscritti approvati hanno gli stessi diritti (S.coach = può modificare); l'amministratore in più approva gli iscritti.
    S.config = s.data(); S.admin = (S.config.coaches||[]).includes(S.uid); S.coach = S.admin;
    if (S.admin) { S.phase = 'app'; startMember(); } else watchMe();
  });
});

/* ---------- chi è online ---------- */
// Ogni app aperta (e visibile) scrive presence/<uid> = ora del server ogni minuto; chiudendo o nascondendo l'app lo toglie.
// Nessuno può leggere presence (regole): il robot conta ogni minuto i battiti degli ultimi 3 minuti e pubblica solo il numero
// in stats/online, che la Rosa legge mentre è aperta.
let beatTimer = null, presSub = null;
const beat = () => { if (S.phase==='app' && S.uid && document.visibilityState==='visible') setDoc(D('presence/'+S.uid), {at: serverTimestamp()}).catch(()=>{}); };
function presenceOn(on){
  if (on && !beatTimer) { beat(); beatTimer = setInterval(beat, 60*1000); }
  if (!on && beatTimer) { clearInterval(beatTimer); beatTimer = null; }
}
function presenceOff(){ presenceOn(false); if (S.uid) return deleteDoc(D('presence/'+S.uid)).catch(()=>{}); }
document.addEventListener('visibilitychange', ()=>{ if (S.phase!=='app') return; if (document.visibilityState==='visible') presenceOn(true); else presenceOff(); });
addEventListener('pagehide', ()=>{ if (S.phase==='app') presenceOff(); });
function watchPresence(on){
  if (on && !presSub) presSub = onSnapshot(D('stats/online'), s=>{ S.online = s.exists() ? s.data().n : null; if (S.tab==='rosa') draw(); }, ()=>{});
  if (!on && presSub) { presSub(); presSub = null; }
}
// il conteggio arriva dal robot (ogni minuto): chi sta guardando la Rosa è online di sicuro, quindi almeno 1
const onlineCount = () => typeof S.online === 'number' ? Math.max(1, S.online) : null;

/* ---------- visualizzazioni (solo conteggi, nessun nome né orario) ---------- */
// Un'apertura = l'app viene chiusa e poi riaperta. Ricaricare la pagina NON conta: sessionStorage resta finché l'app
// (o la scheda) è aperta e si svuota solo quando viene chiusa.
// stats/views-AAAA-MM = {total, dGG, day: ultimo giorno incrementato} (giorno di Roma); le regole permettono solo +1 e la lettura solo all'amministratore.
const romeDate = (d=new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit'}).format(d);
let viewCounted = false;
function countView(){
  if (DEMO || S.phase!=='app') return;
  try { if (sessionStorage.getItem('rim-view')) return; sessionStorage.setItem('rim-view', '1'); } catch(_) {}
  const [y,m,d] = romeDate().split('-');
  setDoc(D(`stats/views-${y}-${m}`), { total: increment(1), ['d'+d]: increment(1), day: 'd'+d }, { merge:true }).catch(()=>{});
}
async function loadViews(){
  const now = new Date(), out = [];
  for (let i = 0; i < 2; i++) {   // mese corrente + precedente (per "Ieri" il primo del mese)
    const [y,m] = romeDate(new Date(now.getFullYear(), now.getMonth()-i, 15)).split('-');
    const s = await getDoc(D(`stats/views-${y}-${m}`)).catch(()=>null);
    out.push({ y, m, data: s && s.exists() ? s.data() : {} });
  }
  S.views = { at: Date.now(), months: out }; draw();
}
function vViews(){
  if (!S.views || Date.now() - S.views.at > 5*60*1000) { if (!S.viewsLoading) { S.viewsLoading = true; loadViews().finally(()=>{ S.viewsLoading = false; }); } }
  const V = S.views; if (!V) return `<section class="card"><span class="lab">VISUALIZZAZIONI</span><span class="mute">Caricamento…</span></section>`;
  const [, , d] = romeDate().split('-'), [, , dy] = romeDate(new Date(Date.now()-86400000)).split('-');
  const cur = V.months[0].data, prevM = V.months[1].data, sameMonth = dy <= d;
  const today = cur['d'+d]||0, yest = sameMonth ? (cur['d'+dy]||0) : (prevM['d'+dy]||0);
  const days = Array.from({length:+d}, (_,i)=>cur['d'+String(i+1).padStart(2,'0')]||0), max = Math.max(1, ...days);
  return `<section class="card"><span class="lab">VISUALIZZAZIONI</span><span class="mute">Quante volte è stata aperta l'app da tutti gli iscritti (te compreso). Solo numeri: nessun nome e nessun orario.</span>
    <div class="row" style="gap:8px">${[['Oggi',today],['Ieri',yest],['Questo mese',cur.total||0]].map(([l,n])=>`<div class="vstat"><b>${n}</b><span>${l}</span></div>`).join('')}</div>
    <div class="vbars" role="img" aria-label="Aperture per giorno di questo mese">${days.map((n,i)=>`<i style="height:${Math.round(n/max*100)}%" title="${i+1}: ${n}"></i>`).join('')}</div></section>`;
}

/* ---------- pezzi di interfaccia ---------- */
const icoPlus = '<svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
function counts(eid){ const r={si:0,forse:0,no:0,none:0}; squad().forEach(id=>{ r[ans(id,eid)||'none']++; }); return r; }
function rsvpBtns(eid){ if (asAdmin()) return `<div style="display:flex;flex-direction:column;gap:8px"><span class="mute">Sei in modalità Amministratore: per segnarti alle presenze passa al tuo profilo giocatore.</span><button class="sec" data-act="mode">⇄ Passa a Giocatore</button></div>`; const my=ans(actId(),eid);
  return `<div class="btns">${['si','forse','no'].map(v=>`<button class="b ${my===v?v:''}" aria-pressed="${my===v}" data-act="rsvp" data-e="${esc(eid)}" data-v="${v}">${LAB[v]}</button>`).join('')}</div>`; }
function bar(eid){ const c=counts(eid), n=Math.max(1,c.si+c.forse+c.no+c.none);
  return `<div class="bar" aria-hidden="true"><i style="width:${c.si/n*100}%;background:var(--ok)"></i><i style="width:${c.forse/n*100}%;background:var(--may)"></i><i style="width:${c.no/n*100}%;background:var(--ink)"></i></div>
  <div class="mute">Giocatori: ${c.si} presenti · ${c.forse} forse · ${c.no} assenti · ${c.none} senza risposta${(()=>{ const o=roster().filter(id=>!isPl(id)&&ans(id,eid)==='si').length; return o?` · +${o} tra staff e pubblico`:''; })()}</div>`; }
function attendees(e, live){
  const chip = (id,cls) => live && S.coach ? `<button class="chip ${cls}" data-act="cyc" data-id="${esc(id)}" data-e="${esc(e.id)}" aria-label="Cambia risposta di ${esc(nameOf(id))}">${esc(nameOf(id))}</button>` : `<span class="chip ${cls}">${esc(nameOf(id))}</span>`;
  const h = CATS.map(([k,pl])=>{ const ids=roster().filter(id=>catOf(id)===k); if (!ids.length) return '';
    const g={si:[],forse:[],no:[],'':[]}; ids.forEach(id=>g[ans(id,e.id)].push(id));
    const rest = g.no.length + g[''].length;
    return `<div><div class="row sp"><b>${pl}</b><span class="mute">${g.si.length} present${g.si.length===1?'e':'i'}${g.forse.length?' · '+g.forse.length+' forse':''}</span></div>
      <div class="names">${g.si.map(id=>chip(id,'si')).join('')}${g.forse.map(id=>chip(id,'forse')).join('')||(g.si.length?'':'<span class="mute">Nessuno ancora</span>')}</div>
      ${rest?`<details><summary>Assenti e senza risposta (${rest})</summary><div class="names">${g.no.map(id=>chip(id,'no')).join('')}${g[''].map(id=>chip(id,'')).join('')}</div></details>`:''}</div>`; }).join('');
  return h || '<p class="mute">Nessuno in rosa.</p>';
}
function pitch(lu, sm){
  const pos = MODS[lu.module] || MODS['2-3-1'];
  return `<div class="pitch ${sm?'sm':''}" role="img" aria-label="Formazione ${esc(lu.module)}"><i class="l-mid"></i><i class="l-circ"></i><i class="l-box t"></i><i class="l-box b"></i>${pos.map(([x,y,r],i)=>{ const id=(lu.slots||[])[i]; const num=id&&S.players[id]?.number;
    return `<div class="pl" style="left:${x}%;top:${y}%"><span class="dot ${r==='POR'?'gk':''}">${id?esc(num||'•'):''}</span><span class="nm">${id?esc(short(nameOf(id))):r}</span></div>`; }).join('')}</div>`;
}

/* ---------- notifiche ---------- */
const PREFS = [['posts','Comunicazioni e sondaggi'],['lineup','Formazione pubblicata'],['r24','Promemoria partita 24 ore prima'],['r12','Promemoria partita 12 ore prima'],['r2','Promemoria partita 2 ore prima'],['remind','Promemoria allenamenti e presenze'],['uisp','Risultati e classifica UISP']];
// prima c'era un'unica scelta "remind" anche per le partite: chi l'aveva tolta resta senza promemoria partite finché non li riattiva
const PREF_FALLBACK = { r24:'remind', r12:'remind', r2:'remind' };
const prefOn = (p, k) => (p||{})[k] !== undefined ? p[k] !== false : PREF_FALLBACK[k] ? (p||{})[PREF_FALLBACK[k]] !== false : true;
const allPrefs = p => Object.fromEntries(PREFS.map(([k])=>[k, prefOn(p, k)]));
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushOn = () => pushSupported() && Notification.permission === 'granted' && S.myTok && Object.keys(S.myTok.tokens||{}).length > 0;
async function pushToken(){
  const m = await import(MSG_URL);
  if (!(await m.isSupported())) throw new Error('unsupported');
  const reg = await navigator.serviceWorker.ready;
  return m.getToken(m.getMessaging(app), { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
}
async function savePush(tok){
  const prefs = allPrefs((S.myTok||{}).prefs);
  await setDoc(D('tokens/'+S.uid), { tokens:{ [tok]: Date.now() }, prefs }, { merge:true });
}
async function enablePush(){
  if (DEMO) return toast('Nell\'anteprima le notifiche non sono attive.');
  if (!pushSupported()) return toast(isIOS() ? 'Su iPhone prima aggiungi l\'app alla schermata Home e aprila da lì.' : 'Questo browser non supporta le notifiche.');
  if (!CFG.vapidKey || String(CFG.vapidKey).startsWith('INCOLLA')) return toast('Notifiche non ancora configurate dall\'amministratore.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifiche bloccate: puoi riattivarle dalle impostazioni del telefono.');
  try { await savePush(await pushToken()); toast('Notifiche attivate!'); } catch(e){ console.error(e); toast('Non sono riuscito ad attivare le notifiche, riprova.'); }
}
async function refreshPush(){
  if (DEMO || !pushSupported() || Notification.permission !== 'granted' || !CFG.vapidKey || String(CFG.vapidKey).startsWith('INCOLLA')) return;
  try { const tok = await pushToken(); if (!(S.myTok && (S.myTok.tokens||{})[tok])) await savePush(tok); } catch(_) {}
}
// Chi pubblica mette la notifica in coda e chiama subito il robot su Cloudflare (CFG.notifyUrl), che la invia in 1-2 secondi.
// Se il robot Cloudflare non risponde: l'amministratore sveglia quello su GitHub, per gli altri vale il giro automatico.
async function notifyTeam(kind, title, body, url, extra){
  if (!S.coach) return;
  if (await write(()=>addDoc(C('outbox'), { kind, title, body:String(body||'').slice(0,180), url:url||'#home', createdAt:Date.now(), sent:false, ...(extra||{}) })))
    if (!(await pingRobot())) wakeRobot();
}
async function pingRobot(){
  let why = '';
  if (!CFG.notifyUrl) why = 'indirizzo mancante (app non aggiornata)';
  else if (!auth.currentUser) why = 'accesso non pronto';
  else try {
    const r = await fetch(CFG.notifyUrl, { method:'POST', headers:{ 'Authorization':'Bearer '+await auth.currentUser.getIdToken() } });
    if (r.ok) return true;
    why = 'risposta ' + r.status + ' ' + (await r.text().catch(()=>'')).slice(0,80);
  } catch(e) { why = 'rete: ' + (e && e.message || e); }
  console.warn('Robot Cloudflare non raggiunto:', why);
  if (S.admin) toast('Robot veloce non raggiunto: ' + why);
  return false;
}
async function wakeRobot(){
  if (!S.admin) return;   // il gettone lo legge solo l'amministratore: per gli altri parte il giro automatico del robot
  try {
    if (!S.robot) { const d = await getDoc(D('private/robot')); S.robot = d.exists() ? d.data() : {}; }
    const tok = S.robot.token; if (!tok) return;
    const owner = S.robot.owner || (location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '');
    const repo = S.robot.repo || location.pathname.split('/')[1] || 'rimineser';
    if (!owner) return;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/notifiche.yml/dispatches`, { method:'POST', headers:{ 'Authorization':'Bearer '+tok, 'Accept':'application/vnd.github+json' }, body: JSON.stringify({ ref:'main' }) });
    if (!r.ok) toast('Notifica in coda: partirà a breve.');
  } catch(_) { toast('Notifica in coda: partirà a breve.'); }
}
function vPushCard(full){
  if (pushOn()) return full ? `<section class="card"><span class="lab">NOTIFICHE ATTIVE</span>${PREFS.map(([k,l])=>`<label class="ck"><input type="checkbox" data-ch="pref" value="${k}" ${prefOn((S.myTok||{}).prefs, k)?'checked':''}>${l}</label>`).join('')}</section>` : '';
  if (isIOS() && !standalone()) return full ? `<section class="card install"><b>Notifiche su iPhone</b><span class="mute">Prima aggiungi l'app alla schermata Home (Condividi → Aggiungi alla schermata Home), poi aprila dall'icona e attiva le notifiche qui.</span></section>` : '';
  if (pushSupported() && Notification.permission === 'denied') return full ? `<section class="card install"><b>Notifiche bloccate</b><span class="mute">Le hai bloccate: riattivale dalle impostazioni del telefono per questo sito, poi ricarica l'app.</span></section>` : '';
  if (!pushSupported() && !DEMO) return '';
  return `<section class="card install"><b>🔔 Attiva le notifiche</b><span class="mute">Ricevi subito comunicazioni, formazioni, promemoria e risultati UISP.</span><button class="pri" data-act="pushOn">Attiva notifiche</button></section>`;
}

/* ---------- campionato ---------- */
const LG = () => S.leagueDef;
const norm = t => String(t||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const isUs = t => { const L=LG(); return L && norm(t)===norm(L.team); };
const dr = r => (r.gf-r.gs>0?'+':'')+(r.gf-r.gs);
function ourPos(){ const L=LG(); if (!L) return null; const i=L.standings.findIndex(r=>isUs(r.team)); return i<0?null:{pos:i+1,...L.standings[i]}; }
function lastPlayed(){ const L=LG(); return L ? [...L.rounds].reverse().find(r=>r.matches.some(m=>m.hg!=null)) : null; }
function nextRound(){ const L=LG(); return L ? L.rounds.find(r=>r.matches.some(m=>m.hg==null)) : null; }
const lDate = m => m.date ? new Date(m.date+'T12:00').toLocaleDateString('it-IT',{weekday:'short',day:'numeric',month:'short'}) : '';
function mRow(m){
  const us = isUs(m.home)||isUs(m.away), played = m.hg!=null;
  return `<div class="mrow ${us?'us':''}"><div class="mt">${played?'':`<span class="mute" style="font-size:12px">${esc(lDate(m))} · ${esc(m.time||'')} · ${esc(m.field||'')}</span>`}
    <span class="${played&&m.hg>m.ag?'w':''}">${esc(m.home)}</span><span class="${played&&m.ag>m.hg?'w':''}">${esc(m.away)}</span></div>
    <div class="ms">${played?`<b>${m.hg}</b><b>${m.ag}</b>`:'<span class="mute">vs</span>'}</div></div>`;
}
function hbars(rows, opts){
  const max = Math.max(1, ...rows.map(r=>r.v));
  return `<div class="hb" role="list">${rows.map(r=>`<div class="hbr ${r.sel?'sel':''}" role="listitem" title="${esc(r.name)}: ${r.v} ${opts.unit}"><span class="hbn">${esc(r.name)}</span><span class="hbt"><i style="width:${Math.max(r.v?3:0, r.v/max*100)}%;background:${r.sel?opts.on:opts.off}"></i></span><b class="hbv">${r.v}</b></div>`).join('')}</div>`;
}
function vStats(L){
  const teams = L.standings.map(r=>r.team);
  if (!S.steam || !teams.includes(S.steam)) S.steam = (L.standings.find(r=>isUs(r.team))||L.standings[0]||{}).team;
  const T = S.steam, row = L.standings.find(r=>r.team===T) || {}, same = t => norm(t)===norm(T);
  const cardsOf = t => { const k = Object.keys(L.cards||{}).find(x=>norm(x)===norm(t)); return (L.cards||{})[k] || {amm:0,esp:0,diff:0}; };
  const C = cardsOf(T), g = row.g || 0;
  const games = []; L.rounds.forEach(r=>r.matches.forEach(m=>{ if (m.hg==null) return; if (same(m.home)) games.push({n:r.n, f:m.hg, s:m.ag, opp:m.away}); else if (same(m.away)) games.push({n:r.n, f:m.ag, s:m.hg, opp:m.home}); }));
  const clean = games.filter(x=>x.s===0).length;
  const tile = (v,l) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`;
  let h = `<label>Squadra<select data-ch="steam">${teams.map(t=>`<option ${t===T?'selected':''}>${esc(t)}</option>`).join('')}</select></label>
  <section class="card"><span class="lab">${esc(T).toUpperCase()}</span><div class="tiles">
    ${tile(row.pt??'–','Punti')}${tile(row.gf??'–','Gol fatti')}${tile(row.gs??'–','Gol subiti')}${tile(row.gf!=null?dr(row):'–','Differenza reti (fatti − subiti)')}
    ${tile(g?(row.gf/g).toFixed(1):'–','Gol fatti a partita')}${tile(g?(row.gs/g).toFixed(1):'–','Gol subiti a partita')}${tile(clean,'Porta inviolata')}${tile(row.cd??'–','Punti disciplina')}
    ${tile(C.amm,'Ammonizioni')}${tile(C.diff,'Diffide')}${tile(C.esp,'Squalifiche / espulsioni')}${tile(g,'Partite giocate')}</div></section>`;
  const maxG = Math.max(1, ...games.map(x=>Math.max(x.f,x.s)));
  h += `<section class="card"><span class="lab">GOL PER GIORNATA · ${esc(T).toUpperCase()}</span><div class="legend"><span><i style="background:#2B6CB0"></i>Gol fatti da ${esc(T)}</span><span><i style="background:#E30613"></i>Gol subiti da ${esc(T)}</span></div>
    ${games.length?`<div class="vb">${games.map(x=>`<div class="vbc" title="${x.n}ª giornata vs ${esc(x.opp)}: ${x.f}-${x.s}"><div class="vbb"><span><em>${x.f}</em><i style="height:${x.f/maxG*100}%;background:#2B6CB0"></i></span><span><em>${x.s}</em><i style="height:${x.s/maxG*100}%;background:#E30613"></i></span></div><small>${x.n}ª</small><small class="vbo">vs ${esc(x.opp)}</small></div>`).join('')}</div>`:'<p class="mute">Nessuna partita giocata.</p>'}</section>`;
  h += `<section class="card"><span class="lab">GOL FATTI · TUTTE LE SQUADRE</span>${hbars([...L.standings].sort((a,b)=>b.gf-a.gf).map(r=>({name:r.team,v:r.gf,sel:same(r.team)})),{on:'#2B6CB0',off:'#C5D6EA',unit:'gol fatti'})}</section>`;
  h += `<section class="card"><span class="lab">GOL SUBITI · MIGLIORI DIFESE IN ALTO</span>${hbars([...L.standings].sort((a,b)=>a.gs-b.gs).map(r=>({name:r.team,v:r.gs,sel:same(r.team)})),{on:'#E30613',off:'#F4C2C6',unit:'gol subiti'})}</section>`;
  h += `<section class="card"><span class="lab">AMMONIZIONI · TUTTE LE SQUADRE</span>${hbars(L.standings.map(r=>({name:r.team,v:cardsOf(r.team).amm,sel:same(r.team)})).sort((a,b)=>b.v-a.v),{on:'#111111',off:'#CFCFCF',unit:'ammonizioni'})}<p class="mute" style="margin:0;font-size:13px">Contate dai provvedimenti dei comunicati UISP.</p></section>`;
  if (L.standings.some(r=>r.cd!=null)) h += `<section class="card"><span class="lab">PUNTI DISCIPLINA · I PIÙ CORRETTI IN ALTO</span>${hbars([...L.standings].filter(r=>r.cd!=null).sort((a,b)=>a.cd-b.cd).map(r=>({name:r.team,v:r.cd,sel:same(r.team)})),{on:'#111111',off:'#CFCFCF',unit:'punti disciplina'})}</section>`;
  return h;
}
function vCampionato(){
  const L = LG(); if (!L) return `<h2>Campionato</h2><div class="empty">Dati del campionato non disponibili.</div>`;
  const me = ourPos(), nr = nextRound();
  const ourNext = nr && nr.matches.find(m=>isUs(m.home)||isUs(m.away));
  let h = `<h2>Campionato</h2><p class="mute" style="margin:-6px 0 0">${esc(L.org)} · ${esc(L.name)} ${esc(L.season)}</p>`;
  if (me) h += `<section class="card dark"><div class="score"><div><b>${me.pos}°</b>Posizione</div><div><b>${me.pt}</b>Punti</div><div><b>${me.v}-${me.n}-${me.p}</b>V-N-P</div></div>
    ${ourNext?`<p class="txt" style="margin:0;color:#C9CDD6">Prossima: <b style="color:#fff">${esc(isUs(ourNext.home)?ourNext.away:ourNext.home)}</b> · ${esc(lDate(ourNext))} ore ${esc(ourNext.time||'')} · campo ${esc(ourNext.field||'')}</p>`:''}</section>`;
  h += `<div class="mods" role="tablist" aria-label="Sezioni campionato">${[['classifica','Classifica'],['statistiche','Statistiche'],['risultati','Risultati'],['calendario','Calendario'],['marcatori','Marcatori'],['disciplina','Cartellini']].map(([k,l])=>`<button role="tab" class="${S.ltab===k?'on':''}" aria-selected="${S.ltab===k}" data-act="ltab" data-k="${k}">${l}</button>`).join('')}</div>`;
  if (S.ltab==='classifica') h += `<section class="card" style="padding:8px 6px"><div class="scroll"><table class="tbl"><thead><tr><th>#</th><th style="text-align:left">Squadra</th><th>Pt</th><th>G</th><th>V</th><th>N</th><th>P</th><th>DR</th></tr></thead><tbody>${L.standings.map((r,i)=>`<tr class="${isUs(r.team)?'us':''}"><td>${i+1}</td><td class="tn">${esc(r.team)}</td><td><b>${r.pt}</b></td><td>${r.g}</td><td>${r.v}</td><td>${r.n}</td><td>${r.p}</td><td>${dr(r)}</td></tr>`).join('')}</tbody></table></div></section>`;
  if (S.ltab==='risultati'){ const played = L.rounds.filter(r=>r.matches.some(m=>m.hg!=null)); if (!S.lround || !played.find(r=>r.n===S.lround)) S.lround = (lastPlayed()||{}).n;
    const r = played.find(x=>x.n===S.lround);
    h += `<div class="mods">${played.map(x=>`<button class="${x.n===S.lround?'on':''}" data-act="lround" data-n="${x.n}" aria-label="Giornata ${x.n}">${x.n}ª</button>`).join('')}</div>`;
    h += r ? `<section class="card"><span class="lab">${r.n}ª GIORNATA</span>${r.matches.map(mRow).join('')}${r.rest?`<p class="mute" style="margin:0">Riposa: ${esc(r.rest)}</p>`:''}</section>` : '<div class="empty">Nessun risultato ancora.</div>'; }
  if (S.ltab==='calendario') { const fut = L.rounds.filter(r=>r.matches.some(m=>m.hg==null));
    h += fut.length ? fut.map(r=>`<section class="card"><span class="lab">${r.n}ª GIORNATA</span>${[...r.matches].filter(m=>m.hg==null).sort((a,b)=>((a.date||'')+(a.time||'')).localeCompare((b.date||'')+(b.time||''))).map(mRow).join('')}${r.rest?`<p class="mute" style="margin:0">Riposa: ${esc(r.rest)}</p>`:''}</section>`).join('') + '<p class="mute" style="font-size:13px">UISP pubblica il programma una giornata alla volta: le prossime compariranno da sole.</p>' : '<div class="empty">Il programma delle prossime giornate non è ancora uscito.</div>'; }
  if (S.ltab==='statistiche') h += vStats(L);
  if (S.ltab==='marcatori') { const sc = L.scorers||[], ours = sc.filter(x=>!x.team||isUs(x.team));
    h += `<section class="card"><span class="lab">I NOSTRI MARCATORI</span>${ours.length?ours.map(x=>`<div class="row sp" style="padding:4px 0"><span>${esc(x.name)}</span><b class="res">${x.goals}</b></div>`).join(''):'<p class="mute">Ancora nessun gol in classifica.</p>'}</section>`;
    if (sc.some(x=>x.team)) h += `<section class="card"><span class="lab">CLASSIFICA MARCATORI</span>${sc.slice(0,15).map(x=>`<div class="mrow ${isUs(x.team)?'us':''}" ${isUs(x.team)?'':'style="padding:8px 0"'}><div class="mt"><b>${esc(x.name)}</b><span class="mute" style="font-size:13px">${esc(x.team)}</span></div><b class="res">${x.goals}</b></div>`).join('')}</section>`; }
  if (S.ltab==='disciplina') { const d = L.discipline||{}, lab = {squalifiche:'Squalifiche',diffide:'Diffide',ammonizioni:'Ammonizioni'};
    const ours = k => (d[k]||[]).filter(x=>isUs(x.team));
    h += `<section class="card"><span class="lab">THE RIMINESER · ULTIMO COMUNICATO</span>${['squalifiche','diffide','ammonizioni'].map(k=>`<div><b>${lab[k]}</b><div class="names">${ours(k).map(x=>`<span class="chip ${k==='ammonizioni'?'forse':'partita'}">${esc(x.name)}${x.note?' · '+esc(x.note):''}</span>`).join('')||'<span class="mute">Nessuno</span>'}</div></div>`).join('')}</section>
    <details class="card"><summary>Tutte le squadre</summary>${['squalifiche','diffide','ammonizioni'].map(k=>`<div><b>${lab[k]}</b>${(d[k]||[]).map(x=>`<div class="mute" style="font-size:14px">${esc(x.name)} – ${esc(x.team)}${x.note?' · '+esc(x.note):''}</div>`).join('')||'<div class="mute">Nessuno</div>'}</div>`).join('')}</details>`; }
  h += `<p class="mute" style="font-size:13px">Si aggiorna da solo appena UISP Rimini pubblica un nuovo comunicato. Ultimo comunicato letto: ${esc(new Date(L.updated+'T12:00').toLocaleDateString('it-IT',{day:'numeric',month:'long'}))}. <a href="${esc(L.source)}" target="_blank" rel="noopener">Comunicati ufficiali</a></p>`;
  return h;
}

/* ---------- schermate ---------- */
function vInstall(){
  if (standalone()) return '';
  if (installEvt) return `<section class="card install"><b>Installa l'app sul telefono</b><span class="mute">Avrai l'icona della squadra sulla schermata Home.</span><button class="pri" data-act="install">Installa</button></section>`;
  if (isIOS()) return `<section class="card install"><b>Installa l'app sull'iPhone</b><span class="mute">In Safari tocca Condividi (il quadrato con la freccia), poi "Aggiungi alla schermata Home".</span></section>`;
  return '';
}
function vHome(){
  const nx = upcoming()[0]; let h = vInstall() + vPushCard(false);
  if (asAdmin() && pendingP().length) h += `<section class="card install"><b>${pendingP().length} giocator${pendingP().length>1?'i aspettano':'e aspetta'} la tua approvazione</b><button class="sec" data-act="go" data-t="rosa">Vai alla Rosa</button></section>`;
  // Un solo riquadro: il prossimo evento, partita o allenamento.
  if (nx) { const isM = nx.type==='partita', pres = roster().filter(id=>ans(id,nx.id)==='si').length, nLu = isM ? getLus(nx).filter(l=>canLineup()||l.published).length : 0;
    h += `<section class="card"><div class="row sp"><span class="lab">PROSSIMO APPUNTAMENTO</span><span class="row" style="gap:6px"><span class="chip ${isM?'partita':''}">${isM?'Partita':'Allenamento'}</span></span></div>
    <h2>${isM?'The Rimineser F.P. <span style="color:var(--red)">vs</span> '+esc(nx.opponent||'Avversario'):'Allenamento'}</h2>
    <div class="row" style="gap:14px"><span class="res" style="white-space:nowrap">${esc(nx.time||'--:--')}</span><span class="mute" style="text-transform:capitalize">${esc(fmtD(nx,{weekday:'long',day:'numeric',month:'long'}))}</span></div>
    <div class="row mute" style="gap:6px"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>${esc(nx.location||'Campo da definire')}</div>
    ${rsvpBtns(nx.id)}${bar(nx.id)}
    <div class="btns"><button class="sec" style="flex:1" data-act="who" data-e="${esc(nx.id)}">Presenti (${pres})</button>${isM?`<button class="pri" style="flex:1" data-act="openLu" data-e="${esc(nx.id)}">${nLu>1?'Formazioni ('+nLu+')':'Formazione'}</button>`:''}</div></section>`; }
  const lp = ourPos(); if (lp) h += `<button class="card" style="flex-direction:row;align-items:center;border:0;text-align:left;width:100%" data-act="go" data-t="campionato"><span class="num" style="width:46px;height:46px;font-size:24px">${lp.pos}°</span><span style="flex:1;min-width:0"><b>Campionato UISP · ${lp.pt} punti</b><br><span class="mute" style="white-space:nowrap;font-size:13.5px">${lp.v} vinte · ${lp.n} pareggiate · ${lp.p} perse</span></span>›</button>`;
  if (!nx) h += `<section class="card dark"><span class="lab" style="color:#FF4D5E">CALENDARIO</span><p class="txt">Nessun evento in programma.${S.coach?' Aggiungilo dal Calendario.':''}</p></section>`;
  h += `<div class="row sp"><h2>Comunicazioni</h2><span class="mute">della squadra</span></div>`;
  h += S.posts.length ? S.posts.map(vPost).join('') : `<div class="empty">Ancora nessuna comunicazione.</div>`;
  if (S.config.instagram) { const u=String(S.config.instagram).replace(/^@/,''); h += `<a class="card" style="flex-direction:row;align-items:center;text-decoration:none;color:inherit" href="https://www.instagram.com/${encodeURIComponent(u)}/" target="_blank" rel="noopener"><svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="var(--red)"/></svg><span style="flex:1"><b>Seguici su Instagram</b><br><span class="mute">@${esc(u)}</span></span>›</a>`; }
  if (canPost()) h += `<button class="fab" data-act="newPost" aria-label="Nuova comunicazione o sondaggio">${icoPlus}</button>`;
  return h;
}
function vPost(p){
  const d = p.createdAt ? new Date(p.createdAt).toLocaleString('it-IT',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
  let poll = '';
  if (Array.isArray(p.options) && p.options.length){
    const v = Object.entries(S.votes).map(([id,x])=>[id,x?.answers?.[p.id]]).filter(x=>x[1]!=null);
    const tot = v.length, my = S.votes[S.uid]?.answers?.[p.id];
    poll = p.options.map((o,i)=>{ const n=v.filter(x=>x[1]===i).length; return `<button class="opt ${my===i?'me':''}" aria-pressed="${my===i}" data-act="vote" data-p="${esc(p.id)}" data-i="${i}"><i style="width:${tot?n/tot*100:0}%"></i><span><span>${esc(o)}</span><span>${n}</span></span></button>`; }).join('')
      + `<details><summary>Chi ha votato (${tot})</summary>${p.options.map((o,i)=>`<div class="mute">${esc(o)}</div><div class="names">${v.filter(x=>x[1]===i).map(x=>`<span class="chip">${esc(nameOf(x[0]))}</span>`).join('')||'<span class="mute">—</span>'}</div>`).join('')}</details>`;
  }
  return `<article class="card"><div class="row"><img class="crestimg" src="icons/logo-256.png" alt="" width="36" height="36" style="width:36px;height:36px"><div style="flex:1"><b>${esc(!p.author ? 'The Rimineser F.P.' : (S.config.coaches||[]).includes(p.author) ? 'Amministratore' : nameOf(p.author))}</b>${p.author && !(S.config.coaches||[]).includes(p.author) ? tagLabel(p.author) : ''}<div class="mute" style="font-size:13px">${esc(d)}</div></div>${p.important?'<span class="chip partita">Importante</span>':''}${canPost()?`<button class="lnk" data-act="delPost" data-id="${esc(p.id)}">Elimina</button>`:''}</div>
  <p class="txt">${esc(p.text)}</p>${poll}</article>`;
}
function vPresenze(){
  const ev = upcoming().slice(0,8);
  if (!ev.length) return `<h2>Presenze</h2><div class="empty">Nessun evento in arrivo.</div>`;
  return `<h2>Presenze</h2>` + ev.map(e=>{
    return `<section class="card"><div class="row sp"><span class="chip ${e.type==='partita'?'partita':''}">${e.type==='partita'?'Partita':'Allenamento'}</span><span class="mute">${esc(fmtD(e))} · ${esc(e.time||'')}</span></div>
    <h3>${esc(evName(e))}</h3>${rsvpBtns(e.id)}${bar(e.id)}
    <details><summary>Presenti</summary>
      ${attendees(e,true)}
      ${S.coach?`<p class="mute" style="margin:0">Tocca un nome per cambiare la sua risposta.</p>${S.admin?`<button class="pri" data-act="pushRemind" data-e="${esc(e.id)}">🔔 Notifica a chi non ha risposto</button>`:''}<button class="sec" data-act="remind" data-e="${esc(e.id)}">Copia promemoria per WhatsApp</button>`:''}
    </details></section>`;
  }).join('');
}
function luCard(l, sm){
  return `<div><b>Panchina</b><div class="names">${(l.bench||[]).map(id=>`<span class="chip">${esc(nameOf(id))}</span>`).join('')||'<span class="mute">—</span>'}</div></div>${l.tactic?`<div><b>Tattica</b><p class="txt">${esc(l.tactic)}</p></div>`:''}`;
}
function vFormazione(){
  const ms = [...upcoming().filter(e=>e.type==='partita'), ...past().filter(e=>e.type==='partita')];
  if (!ms.length) return `<h2>Formazione</h2><div class="empty">Nessuna partita in calendario.</div>`;
  if (!ms.find(e=>e.id===S.fe)) S.fe = ms[0].id;
  const e = ms.find(x=>x.id===S.fe);
  let h = `<h2>Formazione</h2><label>Partita<select data-ch="fe">${ms.map(x=>`<option value="${esc(x.id)}" ${x.id===S.fe?'selected':''}>${esc(fmtD(x))} – ${esc(evName(x))}</option>`).join('')}</select></label>`;
  if (!canLineup()){
    const pub = getLus(e).filter(l=>l.published);
    if (!pub.length) return h + `<div class="card"><p class="txt mute">Nessuna formazione ancora pubblicata per questa partita.</p></div>`;
    if (pub.length>1) h += `<p class="mute" style="margin:0">Ci sono ${pub.length} formazioni possibili.</p>`;
    return h + pub.map(l=>`<section class="card"><div class="row sp"><h3>${esc(l.name||'Formazione')}</h3><span class="chip">${esc(l.module)}</span></div>${pitch(l)}${luCard(l)}</section>`).join('');
  }
  if (!S.draft || S.draft.eid !== e.id){ const items = getLus(e).map(l=>({name:l.name||'Formazione', module:l.module||'2-3-1', slots:[...(l.slots||[])].concat(Array(7).fill('')).slice(0,7), bench:[...(l.bench||[])], tactic:l.tactic||'', published:!!l.published}));
    S.draft = {eid:e.id, idx:0, items: items.length ? items : [blankLu(1)]}; }
  const Dr = S.draft; if (Dr.idx >= Dr.items.length) Dr.idx = 0;
  const L = Dr.items[Dr.idx], r = squad(), pos = MODS[L.module];
  const mark = id => ({si:' ✓',forse:' ?',no:' ✗'})[ans(id,e.id)] || '';
  h += `<div class="mods" role="tablist" aria-label="Formazioni">${Dr.items.map((l,i)=>`<button role="tab" class="${i===Dr.idx?'on':''}" aria-selected="${i===Dr.idx}" data-act="luSel" data-i="${i}">${esc(l.name||'Formazione '+(i+1))}${l.published?' ✓':''}</button>`).join('')}<button data-act="luAdd" aria-label="Aggiungi una formazione">+ Nuova</button></div>
  <section class="card"><div class="row sp"><span class="chip ${L.published?'si':''}">${L.published?'Pubblicata':'Bozza: i giocatori non la vedono'}</span><button class="lnk" data-act="copyLu">Copia dall'ultima partita</button></div>
    <label>Nome formazione<input data-in="luname" value="${esc(L.name)}" maxlength="30"></label>
    <div class="mods" role="group" aria-label="Modulo">${Object.keys(MODS).map(m=>`<button class="${m===L.module?'on':''}" aria-pressed="${m===L.module}" data-act="mod" data-m="${m}">${m}</button>`).join('')}</div>
    ${pitch(L)}
    <div class="slots">${pos.map(([,,role],i)=>`<label>${i+1}. ${role}<select data-ch="slot" data-i="${i}"><option value="">—</option>${r.map(id=>`<option value="${esc(id)}" ${L.slots[i]===id?'selected':''}>${esc(nameOf(id))}${mark(id)}</option>`).join('')}</select></label>`).join('')}</div>
    <p class="mute" style="margin:0">✓ presente · ? forse · ✗ assente</p>
    <div><b>Panchina</b><div class="names" style="flex-direction:column">${r.filter(id=>!L.slots.includes(id)).map(id=>`<label class="ck"><input type="checkbox" data-ch="bench" value="${esc(id)}" ${L.bench.includes(id)?'checked':''}>${esc(nameOf(id))}${mark(id)}</label>`).join('')||'<span class="mute">Nessun altro giocatore in rosa.</span>'}</div></div>
    <label>Tattica e indicazioni<textarea data-in="tac" placeholder="Es. pressing alto, uscita dal basso col portiere, marcature sui calci d'angolo…">${esc(L.tactic)}</textarea></label>
    <div class="btns"><button class="sec" style="flex:1" data-act="saveLu" data-p="0">${L.published?'Nascondi':'Salva bozza'}</button><button class="pri" style="flex:1" data-act="saveLu" data-p="1">${L.published?'Aggiorna':'Pubblica'}</button></div>
    <button class="lnk" style="align-self:flex-start" data-act="luDel">Elimina questa formazione</button></section>`;
  return h;
}
function evRow(e){
  const my = ans(actId(),e.id), res = e.result && e.result.us!=null && e.result.them!=null;
  return `<div class="ev"><div class="ed"><b>${esc(fmtD(e,{day:'numeric'})||'–')}</b><small>${esc(fmtD(e,{weekday:'short'}))}</small></div>
  <div class="eb"><div class="row" style="gap:6px"><span class="chip ${e.type==='partita'?'partita':''}">${e.type==='partita'?'Partita':'Allenamento'}</span>${e.uisp?`<span class="chip">UISP ${e.uisp}ª</span>`:''}${my?`<span class="chip ${my}">${LAB[my]}</span>`:''}</div>
  <h3>${esc(evName(e))}${res?` <span class="res">${esc(e.result.us)}–${esc(e.result.them)}</span>`:''}</h3>
  <span class="mute">${esc(e.time||'')}${e.location?' · '+esc(e.location):''}</span>${e.notes?`<span class="mute">${esc(e.notes)}</span>`:''}</div>
  ${S.coach?`<button class="lnk" data-act="editEv" data-id="${esc(e.id)}">Modifica</button>`:''}</div>`;
}
function byMonth(list){
  const g = {}; list.forEach(e=>{ const k=fmtD(e,{month:'long',year:'numeric'}) || 'Data non comunicata'; (g[k]=g[k]||[]).push(e); });
  return Object.entries(g).map(([k,v])=>`<section class="card"><span class="lab" style="text-transform:capitalize">${esc(k)}</span>${v.map(evRow).join('')}</section>`).join('');
}
function vCalendario(){
  const up = upcoming(), pa = past();
  return `<div class="row sp"><h2>Calendario</h2>${S.coach?'<button class="pri" data-act="newEv">+ Evento</button>':''}</div>
  ${up.length?byMonth(up):'<div class="empty">Nessun evento in programma.</div>'}
  ${pa.length?`<details><summary>Eventi passati (${pa.length})</summary>${byMonth(pa)}</details>`:''}`;
}
function vArchivio(){
  const ms = past().filter(e=>e.type==='partita');
  const done = ms.filter(e=>e.result && e.result.us!=null && e.result.them!=null);
  const w = done.filter(e=>+e.result.us>+e.result.them).length, d = done.filter(e=>+e.result.us===+e.result.them).length, l = done.length-w-d;
  let h = `<h2>Archivio partite</h2><section class="card dark"><div class="score"><div><b>${w}</b>Vinte</div><div><b>${d}</b>Pareggi</div><div><b>${l}</b>Perse</div></div></section>`;
  if (!ms.length) return h + `<div class="empty">Le partite giocate, con formazione e tattica, compariranno qui.</div>`;
  return h + ms.map(e=>{ const lus=getLus(e).filter(l=>l.published||canLineup()), lu=lus[0], res=e.result&&e.result.us!=null&&e.result.them!=null;
    const out = res ? (+e.result.us>+e.result.them?['V','si']:+e.result.us===+e.result.them?['N','forse']:['P','no']) : null;
    return `<details class="card"><summary style="color:inherit;justify-content:space-between;gap:10px"><span><span class="mute" style="font-size:13px">${esc([e.uisp ? e.uisp+'ª giornata' : '', fmtD(e)].filter(Boolean).join(' · '))}</span><br><b class="cond" style="font-size:21px">${esc(evName(e))}</b></span><span class="row" style="gap:6px">${lu?`<span class="chip">${esc(lu.module)}${lus.length>1?' +'+(lus.length-1):''}</span>`:''}${res?`<span class="res">${esc(e.result.us)}–${esc(e.result.them)}</span><span class="chip ${out[1]}">${out[0]}</span>`:'<span class="chip forse">Risultato in aggiornamento</span>'}</span></summary>
    ${lus.length ? lus.map(l=>`<div class="row sp"><b>${esc(l.name||'Formazione')}</b><span class="chip">${esc(l.module)}</span></div>${pitch(l,true)}${luCard(l)}`).join('') : '<p class="mute">Nessuna formazione salvata.</p>'}
    ${e.notes?`<p class="txt mute">${esc(e.notes)}</p>`:''}</details>`; }).join('');
}
function vRosa(){
  const r = roster(), on = onlineCount();
  let h = `<div class="row sp"><h2>Rosa</h2>${on!=null?`<span class="chip online-n"><i class="dot-on"></i>Online ora: ${on}</span>`:''}</div>`;
  h += r.length ? CATS.map(([k,pl])=>{ const ids=r.filter(id=>catOf(id)===k); if (!ids.length) return '';
    return `<section class="card"><span class="lab">${pl.toUpperCase()} · ${ids.length}</span>${ids.map(id=>{ const p=S.players[id]||{}; return `<div class="row" style="padding:6px 0"><span class="num">${esc(isPl(id)?(p.number||'–'):pl[0])}</span><div style="flex:1"><b>${esc(nameOf(id))}</b>${mine(id)?' <span class="chip">Tu</span>':''}<div class="mute" style="font-size:13px">${esc(CATS.find(c=>c[0]===k)[2])}${p.manual?' · aggiunto dall\'amministratore':''}</div></div>${asAdmin()&&!mine(id)?`<button class="lnk" data-act="editP" data-id="${esc(id)}">Modifica</button>`:''}</div>`; }).join('')}</section>`; }).join('') : '<section class="card"><div class="empty">Nessuno ancora in rosa.</div></section>';
  return h;
}

function vImpostazioni(){
  const me = S.players[actId()] || {}, pe = pendingP();
  let h = `<div class="row sp"><h2>Impostazioni</h2></div>`;
  h += `<section class="card"><span class="lab">IL MIO PROFILO</span><div class="row" style="padding:2px 0"><span class="num">${esc(me.number||'–')}</span><div style="flex:1"><b>${esc(me.name||S.authName)}</b><div class="mute" style="font-size:13px">${esc((CATS.find(c=>c[0]===(me.cat||'giocatore'))||[])[2]||'')}</div></div></div>
    <div class="btns"><button class="pri" data-act="me">Il mio profilo</button><button class="sec" data-act="logout">Esci</button></div></section>`;
  if (asAdmin() && pe.length) h += `<section class="card install"><b>Da approvare</b>${pe.map(id=>`<div class="row sp"><span>${esc(nameOf(id))} <span class="mute">· ${esc(CATS.find(c=>c[0]===catOf(id))[2])}</span></span><span class="row" style="gap:4px"><button class="lnk" data-act="rejP" data-id="${esc(id)}">Rifiuta</button><button class="pri" data-act="okP" data-id="${esc(id)}">Approva</button></span></div>`).join('')}</section>`;
  h += vPushCard(true) || `<section class="card"><span class="lab">NOTIFICHE</span><span class="mute">Su questo dispositivo le notifiche non sono disponibili.</span></section>`;
  if (asAdmin()) h += vViews();
  if (asAdmin()) h += `<section class="card"><span class="lab">AMMINISTRATORE</span><span class="mute">Aggiungi in rosa chi non usa l'app: potrai segnare tu le sue presenze.</span><button class="pri" data-act="addP">+ Aggiungi nuovo iscritto</button></section>`;
  if (asAdmin()) h += `<section class="card"><span class="lab">SQUADRA</span><form data-form="team"><label>Profilo Instagram<input name="ig" value="${esc(S.config.instagram||'')}" placeholder="@nomeprofilo"></label>
    <div class="btns"><button class="pri" type="submit">Salva</button><button class="sec" type="button" data-act="pushTest">Invia notifica di prova</button></div></form></section>`;
  return h;
}

/* ---------- disegno ---------- */
const TABS = [
  ['home','Bacheca','<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>'],
  ['presenze','Presenze','<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>'],
  ['formazione','Formazione','<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/><circle cx="12" cy="12" r="3"/>'],
  ['calendario','Calendario','<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  ['campionato','Campionato','<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'],
  ['archivio','Archivio','<path d="M4 4h16v5H4z"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>']
];
function shell(){
  if ($('#app')) return;
  $('#root').innerHTML = `<header class="top"><img class="crestimg" src="icons/logo-256.png" alt="" width="46" height="46"><div class="grow"><h1>THE RIMINESER F.P.</h1><small id="who">Football Project · Calcio a 7</small><button id="modeBtn" class="modepill" data-act="mode" hidden></button></div>
  <button class="ib" data-act="go" data-t="impostazioni" aria-label="Impostazioni"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
  <button class="ib" data-act="go" data-t="rosa" aria-label="Rosa della squadra"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/></svg></button></header>
  <main id="app"></main>
  <nav class="tabs" id="tabs">${TABS.map(([t,l,p])=>`<button data-act="go" data-t="${t}"><svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>${l}</button>`).join('')}</nav>`;
}
function vLogin(){
  const m = S.login;
  return `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><h1>${m==='up'?'Entra in squadra':m==='reset'?'Recupera password':'Bentornato'}</h1>
  <form data-form="auth" novalidate>
    ${m==='up'?`<label>Nome e cognome<input name="nome" autocomplete="name" required></label><label>Entro in squadra come${catSel('giocatore', false)}</label>`:''}
    <label>Email<input type="email" name="email" autocomplete="email" required></label>
    ${m!=='reset'?`<label>Password<input type="password" name="pwd" autocomplete="${m==='up'?'new-password':'current-password'}" minlength="6" required></label>`:''}
    <p class="err" id="authErr" role="alert"></p>
    <button class="pri" type="submit">${m==='up'?'Registrati':m==='reset'?'Invia email di recupero':'Accedi'}</button>
  </form>
  ${m!=='reset'?`<div class="or"><span>oppure</span></div><button class="gbtn" data-act="google"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Accedi con Google</button>`:''}
  ${m==='in'?'<button class="lnk" data-act="lmode" data-m="up">Prima volta? Registrati</button><button class="lnk" data-act="lmode" data-m="reset">Password dimenticata?</button>':'<button class="lnk" data-act="lmode" data-m="in">Ho già un account: accedi</button>'}</div>`;
}
function draw(){
  if (S.phase==='login') { $('#root').innerHTML = vLogin(); return; }
  if (S.phase==='loading') { $('#root').innerHTML = `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><p>Caricamento…</p></div>`; return; }
  if (S.phase==='setup') { $('#root').innerHTML = `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><h1>Squadra da configurare</h1><p style="max-width:380px;text-align:center">L'app non ha ancora un amministratore. Se sei tu a gestire l'app, premi il pulsante: potrai approvare gli iscritti.</p><button class="pri" data-act="beCoach">Sono l'amministratore</button><button class="lnk" data-act="logout">Esci</button></div>`; return; }
  if (S.phase==='rejected') { $('#root').innerHTML = `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><h1>Richiesta non accettata</h1><p style="max-width:380px;text-align:center">L'amministratore non ha accettato la tua iscrizione. Se pensi sia un errore, contatta la squadra.</p><button class="lnk" data-act="logout">Esci</button></div>`; return; }
  if (S.phase==='pending') { $('#root').innerHTML = `<div class="login"><img src="icons/logo-256.png" alt="Logo The Rimineser F.P." width="220" height="220"><h1>Richiesta inviata</h1><p style="max-width:380px;text-align:center">Ciao ${esc(S.authName)}! L'amministratore deve approvare il tuo ingresso in squadra. Appena lo fa, questa schermata si aggiorna da sola.</p><label style="width:100%;max-width:380px">Entro in squadra come<select data-ch="mycat">${CATS.filter(([k])=>!STAFFCATS.includes(k)).map(([k,,l])=>`<option value="${k}" ${((S.me||{}).cat||'giocatore')===k?'selected':''}>${l}</option>`).join('')}</select></label><button class="lnk" data-act="logout">Esci</button></div>`; return; }
  shell();
  const a = document.activeElement;
  if (a && $('#app').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type!=='checkbox') { S.pending = true; return; }
  S.pending = false;
  $('#who').textContent = asAdmin() ? 'Amministratore · Calcio a 7' : S.admin ? nameOf(gid())+' · Giocatore' : 'Football Project · Calcio a 7';
  const mb = $('#modeBtn'); if (mb) { mb.hidden = !S.admin; mb.textContent = asAdmin() ? '⇄ Passa a Giocatore' : '⇄ Passa ad Amministratore'; }
  document.querySelectorAll('#tabs button, .top .ib').forEach(b=>b.classList.toggle('on', b.dataset.t===S.tab));
  watchPresence(S.tab==='rosa');
  let h = '';
  if (!['posts','events','players','rsvp','votes'].every(k=>S.loaded.has(k)) && !S.slow) h = `<div class="empty">Caricamento…</div>`;
  else {
    if (S.slow) h += `<div class="card" role="status" style="background:var(--maybg)">Connessione lenta o assente: i dati potrebbero non essere aggiornati.</div>`;
    h += ({home:vHome,presenze:vPresenze,formazione:vFormazione,calendario:vCalendario,campionato:vCampionato,archivio:vArchivio,rosa:vRosa,impostazioni:vImpostazioni}[S.tab]||vHome)();
  }
  $('#app').innerHTML = h;
}
document.addEventListener('focusout', ()=>setTimeout(()=>{ if (S.pending) draw(); }, 400));

/* ---------- finestre ---------- */
function openSheet(html){ $('#panel').innerHTML = html; $('#sheet').hidden = false; const f=$('#panel input,#panel textarea,#panel select'); f&&f.focus(); }
function closeSheet(){ $('#sheet').hidden = true; $('#panel').innerHTML = ''; }
$('#sheet').addEventListener('click', e=>{ if (e.target.id==='sheet') closeSheet(); });
document.addEventListener('keydown', e=>{ if (e.key==='Escape' && !$('#sheet').hidden) closeSheet(); });
const head = t => `<div class="row sp"><h2 id="shT">${t}</h2><button class="lnk" type="button" data-act="close">Chiudi</button></div>`;
function evForm(e){
  e = e || {type:'partita', home:true};
  openSheet(`${head(e.id?'Modifica evento':'Nuovo evento')}<form data-form="ev" data-id="${esc(e.id||'')}">
  <label>Tipo<select name="tipo"><option value="partita" ${e.type==='partita'?'selected':''}>Partita</option><option value="allenamento" ${e.type==='allenamento'?'selected':''}>Allenamento</option></select></label>
  <div class="slots"><label>Data<input type="date" name="data" required value="${esc(e.date||'')}"></label><label>Ora<input type="time" name="ora" required value="${esc(e.time||'')}"></label></div>
  <label>Avversario (solo partite)<input name="avversario" value="${esc(e.opponent||'')}"></label>
  <label>Campo / luogo<input name="luogo" value="${esc(e.location||'')}"></label>
  <label>Note<textarea name="note" placeholder="Ritrovo, maglie, quota arbitro…">${esc(e.notes||'')}</textarea></label>
  <div class="slots"><label>Gol nostri<input type="number" min="0" name="noi" value="${esc(e.result?.us??'')}"></label><label>Gol avversari<input type="number" min="0" name="loro" value="${esc(e.result?.them??'')}"></label></div>
  <button class="pri" type="submit">Salva</button>${e.uisp?'<p class="mute" style="margin:0">Partita del campionato UISP: data, ora, campo e risultato si aggiornano da soli dai comunicati ufficiali.</p>':e.id?`<button class="sec" type="button" data-act="delEv" data-id="${esc(e.id)}">Elimina evento</button>`:''}</form>`);
}

/* ---------- azioni ---------- */
async function setRsvp(id, eid, v){
  await write(()=>setDoc(D('rsvp/'+id), {answers:{[eid]: v ? v : deleteField()}}, {merge:true}));
}
function confirm2(b){ if (b.dataset.c) return true; b.dataset.c='1'; const t=b.textContent; b.textContent='Conferma?'; setTimeout(()=>{ if (b.isConnected){ delete b.dataset.c; b.textContent=t; } },3000); return false; }
const ACT = {
  go: d => { S.tab = d.t; history.replaceState(null,'','#'+d.t); draw(); scrollTo(0,0); },
  close: () => closeSheet(),
  lmode: d => { S.login = d.m; draw(); },
  logout: async () => { await presenceOff(); signOut(auth); },
  google: async () => { const err=$('#authErr'); if (err) err.textContent='';
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch(e){ if (e.code==='auth/popup-closed-by-user' || e.code==='auth/cancelled-popup-request') return;
      if (err) err.textContent = e.code==='auth/popup-blocked' ? 'Il telefono ha bloccato la finestra di Google: riprova o usa email e password.' : 'Accesso con Google non riuscito qui: usa email e password.'; } },
  install: async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch(_){} installEvt = null; draw(); },
  beCoach: () => write(()=>setDoc(D('config/team'), {coaches:[S.uid], instagram:'', createdAt:Date.now()}), 'Sei l\'amministratore della squadra!'),
  rsvp: d => setRsvp(actId(), d.e, ans(actId(),d.e)===d.v ? '' : d.v),
  mode: () => { mode = asAdmin() ? 'player' : 'admin'; try { localStorage.setItem('rim-mode', mode); } catch(_) {} draw(); toast(asAdmin() ? 'Modalità Amministratore' : 'Modalità Giocatore'); },
  cyc: d => { const o=['','si','forse','no']; setRsvp(d.id, d.e, o[(o.indexOf(ans(d.id,d.e))+1)%4]); },
  vote: d => { const i=+d.i, same=(S.votes[S.uid]?.answers||{})[d.p]===i; write(()=>setDoc(D('votes/'+S.uid), {answers:{[d.p]: same ? deleteField() : i}}, {merge:true})); },
  remind: d => { const e=S.events.find(x=>x.id===d.e); if (!e) return; const miss=squad().filter(id=>!ans(id,e.id)).map(nameOf);
    const t = `⚽ The Rimineser F.P. – ${evName(e)}, ${fmtD(e)} ore ${e.time||''}.\nRispondete al sondaggio presenze sull'app: ${location.origin+location.pathname}${miss.length?'\nMancano: '+miss.join(', '):''}`;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(()=>toast('Promemoria copiato: incollalo nel gruppo.'), ()=>openSheet(head('Promemoria')+`<textarea readonly>${esc(t)}</textarea>`)); },
  newPost: () => openSheet(`${head('Nuova comunicazione')}<form data-form="post"><label>Messaggio<textarea name="testo" required placeholder="Scrivi alla squadra…"></textarea></label>
    <label class="ck"><input type="checkbox" name="imp">Segna come importante</label>
    <label>Sondaggio (facoltativo): una opzione per riga<textarea name="opzioni" placeholder="Pizza venerdì&#10;Pizza sabato&#10;Non vengo"></textarea></label>
    <button class="pri" type="submit">Pubblica</button></form>`),
  delPost: (d,b) => { if (confirm2(b)) write(()=>deleteDoc(D('posts/'+d.id)), 'Comunicazione eliminata'); },
  newEv: () => evForm(),
  editEv: d => evForm(S.events.find(e=>e.id===d.id)),
  delEv: async (d,b) => { if (confirm2(b) && await write(()=>deleteDoc(D('events/'+d.id)), 'Evento eliminato')) closeSheet(); },
  mod: d => { S.draft.items[S.draft.idx].module = d.m; draw(); },
  pushOn: () => enablePush(),
  pushTest: () => { notifyTeam('test', '🔔 Prova notifiche', 'Se leggi questo messaggio, le notifiche funzionano!', '#home'); toast('Notifica di prova inviata'); },
  pushRemind: d => { const e=S.events.find(x=>x.id===d.e); if (!e) return; notifyTeam('remind', `⏰ ${evName(e)} · ${fmtD(e)} ${e.time||''}`, 'Non hai ancora risposto alle presenze: ci sei?', '#presenze', {eventId:e.id}); toast('Promemoria inviato a chi non ha risposto'); },
  ltab: d => { S.ltab = d.k; draw(); },
  lround: d => { S.lround = +d.n; draw(); },
  luSel: d => { S.draft.idx = +d.i; draw(); },
  luAdd: () => { const Dr=S.draft, cur=Dr.items[Dr.idx]; Dr.items.push({...JSON.parse(JSON.stringify(cur)), name:'Formazione '+(Dr.items.length+1), published:false}); Dr.idx = Dr.items.length-1; draw(); toast('Nuova formazione creata partendo da quella aperta.'); },
  luDel: async (d,b) => { if (!confirm2(b)) return; const Dr=S.draft; Dr.items.splice(Dr.idx,1); if (!Dr.items.length) Dr.items.push(blankLu(1)); Dr.idx=0;
    await write(()=>setDoc(D('events/'+Dr.eid), {lineups:Dr.items}, {merge:true}), 'Formazione eliminata'); draw(); },
  who: d => { const e=S.events.find(x=>x.id===d.e); if (!e) return; openSheet(`${head('Presenti')}<p class="mute" style="margin:0">${esc(evName(e))} · ${esc(fmtD(e))} · ${esc(e.time||'')}</p>${attendees(e,false)}`); },
  openLu: d => { S.fe = d.e; S.draft = null; ACT.go({t:'formazione'}); },
  editP: d => { const p=S.players[d.id]||{}; openSheet(`${head('Modifica')}<form data-form="editp" data-id="${esc(d.id)}"><label>Nome<input name="nome" required value="${esc(p.name||'')}"></label><label>Categoria${catSel(p.cat)}</label><p class="mute" style="margin:0">Mister, Preparatore atletico, Social media manager: possono pubblicare comunicazioni. Capitano: comunicazioni e formazioni.</p><label>Numero di maglia<input type="number" min="1" max="99" name="numero" value="${esc(p.number||'')}"></label><button class="pri" type="submit">Salva</button><button class="sec" type="button" data-act="delP" data-id="${esc(d.id)}">Rimuovi dalla rosa</button></form>`); },
  copyLu: () => { const src = past().concat(upcoming()).find(e=>e.type==='partita' && e.id!==S.draft.eid && getLus(e).length); if (!src) return toast('Nessuna formazione precedente da copiare.');
    const l = getLus(src).find(x=>x.published) || getLus(src)[0], cur = S.draft.items[S.draft.idx];
    Object.assign(cur, {module:l.module, slots:[...(l.slots||[])].concat(Array(7).fill('')).slice(0,7), bench:[...(l.bench||[])], tactic:l.tactic||''}); draw(); toast('Copiata da '+evName(src)+' ('+fmtD(src)+')'); },
  saveLu: async d => { const Dr=S.draft, pub=d.p==='1', e=S.events.find(x=>x.id===Dr.eid); if (!e) return;
    const L = Dr.items[Dr.idx], was = L.published; L.bench = L.bench.filter(id=>!L.slots.includes(id)); L.published = pub;
    if (await write(()=>setDoc(D('events/'+e.id), {lineups:Dr.items}, {merge:true}), pub?(was?'Formazione aggiornata':'Formazione pubblicata'):(was?'Formazione nascosta ai giocatori':'Bozza salvata'))) {
      if (pub && !was) notifyTeam('lineup', '⚽ Formazione pubblicata', `${L.name} per ${evName(e)} (${fmtD(e)}): modulo ${L.module}`, '#formazione');
      if (pub && !was) await write(()=>addDoc(C('posts'), {text:`Pubblicata la formazione "${L.name}" per ${evName(e)} di ${fmtD(e,{weekday:'long',day:'numeric',month:'long'})}: modulo ${L.module}. La trovate nella sezione Formazione.`, createdAt:Date.now(), author:asAdmin()?S.uid:actId()}));
      draw(); } else L.published = was; },
  me: () => { const p=S.players[actId()]||{}; openSheet(`${head('Il mio profilo')}<form data-form="me"><label>Nome e cognome<input name="nome" required value="${esc(p.name||S.authName)}"></label><label>Numero di maglia<input type="number" min="1" max="99" name="numero" value="${esc(p.number||'')}"></label><label>Categoria${catSel(p.cat||'giocatore')}</label><button class="pri" type="submit">Salva</button></form>`); },
  addP: () => openSheet(`${head('Aggiungi giocatore')}<p class="mute" style="margin:0">Per chi non usa l'app: potrai segnare tu le sue presenze.</p><form data-form="addp"><label>Nome e cognome<input name="nome" required></label><label>Categoria${catSel('giocatore')}</label><label>Numero di maglia<input type="number" min="1" max="99" name="numero"></label><button class="pri" type="submit">Aggiungi</button></form>`),
  okP: d => write(()=>updateDoc(D('players/'+d.id), {approved:true, rejected:false}), 'Giocatore approvato'),
  rejP: (d,b) => { if (confirm2(b)) write(()=>updateDoc(D('players/'+d.id), {rejected:true}), 'Richiesta rifiutata'); },
  delP: async (d,b) => { if (confirm2(b) && await write(()=>deleteDoc(D('players/'+d.id)), 'Rimosso dalla rosa')) closeSheet(); }
};
const AUTH_ERR = { 'auth/invalid-credential':'Email o password non corretti.', 'auth/wrong-password':'Email o password non corretti.', 'auth/user-not-found':'Email o password non corretti.',
  'auth/email-already-in-use':'Questa email è già registrata: accedi.', 'auth/weak-password':'La password deve avere almeno 6 caratteri.', 'auth/invalid-email':'Email non valida.',
  'auth/missing-password':'Inserisci la password.', 'auth/too-many-requests':'Troppi tentativi: riprova tra qualche minuto.', 'auth/network-request-failed':'Nessuna connessione a internet.' };
const FORMS = {
  auth: async f => { const err=$('#authErr'), email=val(f,'email'), pwd=f.elements.pwd?.value||''; err.textContent='';
    try {
      if (S.login==='reset') { await sendPasswordResetEmail(auth, email); err.textContent='Ti abbiamo mandato un\'email per scegliere una nuova password.'; return; }
      if (S.login==='up') { const nome=val(f,'nome'); if (!nome) { err.textContent='Scrivi il tuo nome.'; return; }
        regName = nome; regCat = f.elements.cat?.value || 'giocatore'; const c = await createUserWithEmailAndPassword(auth, email, pwd); await updateProfile(c.user, {displayName:nome}); }
      else await signInWithEmailAndPassword(auth, email, pwd);
    } catch(e){ err.textContent = AUTH_ERR[e.code] || 'Qualcosa è andato storto, riprova.'; } },
  post: async f => { const opts=val(f,'opzioni').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,10);
    const data={text:val(f,'testo'), important:f.elements.imp.checked, createdAt:Date.now(), author:asAdmin()?S.uid:actId()}; if (opts.length>1) data.options=opts;
    if (data.text && await write(()=>addDoc(C('posts'), data), 'Pubblicato')) { closeSheet(); notifyTeam(data.options?'poll':'post', data.options?'📊 Nuovo sondaggio':'📣 Nuova comunicazione', data.text, '#home'); } },
  ev: async f => { const id=f.dataset.id, old=S.events.find(e=>e.id===id)||{}, noi=val(f,'noi'), loro=val(f,'loro');
    const data={type:val(f,'tipo'), date:val(f,'data'), time:val(f,'ora'), opponent:val(f,'avversario'), location:val(f,'luogo'), home:old.home!==false, notes:val(f,'note'),
      result: noi!=='' && loro!=='' ? {us:+noi, them:+loro} : null};
    if (!data.date) return toast('Inserisci la data.');
    if (old.lineup) data.lineup = old.lineup; if (old.lineups) data.lineups = old.lineups;
    const ref = id ? D('events/'+id) : doc(C('events'));
    if (await write(()=>setDoc(ref, data, {merge:true}), 'Evento salvato')) closeSheet(); },
  me: async f => { if (S.admin && /amministratore/i.test(val(f,'nome'))) return toast('Come giocatore usa il tuo nome, non "Amministratore".');
    const data={name:val(f,'nome'), number:val(f,'numero'), cat:val(f,'cat')||'giocatore'}; if (!data.name) return;
    const ok = S.admin ? await write(()=>setDoc(D('players/'+gid()), {...data, approved:true, owner:S.uid}, {merge:true}), 'Profilo giocatore salvato')
                       : await write(()=>updateDoc(D('players/'+S.uid), data), 'Profilo salvato');
    if (ok) { closeSheet(); if (auth.currentUser) updateProfile(auth.currentUser, {displayName:data.name}).catch(()=>{}); } },
  editp: async f => { const data={name:val(f,'nome'), cat:val(f,'cat'), number:val(f,'numero')}; if (data.name && await write(()=>updateDoc(D('players/'+f.dataset.id), data), 'Salvato')) closeSheet(); },
  addp: async f => { const data={name:val(f,'nome'), number:val(f,'numero'), cat:val(f,'cat')||'giocatore', approved:true, manual:true};
    if (data.name && await write(()=>setDoc(D('players/m_'+Date.now().toString(36)), data), 'Giocatore aggiunto')) closeSheet(); },
  team: async f => {
    if (await write(()=>updateDoc(D('config/team'), {instagram:val(f,'ig').replace(/^@/,'')}), 'Salvato')) closeSheet(); }
};
document.addEventListener('click', e=>{ const b=e.target.closest('[data-act]'); if (b && ACT[b.dataset.act]) { e.preventDefault(); ACT[b.dataset.act](b.dataset, b); } });
document.addEventListener('submit', e=>{ const f=e.target; if (f.dataset.form && FORMS[f.dataset.form]) { e.preventDefault(); FORMS[f.dataset.form](f); } });
document.addEventListener('change', e=>{ const t=e.target, c=t.dataset.ch; if (!c) return;
  if (c==='fe') { S.fe=t.value; S.draft=null; t.blur(); draw(); }
  if (c==='steam') { S.steam = t.value; t.blur(); draw(); return; }
  if (c==='mycat') { write(()=>updateDoc(D('players/'+S.uid), {cat:t.value}), 'Salvato'); return; }
  if (c==='pref') { const prefs={...allPrefs((S.myTok||{}).prefs), [t.value]: t.checked}; write(()=>setDoc(D('tokens/'+S.uid), {prefs}, {merge:true})); return; }
  const L = S.draft && S.draft.items[S.draft.idx];
  if (c==='slot') { const i=+t.dataset.i; L.slots=L.slots.map((x,j)=>j!==i&&x===t.value&&t.value?'':x); L.slots[i]=t.value; L.bench=L.bench.filter(x=>x!==t.value); t.blur(); draw(); }
  if (c==='bench') L.bench = t.checked ? [...L.bench, t.value] : L.bench.filter(x=>x!==t.value);
});
document.addEventListener('input', e=>{ const k=e.target.dataset.in, L=S.draft&&S.draft.items[S.draft.idx]; if (!L) return; if (k==='tac') L.tactic = e.target.value; if (k==='luname') L.name = e.target.value; });
addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); installEvt = e; if (S.phase==='app') draw(); });
const fromHash = () => { const h=location.hash.slice(1); if (['home','presenze','formazione','calendario','campionato','archivio','rosa','impostazioni'].includes(h)) { S.tab=h; if (S.phase==='app') draw(); } };
addEventListener('hashchange', fromHash); fromHash();
