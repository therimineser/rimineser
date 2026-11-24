// Controllo del sito UISP Rimini (stessa ricerca di tools/uisp_update.py → discover):
// trova i PDF "Calcio a 7 … del gg-mm-aa" nelle pagine del sito. Il Worker lo fa OGNI MINUTO il VENERDÌ
// (il giorno dei comunicati): appena c'è un PDF che campionato.json non ha ancora letto, avvia subito
// il robot UISP su GitHub (uisp.yml), che legge il PDF, aggiorna il campionato e pubblica l'app.
export const START_PAGES = ['https://www.uisp.it/rimini/pagina/calcio',
  'https://www.uisp.it/rimini/pagina/uisp-rimini-20252026',
  'https://www.uisp.it/rimini/pagina/uisp-rimini-20262027'];

export function seasonStart(nowMs) { const d = new Date(nowMs); const y = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-08-01`; }
export const fileName = url => { try { return decodeURIComponent(url.split('#')[0].split('?')[0].split('/').pop()); } catch (_) { return url.split('/').pop(); } };
export function fileDate(url) {
  const m = /del\s*(\d{1,2})-(\d{1,2})-(\d{2,4})/i.exec(fileName(url)); if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}
// da una pagina: PDF del calcio a 7 di questa stagione e altre pagine da guardare
export function scan(pageUrl, body, nowMs) {
  const pdfs = {}, pages = [], from = seasonStart(nowMs);
  for (const m of body.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].replace(/&amp;/g, '&');
    let full; try { full = new URL(href, pageUrl).href; } catch (_) { continue; }
    let low; try { low = decodeURIComponent(full).toLowerCase(); } catch (_) { low = full.toLowerCase(); }
    if (low.endsWith('.pdf') && low.includes('calcio a 7')) { const d = fileDate(full); if (d && d >= from) pdfs[fileName(full)] = d; }
    else if (low.includes('/rimini/pagina/') && /uisp-rimini-20\d\d|risultati-calcio-a-7/.test(low)) pages.push(full.split('#')[0]);
  }
  return { pdfs, pages };
}
// tutti i PDF trovati (nome → data); al massimo 6 pagine per giro
export async function findPdfs(f, nowMs) {
  const queue = [...START_PAGES], seen = new Set(), pdfs = {};
  while (queue.length && seen.size < 6) {
    const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
    try {
      const r = await f(url, { headers: { 'User-Agent': 'Mozilla/5.0 (RimineserApp)' }, cf: { cacheTtl: 0 } });
      if (!r.ok) continue;
      const s = scan(url, await r.text(), nowMs);
      Object.assign(pdfs, s.pdfs); queue.push(...s.pages.filter(p => !seen.has(p)));
    } catch (_) { /* pagina non raggiungibile: riprova il minuto dopo */ }
  }
  return pdfs;
}
