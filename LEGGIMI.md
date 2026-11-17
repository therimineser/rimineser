# Storico The Rimineser F.P. (senza nomi)
Copiato ogni notte da `.github/workflows/storico.yml`. Un file per evento in `partite/` (eventi già iniziati o con scouting).
I giocatori sono indicati solo con l'id Firebase: il nome si trova in Firebase `players/{id}` (leggibile solo dagli iscritti).
- `evento`: tipo, data, ora, avversario, campo, risultato.
- `formazioni`: modulo, titolari, panchina, pubblicata.
- `presenze`: id → si | forse | no | si-dirigenza.
- `scouting.azioni`: k = azione, t = us (noi) | them (avversari), h = tempo, s = secondi di gioco,
  p = giocatore (gol, cartellini, chi entra), a = assist, g = com'è nato il gol, o = chi esce, m/pm = modulo nuovo/precedente.
- `rosa.json`: id → categoria.
