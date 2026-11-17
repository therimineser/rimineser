# The Rimineser F.P. – App della squadra

Scheda del progetto per chi (persona o Claude) riprende il lavoro. Nessun segreto qui dentro.

## Cos'è
App web installabile (PWA) per la squadra di calcio a 7 **The Rimineser F.P.** (Rimini, campionato UISP).
- Online: https://therimineser.github.io/rimineser/
- Amministratore: Giacomo (account GitHub `therimineser`). Unico ruolo speciale: approva/modifica/toglie gli iscritti.
- L'amministratore ha due profili: "Amministratore" (non compare mai tra i giocatori) e il suo profilo giocatore `players/<uid>_g`; pulsante nell'intestazione per passare dall'uno all'altro (modalità salvata in localStorage `rim-mode`). Presenze del giocatore in `rsvp/<uid>_g`.
- Tutti gli iscritti approvati hanno gli stessi diritti (comunicazioni, sondaggi, eventi, formazioni, presenze, Instagram).
- Lingua dell'app e delle risposte: italiano. Colori: rosso #E30613, bianco, nero; tema sempre chiaro.

## Funzioni
- **Bacheca**: un solo riquadro "PROSSIMO APPUNTAMENTO" (partita o allenamento) con Presente/Forse/Assente, pulsante "Presenti (n)" e, se partita, "Formazione/Formazioni"; riquadro posizione UISP; comunicazioni con autore e sondaggi.
- **Presenze**: per evento, divise per categoria (Giocatori, Allenatori, Dirigenza, Pubblico); chiunque può cambiare la risposta altrui; pulsante notifica a chi non ha risposto; copia promemoria WhatsApp.
- **Formazione**: più formazioni per partita (A, B…), moduli 2-3-1, 3-2-1, 3-1-2, 2-2-2, 2-1-2-1, panchina, tattica, pubblica/nascondi, copia dall'ultima partita.
- **Calendario**: eventi manuali + partite UISP create in automatico (id `uisp-<giornata>`; data/ora/campo/risultato arrivano dai comunicati).
- **Campionato**: classifica, statistiche con grafici (gol per giornata, gol fatti/subiti, ammonizioni, punti disciplina), risultati, calendario (tutte le giornate pubblicate da UISP), marcatori, cartellini (da `docs/campionato.json`; cartellini cumulati in `cards`).
- **Archivio**: partite giocate con risultato, formazioni e tattica; bilancio V/N/P.
- **Rosa**: iscritti per categoria, profilo personale, approvazioni (solo admin), impostazioni (Instagram per tutti; gettone GitHub solo admin). Richieste rifiutate: `players/{uid}.rejected=true` (la persona vede "Richiesta non accettata").
- **Accesso**: email/password e "Accedi con Google" (popup; su iPhone da icona può non funzionare → email).
- **Notifiche push** (FCM): comunicazioni/sondaggi, formazione pubblicata, promemoria il giorno prima (dalle 12, solo a chi non ha risposto), nuovo comunicato UISP. Preferenze per utente.

## Struttura
- `docs/` = l'app pubblicata da GitHub Pages (Source: GitHub Actions)
  - `index.html` (stili), `app.js` (tutta la logica, ES module, Firebase JS SDK 12.19.0 da gstatic), `firebase-config.js` (config pubblica + vapidKey), `sw.js` (cache + push), `manifest.webmanifest`, `icons/`, `campionato.json` (scritto dal robot).
- `tools/uisp_update.py` = robot UISP: cerca i PDF "Calcio a 7 … del dd-mm-yy" su uisp.it/rimini, estrae testo (pypdf/pdftotext), legge risultati/classifica/prossimo turno/marcatori/provvedimenti, valida e unisce in `docs/campionato.json`. Test: `python tools/uisp_update.py --text tests/gg4.txt --name "Calcio a 7 _ giornata 4 _ N. 5 del 13-11-26 - gg 4.pdf"`.
- `tools/notify.py` = robot notifiche: Firestore REST + FCM v1 con il segreto `FIREBASE_SA`; invia la coda `outbox`, i promemoria, l'avviso UISP; stato in `robot/state`.
- `.github/workflows/uisp.yml` = ogni 5 min (controllo rapido, legge solo se c'è un PDF nuovo) + su push: aggiorna campionato, committa, pubblica Pages, sveglia notifiche.
- `.github/workflows/notifiche.yml` = ogni 5 min + workflow_dispatch (l'app lo sveglia con il gettone salvato in Firestore `private/robot`).
- `firestore.rules` = regole (copiate a mano nella console Firebase: se cambiano, vanno ri-incollate lì).

## Dati Firestore (progetto Firebase `rimineser`, europe-west8)
`config/team` {coaches:[uid admin], instagram} · `players/{uid}` {name, number, role, cat, approved, manual?} · `posts/{id}` {text, important, options?, author, createdAt} · `events/{id}` {type, date, time, opponent, location, home, notes, result, lineups[]} · `rsvp/{uid}` {answers:{eventId: si|forse|no}} · `votes/{uid}` {answers:{postId: idx}} · `tokens/{uid}` {tokens:{fcmToken: ts}, prefs} · `outbox/{id}` · `private/robot` {token} · `robot/state`.

## Come si aggiorna
Modificare i file in `docs/` e fare push su `main`: il workflow ripubblica in ~1-2 minuti e i telefoni prendono la versione nuova alla riapertura (service worker network-first). Nel workflow non toccare `docs/campionato.json` a mano (lo gestisce il robot).

## Idee in sospeso
- Pulsanti "Condividi su WhatsApp" (comunicazioni, formazione, presenti, promemoria, risultati UISP).
- Diretta testuale della partita e link a diretta YouTube.
