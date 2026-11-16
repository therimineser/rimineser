# App The Rimineser F.P. – Guida per metterla online

Tempo: circa 35 minuti, una volta sola, meglio da computer. Tutto gratuito.

Cosa usiamo:
- **Firebase** (Google): accessi e dati della squadra (bacheca, presenze, formazioni…).
- **GitHub**: ospita l'app e fa girare il **robot** che ogni 30 minuti controlla il sito UISP Rimini e, appena esce un comunicato nuovo, aggiorna da solo risultati, classifica, prossimo turno, marcatori e cartellini. Le nostre partite di campionato compaiono in automatico nel calendario dell'app.

Contenuto della cartella:
- `docs/` → l'app vera e propria
- `tools/` → il robot che legge i comunicati UISP
- `.github/workflows/` → gli orari dei due robot, campionato e notifiche (cartella nascosta, vedi passo 6)
- `firestore.rules` → le regole di sicurezza del database

---

## PARTE 1 – Firebase (dati e accessi)

### 1. Crea il progetto
console.firebase.google.com → **Crea un progetto** → nome `rimineser` → (Analytics si può disattivare) → **Crea**.

### 2. Collega l'app
Icona **`</>`** (Web) → nome `Rimineser` → **Registra app**. Copia i valori del blocco `firebaseConfig` e incollali nel file **`docs/firebase-config.js`** al posto di ogni `INCOLLA-QUI` (Blocco note va benissimo). Salva.
*Se preferisci, manda i valori a Claude e ti restituisce la cartella pronta.*

### 3. Attiva l'accesso con email
**Authentication → Inizia → Email/password → Abilita → Salva**.

### 4. Crea il database
**Firestore Database → Crea database** → posizione **europe-west8 (Milano)** → modalità **produzione** → **Crea**.
Scheda **Regole** → cancella tutto → incolla il contenuto di `firestore.rules` → **Pubblica**.

---

## PARTE 2 – GitHub (app online + robot UISP)

### 5. Crea il progetto su GitHub
1. Crea un account gratuito su https://github.com (se non ce l'hai).
2. In alto a destra **+ → New repository**.
3. Nome: `rimineser` · visibilità **Public** · **Create repository**.

### 6. Carica i file
1. Nella pagina del progetto: **uploading an existing file**.
2. Trascina **tutto il contenuto** della cartella (`docs`, `tools`, `tests`, `.github`, `firestore.rules`, `firebase.json`, `GUIDA.md`) → **Commit changes**.
3. Controlla che nell'elenco compaia la cartella **`.github`**.
   - Non c'è? È nascosta dal computer. Su Mac nel Finder premi **Cmd + Maiusc + .** per vederla e ricaricala.
   - In alternativa: **Add file → Create new file**, come nome scrivi `.github/workflows/uisp.yml`, incolla il contenuto del file `tools/robot-github.yml` → **Commit changes**. Ripeti con nome `.github/workflows/notifiche.yml` e il contenuto di `tools/robot-notifiche.yml`.

### 7. Attiva il sito
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 8. Accendi il robot
1. Scheda **Actions** (se compare un pulsante verde per abilitare i workflow, premilo).
2. A sinistra **Aggiorna campionato UISP e pubblica l'app** → **Run workflow** → **Run workflow**.
3. Dopo 1-2 minuti compare la spunta verde. Al primo giro il robot rilegge tutti i comunicati della stagione e pubblica l'app.
4. L'indirizzo dell'app è: **`https://TUONOMEUTENTE.github.io/rimineser/`** (lo trovi anche in Settings → Pages).

### 9. Autorizza l'indirizzo su Firebase
Firebase → **Authentication → Impostazioni → Domini autorizzati → Aggiungi dominio** → `TUONOMEUTENTE.github.io`.

---

## PARTE 3 – Notifiche push (circa 10 minuti)

### 10. Chiave per le notifiche (nell'app)
Firebase → ⚙️ **Impostazioni progetto → Cloud Messaging** → sezione **Configurazione web / Certificati push web** → **Genera coppia di chiavi**. Copia la chiave e incollala in **`docs/firebase-config.js`**, alla riga `vapidKey`, al posto di `INCOLLA-QUI`. Poi ricarica quel file su GitHub (**Add file → Upload files** nella cartella `docs`).

