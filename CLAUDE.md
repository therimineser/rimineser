# The Rimineser F.P. – App della squadra

Scheda del progetto per chi (persona o Claude) riprende il lavoro. Nessun segreto qui dentro.

## Cos'è
App web installabile (PWA) per la squadra di calcio a 7 **The Rimineser F.P.** (Rimini, campionato UISP).
- Online: indirizzo dell'app noto all'amministratore (non pubblicarlo; pagina con noindex)
- Amministratore: Giacomo (account GitHub `therimineser`). Unico ruolo speciale: approva/modifica/toglie gli iscritti.
- L'amministratore ha due profili: "Amministratore" (non compare mai tra i giocatori) e il suo profilo giocatore `players/<uid>_g`; pulsante nell'intestazione per passare dall'uno all'altro (modalità salvata in localStorage `rim-mode`). Presenze del giocatore in `rsvp/<uid>_g`.
- Categorie speciali `mister`, `capitano`, `preparatore`, `social` (campo `cat` in players, le assegna/toglie solo l'admin; il Capitano conta come giocatore). Comunicazioni/sondaggi: queste quattro + admin. Formazioni: Capitano, admin. Presenze, eventi, voti, Instagram: tutti gli iscritti. Vincoli anche in firestore.rules.
- Lingua dell'app e delle risposte: italiano. Colori: rosso #E30613, bianco, nero; tema sempre chiaro.

## Funzioni
- **Bacheca**: un solo riquadro "PROSSIMO APPUNTAMENTO" (partita o allenamento) con Presente/Forse/Assente, pulsante "Presenti (n)" e, se partita, "Formazione/Formazioni"; riquadro posizione UISP; comunicazioni con autore e sondaggi.
- **Presenze**: per evento, divise per categoria (Giocatori, Allenatori, Dirigenza, Pubblico); chiunque può cambiare la risposta altrui; pulsante notifica a chi non ha risposto (solo admin); copia promemoria WhatsApp.
- **Formazione**: più formazioni per partita (A, B…), moduli 2-3-1, 3-2-1, 3-1-2, 2-2-2, 2-1-2-1, panchina, tattica, pubblica/nascondi, copia dall'ultima partita.
- **Calendario**: eventi manuali + partite UISP create in automatico (id `uisp-<giornata>`; data/ora/campo/risultato arrivano dai comunicati).
- **Campionato**: classifica, statistiche con grafici (gol per giornata, gol fatti/subiti, ammonizioni, punti disciplina), risultati, calendario (tutte le giornate pubblicate da UISP), marcatori, cartellini (da `docs/campionato.json`; cartellini cumulati in `cards`).
- **Archivio**: partite giocate con risultato, formazioni e tattica; bilancio V/N/P.
- **Rosa** (icona omini in alto a destra): solo l'elenco degli iscritti per categoria (l'admin ha "Modifica" su ognuno).
- **Impostazioni** (icona ingranaggio accanto alla Rosa, scheda `impostazioni`): "Il mio profilo" (nome e cognome, numero, categoria) ed "Esci"; richieste da approvare (solo admin; la notifica di nuova richiesta porta qui); preferenze notifiche per tutti; "+ Aggiungi nuovo iscritto" (solo admin); Instagram per tutti; gettone GitHub di riserva e notifica di prova (solo admin). Richieste rifiutate: `players/{uid}.rejected=true` (la persona vede "Richiesta non accettata").
- **Accesso**: email/password e "Accedi con Google" (popup; su iPhone da icona può non funzionare → email).
- **Notifiche push** (FCM): comunicazioni/sondaggi, formazione pubblicata, promemoria partite 24, 12 e 2 ore prima a chi è Presente/Forse o non ha risposto, mai agli Assenti, allenamenti il giorno prima dalle 12 a chi non ha risposto, nuovo comunicato UISP, nuova richiesta di iscrizione (solo all'amministratore, cioè gli uid in `config/team.coaches`: mai ai giocatori). Preferenze per utente in `tokens/{uid}.prefs`: posts, lineup, r24, r12, r2 (promemoria partita separati; se assenti valgono come `remind`), remind (allenamenti e presenze), uisp.

## Struttura
- `docs/` = l'app pubblicata da GitHub Pages (Source: GitHub Actions)
  - `index.html` (stili), `app.js` (tutta la logica, ES module, Firebase JS SDK 12.19.0 da gstatic), `firebase-config.js` (config pubblica + vapidKey), `sw.js` (cache + push), `manifest.webmanifest`, `icons/`, `campionato.json` (scritto dal robot).
- `tools/uisp_update.py` = robot UISP: cerca i PDF "Calcio a 7 … del dd-mm-yy" su uisp.it/rimini, estrae testo (pypdf/pdftotext), legge risultati/classifica/prossimo turno/marcatori/provvedimenti, valida e unisce in `docs/campionato.json`. Test: `python tools/uisp_update.py --text tests/gg4.txt --name "Calcio a 7 _ giornata 4 _ N. 5 del 13-11-26 - gg 4.pdf"`.
- `worker/` = **robot notifiche principale su Cloudflare Workers** (piano gratuito): l'app, dopo aver scritto in `outbox` (o una richiesta di iscrizione), fa POST a `notifyUrl` (in `docs/firebase-config.js`) con il gettone Firebase di chi pubblica → invio in 1-2 s; Cron Trigger ogni minuto per coda, promemoria, UISP. Dedup con `robotlog/<chiave>` (creato prima di inviare); max ~48 chiamate esterne per giro, l'eccesso va in `robot/coda` e parte il minuto dopo; letture Firestore minime (query su `sent==false`, `approved==false`, eventi di oggi/domani). Battito in `robot/state.workerAt`, registro in `robot/log`. Pubblicato da `.github/workflows/worker.yml` (segreti `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `FIREBASE_SA`), che al primo giro scrive da solo `notifyUrl` nell'app.
- `tools/notify.py` = robot notifiche di **riserva** su GitHub: stessa logica (Firestore REST + FCM v1, segreto `FIREBASE_SA`); se il Worker ha girato negli ultimi 4 minuti non invia nulla e copia solo `robot/log` nel ramo `registro`. Se si cambia la logica delle notifiche, va cambiata in entrambi.
- `.github/workflows/uisp.yml` = ogni 5 min (controllo rapido, legge solo se c'è un PDF nuovo) + su push: aggiorna campionato, committa, pubblica Pages, sveglia notifiche.
- `.github/workflows/notifiche.yml` = ogni 5 min + workflow_dispatch (l'app lo sveglia con il gettone salvato in Firestore `private/robot`).
- `firestore.rules` = regole. Pubblicate in automatico su Firebase da `.github/workflows/test-regole.yml` (con `tools/pubblica_regole.py` e `FIREBASE_SA`) solo se tutti i test sull'emulatore passano; l'esito della pubblicazione è l'ultima riga di `tests/rules/risultato.txt`. Se la pubblicazione fallisse per permessi, vanno incollate a mano nella console Firebase.

## Test
- Regole: `.github/workflows/test-regole.yml` gira sull'emulatore Firebase a ogni modifica di `firestore.rules` o `tests/rules/` e scrive l'esito in `tests/rules/risultato.txt` (leggibile con git anche senza accesso ai log di Actions).
- Robot notifiche: `node tests/test_worker.mjs` (Worker) e `python3 tests/test_notify.py` (riserva GitHub), entrambi con Firestore/FCM finti e orologio controllato.
- App: la prova nel browser usa un finto Firebase (imports di app.js puntati a un `fake.js` in memoria) con Playwright; non è nel repo.

## Dati Firestore (progetto Firebase `rimineser`, europe-west8)
`config/team` {coaches:[uid admin], instagram} · `players/{uid}` {name, number, cat, approved, manual?} · `posts/{id}` {text, important, options?, author, createdAt} · `events/{id}` {type, date, time, opponent, location, home, notes, result, lineups[]} · `rsvp/{uid}` {answers:{eventId: si|forse|no}} · `votes/{uid}` {answers:{postId: idx}} · `tokens/{uid}` {tokens:{fcmToken: ts}, prefs} · `outbox/{id}` · `private/robot` {token, leggibile solo dall'admin: serve solo se il Worker non risponde, per svegliare la riserva GitHub} · `robot/state` · `robot/log` · `robot/coda` · `robotlog/{chiave}` (le ultime quattro solo per i robot: nessuna regola client).

## Come si aggiorna
**Regola dell'amministratore: prima di portare qualsiasi modifica su `main` chiedere sempre il suo ok** (si lavora sul ramo di sviluppo, poi si chiede).
Modificare i file in `docs/` e fare push su `main`: il workflow ripubblica in ~1-2 minuti e i telefoni prendono la versione nuova alla riapertura (service worker network-first). Nel workflow non toccare `docs/campionato.json` a mano (lo gestisce il robot).

## Idee in sospeso
- Pulsanti "Condividi su WhatsApp" (comunicazioni, formazione, presenti, promemoria, risultati UISP).
- Diretta testuale della partita e link a diretta YouTube.
