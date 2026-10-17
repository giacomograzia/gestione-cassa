# Nuova Cassa

Punto cassa web per sagre ed eventi, erede del vecchio programma *Cassa 2.0.x* per Windows.
Un solo server gira su un computer (per esempio il Mac mini della sagra); casse, cucina e
amministrazione si usano dal browser di qualsiasi dispositivo in rete: Mac, Windows, iPad, telefoni.

## Cosa fa

- **Cassa**: prodotti per famiglia con colori, menù a scelta, prezzo libero, omaggi, sconti
  (% o €), note per la cucina, tavolo/nome o asporto, contanti con calcolo del resto, carta.
- **Magazzino**: quantità per prodotto o magazzini condivisi tra più prodotti (es. "Tigelle"),
  unità scaricate per pezzo (es. 0,5 per mezza bottiglia), avviso sotto scorta, prodotti esauriti
  bloccati in tempo reale su tutte le casse.
- **Comande e cucina**: ogni reparto riceve la sua comanda stampata e ha un monitor in tempo
  reale (con suono) dove segnare i piatti pronti e consegnati. Gli storni avvisano il reparto.
- **Stampa**: stampanti termiche ESC/POS in rete o USB (via CUPS), scontrino riepilogativo non
  fiscale, ticket di ritiro con numero grande, coda di stampa con ristampa dei lavori falliti.
- **Ordini e statistiche**: storico della giornata, ristampa, storno con motivo (ripristina il
  magazzino), venduto per prodotto/famiglia/operatore/pagamento, export CSV, chiusura di cassa.
- **Sicurezza**: accesso con PIN per operatore, ruoli *admin*, *cassa*, *cucina*; tutte le query
  usano parametri (niente SQL injection); limite ai tentativi di PIN.
- **Dati**: un unico file SQLite con backup automatici (all'avvio, prima di ogni chiusura e di
  ogni importazione); importazione del catalogo dal vecchio programma.

## Avvio rapido (Mac)

Serve **Node.js 22** o successivo (`node -v` per controllare; si installa da nodejs.org o con `nvm install 22`).

```bash
npm install
npm run build
npm start
```

Il terminale mostra gli indirizzi da aprire, per esempio `http://192.168.1.20:3000`. Al primo
accesso si crea l'amministratore. Poi, in **Gestione**:

1. **Stampanti**: aggiungi le stampanti (usa "Anteprima su file" per provare senza stampante).
2. **Casse**: crea una postazione per ogni computer/tablet che vende e collega la stampante scontrini.
3. **Reparti**: crea i reparti (cucina, bar, griglia…) e collega la stampante comande.
4. **Famiglie**, **Prodotti**, **Menù**, **Magazzini**: il catalogo. In alternativa importalo (sotto).
5. **Operatori**: un utente con PIN per ogni cassiere; un utente *cucina* per i monitor.

Gli altri dispositivi aprono lo stesso indirizzo nel browser. Il Mac che fa da server deve restare
acceso e non andare in stop durante l'evento (Impostazioni di Sistema → Batteria/Risparmio energia).

### Stampanti

- **In rete** (consigliato): stampante termica con porta Ethernet/Wi-Fi; indica l'IP (porta 9100).
- **USB sul Mac server**: aggiungi la stampante in Impostazioni di Sistema → Stampanti (anche con
  driver "Generico"), poi indica il nome della coda: lo trovi con `lpstat -p` nel Terminale.
  I dati sono inviati in formato *raw* ESC/POS.
- Il pulsante **Prova** stampa accenti, euro e un numero grande per verificare la codifica.

### Importare il catalogo dal vecchio programma

Nel vecchio programma usa **Esporta**: crea un file nella cartella `Save` (es. `Save-20190819194802470.txt`).
Poi in Gestione → Dati scegli il file, oppure da terminale:

```bash
npm run import-legacy -- "percorso/Save-20190819194802470.txt" --replace
```

Vengono importati famiglie (con i colori), prodotti, prezzi, magazzini condivisi, reparti e menù.
Dopo l'importazione collega le stampanti ai reparti. Il significato delle colonne del vecchio
database è documentato in [docs/mappatura-database-legacy.md](docs/mappatura-database-legacy.md).

### Backup e ripartenza

- Tutti i dati sono in `data/cassa.db`; i backup in `data/backup/` (gli ultimi 30).
- Gestione → Dati → *Scarica backup adesso* per una copia da conservare altrove.
- Per ripristinare: ferma il server, sostituisci `data/cassa.db` con un backup, riavvia.
- Per ripartire da zero: ferma il server e cancella la cartella `data/`.

## Sviluppo

```bash
npm run dev        # server con ricarica automatica + interfaccia Vite su http://localhost:5173
npm test           # test automatici (vitest)
npm run typecheck  # controllo dei tipi TypeScript
```

Variabili d'ambiente: `PORT` (default 3000), `HOST` (default 0.0.0.0), `CASSA_DATA_DIR` (default `./data`).

### Struttura

```
server/
  index.ts            avvio, backup iniziale
  app.ts              Fastify: sessioni, errori, WebSocket, rotte
  db.ts               SQLite, migrazioni (PRAGMA user_version), backup
  repo.ts             lettura catalogo/ordini, impostazioni
  auth.ts             PIN (scrypt), sessioni, ruoli, limite tentativi
  domain/orders.ts    creazione ordine in transazione, magazzino, storno
  domain/stats.ts     statistiche, chiusura di cassa, CSV
  print/              documento astratto → ESC/POS o testo; coda; modelli di stampa
  routes/             API: auth, vendita/cucina/statistiche, amministrazione
  import/legacy.ts    importazione dal vecchio programma
shared/types.ts       tipi condivisi tra server e interfaccia
web/                  interfaccia React (cassa, cucina, ordini, statistiche, gestione)
test/                 test di API, importazione e stampa
```

Scelte principali:

- **Un solo server, molti browser**: niente sincronizzazione tra casse; il server è l'unica fonte
  di verità e notifica i cambiamenti via WebSocket.
- **Importi in centesimi interi**, mai decimali in virgola mobile.
- **L'ordine è una transazione**: verifica disponibilità, scala il magazzino e salva tutto insieme;
  se manca qualcosa non viene scritto nulla. Ogni movimento di magazzino è registrato.
- **La stampa non blocca la vendita**: i lavori vanno in coda; se una stampante è spenta l'ordine è
  comunque registrato e la stampa si ripete da *Ordini*.
- **Righe d'ordine con copia di nome e prezzo**: lo storico resta corretto anche se poi il catalogo cambia.

## Note

- Lo scontrino stampato è un **documento non fiscale**. Se la vendita richiede la
  certificazione fiscale (registratore telematico), verificalo con il commercialista.
- Il programma è pensato per una rete locale fidata (Wi-Fi riservato allo staff). Non esporlo su Internet.
