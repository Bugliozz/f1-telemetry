# Piano — Split in due pagine: Overview + Dashboard Scuderie

## Obiettivo

Separare l'attuale pagina unica in due viste:

1. **`/` (Overview)** — mantiene **solo**: mappa circuito, legenda Teams, **Race Control**, **Leaderboard**.
   Rimuove i pannelli **Car States** e **Race Events**.
2. **`/dashboard` (vista Scuderie)** — l'operatore clicca una delle 5 scuderie e vede i dati **solo** delle auto di quella scuderia:
   - **schede telemetria ricche** per auto (velocità, rpm, marcia, gas/freno, DRS, carburante, mescola, usura gomme, giro, posizione/gap, stato),
   - **Car States** filtrati,
   - **Race Events** filtrati alla scuderia.

## Decisioni prese (concordate)

- **Contenuto vista team:** schede telemetria ricche (riuso del rendering già esistente `telemetryMetricRows` + badge mescola + `displayCarState`).
- **Organizzazione codice:** split in moduli ES → `js/core.js` condiviso + `js/overview.js` + `js/team-view.js`.
- **Routing / backend:** **nessuna modifica ai flow Node-RED.** Il WebSocket `/api/ws/f1` trasmette già lo snapshot completo di tutte le scuderie (ogni `car` ha `teamId`); il filtro per scuderia è lato client. La nuova pagina è servita da `httpStatic` come sottocartella `public/dashboard/` (express.static redirige `/dashboard` → `/dashboard/`).

## Fatti architetturali di riferimento

- La pagina è servita solo da `httpStatic: '/data/public'` (nessun nodo `http in`).
- WS bidirezionale: feed in uscita + comandi in entrata. I comandi scenario/restart usano `socket.send(...)` → il `core` deve esporre un `send()`.
- I render attuali sono già difensivi (`if (!elements.X) return`), il che semplifica lo split.

## Struttura file target

```
node-red/data/public/
  index.html              # Overview  → /js/core.js + /js/overview.js
  dashboard/
    index.html            # Vista team → /js/core.js + /js/team-view.js
  js/
    core.js               # stato, WS, dispatch pub/sub, helper/formatter condivisi
    overview.js           # circuito, marker, legenda, race control, leaderboard, scenario, popup
    team-view.js          # selettore scuderia, schede auto, car states + eventi filtrati
  dashboard.css           # condiviso (riferito in assoluto: /dashboard.css)
  assets/monza-circuit.svg
```

> Tutti i path negli HTML diventano **assoluti** (`/js/core.js`, `/dashboard.css`, `/assets/...`) così funzionano sia da `/` che da `/dashboard/`.

## Contratto API di `core.js` (export)

- **Stato/accessor:** `state` (single source of truth: `latestCars`, `latestStandings`, `knownTeams`, `eventIds`…), `getLatestCar(key)`, `getKnownTeams()`.
- **WS:** `connectWebSocket()`, `send(command)`, e **pub/sub** `on(type, cb)` con `type ∈ {snapshot, classification, state, event, race-control}`. `handleFrame` aggiorna lo stato (`mergeLatestCar`) e poi notifica i subscriber.
- **Helper condivisi:** `teamColor`, `carKey`, `displayCarState`, `toneForState`, `telemetryMetricRows`, `telemetrySensorsOff`, `addCompoundBadge/createCompoundBadge`, `formatGap`, `prettyReason`, `humanizeToken`, `formatDuration`, `formatClock`, `normalizedTrackPos`, `sectorLabel/sectorFullLabel`, `trackLocationAt`.
- **Costanti condivise:** `TEAM_COLORS`, `COMPOUND_LABELS`, `STATE_CLASS`, `FLAG_LABELS`, `TELEMETRY_FIELDS`, `TRACK_SECTORS`, `TRACK_LOCATIONS`.

---

## Fase 0 — Preparazione

- [ ] Creare un branch dedicato (es. `feat/dashboard-split`).
- [ ] Verificare che l'app gira oggi (overview attuale) come baseline di confronto.
- [ ] Confermare che **non** servono modifiche a `flows.json` (filtro lato client).

## Fase 1 — Estrazione `js/core.js` (logica condivisa)

- [ ] Creare la cartella `public/js/`.
- [ ] Spostare in `core.js` costanti condivise (`TEAM_COLORS`, `COMPOUND_LABELS`, `STATE_CLASS`, `FLAG_LABELS`, `TELEMETRY_FIELDS`, `TRACK_SECTORS`, `TRACK_LOCATIONS`).
- [ ] Spostare l'oggetto `state` e gli accessor.
- [ ] Spostare `connectWebSocket`, `handleFrame`, `send`, `mergeLatestCar`, `carKey`, `rememberStanding`, `rememberRaceControl`.
- [ ] Aggiungere il **pub/sub** `on(type, cb)`; far emettere a `handleFrame` gli eventi per tipo dopo l'aggiornamento di stato.
- [ ] Spostare gli helper/formatter condivisi (lista nel contratto API sopra).
- [ ] Esportare tutto come modulo ES.

