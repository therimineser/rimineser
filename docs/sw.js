// Service worker: rende l'app installabile e apribile anche con rete debole.
// I dati della squadra li gestisce Firebase (con la sua cache offline).
const CACHE = 'rimineser-v13';
const SHELL = ['./', './index.html', './app.js', './firebase-config.js', './campionato.json', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/logo-256.png', './icons/favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Prima la rete (così gli aggiornamenti arrivano subito), poi la copia salvata.
  const key = url.pathname.endsWith('campionato.json') ? new Request('./campionato.json') : e.request;
  e.respondWith(
    fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); return r; })
      .catch(() => caches.match(key).then(r => r || caches.match('./index.html')))
  );
});

// Notifiche push (inviate dal robot tramite Firebase Cloud Messaging)
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (_) { p = { data: { body: e.data && e.data.text() } }; }
  const d = p.data || p.notification || p;
  e.waitUntil(self.registration.showNotification(d.title || 'The Rimineser F.P.', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge.png',
    tag: d.tag || undefined, data: { url: d.url || '#home' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '#home', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