### 11. Chiave del robot (segreta)
1. Firebase → ⚙️ **Impostazioni progetto → Account di servizio → Genera nuova chiave privata** → si scarica un file `.json`.
2. GitHub, nel progetto `rimineser` → **Settings → Secrets and variables → Actions → New repository secret**.
3. Nome: `FIREBASE_SA` · Valore: apri il file `.json` con Blocco note, copia **tutto** e incollalo → **Add secret**.
4. Cancella il file `.json` dal computer (ora è al sicuro su GitHub).

### 12. Gettone per le notifiche immediate
1. GitHub → foto profilo in alto a destra → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Nome `rimineser-notifiche` · Scadenza: la più lunga possibile · **Repository access: Only select repositories → rimineser**.
3. **Permissions → Repository permissions → Actions: Read and write** (nient'altro) → **Generate token** → copia il gettone (`github_pat_…`).
4. Nell'app: **Rosa → Impostazioni → Gettone GitHub** → incolla → **Salva**.
5. Premi **Invia notifica di prova**: dopo aver attivato le notifiche sul tuo telefono (passo 15) deve arrivare in meno di un minuto.

Senza gettone le notifiche funzionano lo stesso, ma partono entro 15 minuti invece che subito. Quando il gettone scade, GitHub ti manda un'email: ne crei uno nuovo e lo reincolli.

---

## PARTE 4 – Squadra

### 13. Primo accesso (tu, amministratore)
Apri il link dal telefono → **Registrati** → **Sono l'amministratore**. Fallo per primo: da quel momento solo tu approvi gli iscritti. In **Rosa → Impostazioni** metti il profilo Instagram.

### 14. Installa l'icona
- **Android (Chrome):** pulsante **Installa** in bacheca, oppure menu ⋮ → *Installa app*.
- **iPhone (Safari):** Condividi → *Aggiungi alla schermata Home*.

### 15. Attiva le notifiche
Nella bacheca premi **🔔 Attiva notifiche** e consenti. Su iPhone funziona solo aprendo l'app dall'icona sulla Home (passo 14). Ognuno può scegliere quali notifiche ricevere in **Rosa → Notifiche attive**.

### 16. Invita la squadra
Manda il link nel gruppo WhatsApp: ognuno si registra (giocatore, dirigente, pubblico…) e tu lo approvi in **Rosa → Da approvare**.

---

### Domande frequenti
- **Quali notifiche arrivano?** 📣 comunicazioni e sondaggi · ⚽ formazione pubblicata · ⏰ il giorno prima di partite e allenamenti, solo a chi non ha ancora risposto alle presenze (e quando qualcuno preme "Notifica a chi non ha risposto") · 🏆 nuovo comunicato UISP con risultato, posizione e prossima partita.
- **Le notifiche costano?** No: Firebase Cloud Messaging è gratuito anche nel piano gratuito, nessuna carta di credito.
- **Quando si aggiorna il campionato?** Il robot controlla ogni 30 minuti (a volte GitHub ritarda di qualche minuto). Appena UISP pubblica il PDF, entro circa mezz'ora l'app mostra risultati, classifica e prossimo turno; la nostra partita appare da sola nel calendario, con data, ora e campo, e se UISP la sposta l'app si corregge.
- **E se un comunicato è scritto in modo strano?** Il robot controlla che i numeri tornino; se non riesce a leggerlo non tocca i dati vecchi e riprova. In **Actions** vedrai la scritta "ATTENZIONE": copia quel messaggio e mandalo a Claude per sistemare il robot.
- **Pausa estiva:** se nel progetto non succede nulla per 60 giorni, GitHub mette in pausa il robot. Alla ripresa: **Actions → workflow → Enable workflow**.
- **Nuova stagione:** il robot cerca da solo i comunicati della stagione in corso (da agosto). Se UISP cambia la pagina dei risultati, basta aggiungere il nuovo indirizzo in `tools/uisp_update.py` (riga `START_PAGES`).
- **Modificare l'app:** carica i file modificati nella cartella `docs` su GitHub (Add file → Upload files): il sito si aggiorna da solo in un paio di minuti.
- **Costa qualcosa?** No: Firebase (piano gratuito) e GitHub (progetto pubblico) sono gratis.