## Fase 2 — Pagina Overview (`index.html` + `js/overview.js`)

- [ ] In `index.html`: **rimuovere** i pannelli `Car States` e `Race Events`.
- [ ] Aggiornare gli `<script>` a `type="module"` con path assoluti (`/js/overview.js`).
- [ ] Aggiungere un **link di navigazione** verso `/dashboard` (header).
- [ ] Spostare in `overview.js`: caricamento SVG circuito, marker/animazione, legenda, `renderFlagIndicator`/`renderRaceControl*`/`renderRaceProgress`, `renderClassification` (leaderboard), popup telemetria hover, modale scenario, pulsante restart.
- [ ] Sottoscrivere il core: `on('snapshot')`, `on('classification')`, `on('race-control')` (la flag + il pulsante restart su CHECKERED restano qui).
- [ ] `bootstrap`: `loadCircuit()` solo se esiste `#circuit-container`, poi `connectWebSocket()`.
- [ ] **Verifica overview:** track, marker, legenda, race control, leaderboard, scenario start, restart, checkered → invariati.

## Fase 3 — Pagina `/dashboard` (`dashboard/index.html` + `js/team-view.js`)

- [ ] Creare `public/dashboard/index.html` (header + link a `/`, barra **chip scuderie**, contenitore **schede auto**, pannello **Race Events**).
- [ ] Verificare che `httpStatic` la serva su `/dashboard` (redirect a `/dashboard/`).
- [ ] Costruire il **selettore scuderia**: 5 chip colorate (colore da `teamColor`), clic + accessibilità tastiera, stato attivo evidenziato.
- [ ] Persistere la scuderia scelta (URL `?team=` e/o `localStorage`) così il refresh la mantiene.
- [ ] Gestire lo stato **"nessuna scuderia selezionata"** (prompt "seleziona una scuderia").
- [ ] `renderCarStates` filtrato alla scuderia selezionata (spostato + filtro `teamId`).
- [ ] **Schede telemetria per auto:** riuso di `telemetryMetricRows`/badge mescola/`displayCarState` dal core, una scheda per auto della scuderia.
- [ ] **Race Events filtrati:** spostare `appendRaceEvent` + helper eventi (`eventTitle`, `eventTone`, `eventDetails`, `eventLocationLabel`, `raceControlTitle`, `shouldHideRaceEvent`, `renderEmptyEventLog`); mostrare solo eventi della scuderia selezionata.
- [ ] Sottoscrivere il core: `on('snapshot')`, `on('state')`, `on('event')`, `on('race-control')`.
- [ ] Aggiornamento live: al cambio scuderia ri-renderizzare da stato corrente senza aspettare il prossimo frame.

## Fase 4 — Stili (`dashboard.css`)

- [ ] Aggiungere stili per chip scuderie (stato attivo/hover/focus) e griglia schede auto.
- [ ] Riusare dove possibile le classi del popup telemetria esistente per le schede.
- [ ] Layout responsive (2 auto affiancate, wrap su schermi stretti).
- [ ] Aggiornare i `?v=` di cache-busting su CSS/JS in entrambi gli HTML.

## Fase 5 — Verifica end-to-end

- [ ] Avviare lo stack (`docker compose up`) + simulatore; aprire `localhost:1881/` e `localhost:1881/dashboard`.
- [ ] Overview mostra **solo** track + legenda + Race Control + Leaderboard (niente Car States / Race Events).
- [ ] `/dashboard`: il filtro funziona per **tutte e 5** le scuderie; schede ed eventi mostrano solo le auto della scuderia.
- [ ] Le schede si aggiornano live; gli eventi della scuderia compaiono in tempo reale.
- [ ] Reconnect WS funziona su entrambe le pagine; navigazione `/ ↔ /dashboard` ok.
- [ ] Nessuna regressione: scenario start, restart, flag CHECKERED.

## Note / rischi

- **Rischio principale:** refactor di un file funzionante da ~1750 righe. Mitigazione: estrarre in `core.js` *senza cambiare la logica*, una funzione alla volta, testando l'overview dopo la Fase 2 prima di costruire la Fase 3.
- `flows.json` **non** viene toccato (nessun nodo sovrapposto, nessuna modifica): il requisito di tenerlo ordinato è rispettato per assenza di interventi.
- Collisione di nomi: i file storici si chiamano `dashboard.*` ma la *nuova pagina* è `/dashboard`. Risolta spostando il JS in `/js/` e servendo la pagina dalla cartella `dashboard/`.
