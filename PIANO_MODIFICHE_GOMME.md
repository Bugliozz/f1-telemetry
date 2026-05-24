# Piano modifiche — Gomme & Performance

Branch di lavoro: `delivery/final-project-delivery` → merge finale su `main`.

Obiettivo: tre modifiche al simulatore.
1. Ogni pit stop cambia **la gomma** (non più il carburante — logica rifornimento già rimossa in questo branch).
2. Modello **mescole** (Soft/Medium/Hard) con degrado per-mescola + varianza per-auto → pit scaglionati; al pit si monta una mescola **diversa** (regola F1).
3. Performance auto **più diversificate** per aumentare i distacchi in gara.

Si procede **uno step alla volta**: ogni step ha i suoi test verdi prima di passare al successivo.

---

## Decisioni di design (da confermare prima di iniziare)

- **A — Trigger del pit:** oggi il pit scatta a giro fisso (`tireServiceLap: 2`), quindi tutte le auto si fermano insieme. Si passa a **trigger su soglia di usura** (`tireWear >= soglia` dentro la pit-window). È questo il meccanismo che scagliona i pit. ✅ consigliato
- **B — Dove vive la mescola corrente:** si aggiunge il campo `compound` al payload **telemetria** (così la dashboard mostra la gomma live per ogni auto). Alternativa: solo nell'evento `pit-stop`, ma allora la dashboard non può mostrare la gomma di partenza. ✅ consigliato: in telemetria.
- **C — Durata mescole (gara da 5 giri):** Soft ~2 giri, Medium ~3 giri, Hard ~4 giri, con varianza ±15% per-auto. Da tarare nello Step 2.

> Annotare qui eventuali modifiche a queste scelte prima di partire.

---

## STEP 0 — Baseline (prima di toccare il codice)

- [x] Eseguire la suite e annotare lo stato verde di partenza: `cd simulator && npm test` → **222 passati, 0 falliti**
- [ ] (Facoltativo) Avviare lo stack e fare uno screenshot della dashboard attuale come riferimento: `docker compose up`

---

## STEP 1 — Pit stop = cambio gomme (rifinitura)

La meccanica c'è già; va resa coerente e tolto l'hardcoded.

- [x] **`schemas/event.schema.json`** — riconciliati i `details` dell'evento `pit-stop`: `tyreCompound` ora obbligatorio, ammessi `service`/`refuelling`, rimosso `fuelAdded`.
- [x] **`simulator/src/car/car.js`** ([~L137-146](simulator/src/car/car.js#L137-L146)) — rimosso il campo morto `fuelAddedKg`. Il `tyreCompound` resta `'medium'` fisso **finché lo Step 2 non lo rende dinamico**.
- [x] **`simulator/scripts/seed.js`** ([~L112-121](simulator/scripts/seed.js#L112-L121)) — evento pit-stop di esempio aggiornato alla nuova forma (niente `fuelAdded`).
- [x] **Verifica:** suite completa **222/222**; validazione ajv conferma che lo schema accetta la nuova forma e rifiuta `fuelAddedKg`/`fuelAdded`/compound mancante.

---

## STEP 2 — Modello mescole (cuore della modifica)

### 2.1 — Nuovo modulo mescole
- [x] **`simulator/src/car/compounds.js`** (nuovo) — definizioni pure:
  - `COMPOUNDS = { soft: { color: 'red', lifeLaps, ... }, medium: { color: 'yellow', ... }, hard: { color: 'white', ... } }`
  - indice di degrado **per mescola** (uguale per tutte le auto della stessa mescola)
  - `randomCompound(rng)` → mescola di partenza casuale
  - `pickDifferentCompound(current, rng)` → al pit, una delle altre due (regola F1)

### 2.2 — Stato per-auto
- [x] **`simulator/src/car/car.js`** — nel costruttore:
  - `this.compound = randomCompound(tireRng)` (mescola di partenza casuale)
  - `this._tireWear = 0` (accumulatore di usura 0→1)
  - `this._wearVariance` = moltiplicatore per-auto (`1 + (tireRng-0.5)*2*variancePct`, `variancePct` da `tireWearVariancePct`, default 0.15) → scagliona i pit tra auto con la stessa mescola
  - **Nota:** compound e variance NON usano `this.rng` ma un PRNG dedicato `tireRng = createCarPrng(seed, carId ^ TIRE_RNG_SALT)`. Motivo: pescare da `this.rng` slittava lo stream per-auto e rompeva i seed deterministici (es. `test-race-modes.js` seed 73). Lo stream dedicato resta riproducibile dal seme globale ma lascia intatto quello di fisica/guasti → suite 222/222 verde.

### 2.3 — Accumulo usura + collegamento al modello termico
- [x] **`car.js` `_tickRunning`** — accumulare `_tireWear` in base a `compound.degradoPerGiro * _wearVariance * frazione-di-giro-avanzata`.
- [x] Sostituire l'attuale `wearFactor = 1 + lap * wearPerLap` ([car.js:215-216](simulator/src/car/car.js#L215-L216)) con un `wearFactor` derivato da `_tireWear`/mescola, **mantenendo le temperature nel range operativo** (non deve scattare il FAULT da overheat — vedi nota in [tire-fuel.js:22-27](simulator/src/car/tire-fuel.js#L22-L27)).

### 2.4 — Trigger pit su usura (scaglionamento)
- [x] **`simulator/src/car/conditions.js`** — `isTireServiceDue` ora valuta `tireWear >= TIRE_WEAR_PIT_THRESHOLD` (default `0.6`) sempre dentro la pit-entry window. Rimossi `TIRE_SERVICE_LAP`/lap-based; reason ora `tire-service:wear-NN%`.
- [x] Aggiornata l'`observation` per passare `tireWear` + `tireWearPitThreshold` al posto di `tireServiceLap`.

### 2.5 — Cambio mescola al pit
- [x] **`car.js`** logica pit — al service: `this.compound = pickDifferentCompound(this.compound, this._tireRng)`, reset `this._tireWear = 0`, evento `pit-stop` con il **nuovo** `tyreCompound`.
  - **Nota:** uso `this._tireRng` (stream gomme dedicato, salvato nel costruttore) invece di `this.rng` come da bozza, per non slittare lo stream fisica/guasti e preservare i seed deterministici — coerente con la decisione di §2.2.

### 2.6 — Esporre la mescola (telemetria + dashboard)
- [x] **`schemas/telemetry.schema.json`** — aggiungere `compound` (enum `soft|medium|hard`) — vedi Decisione B.
- [x] **`car.js` `_buildTelemetry`** ([car.js:461-521](simulator/src/car/car.js#L461-L521)) — includere `compound` nel payload.
- [x] **`node-red/data/public/dashboard.js`** — mostrare un badge mescola color-coded (rosso/giallo/bianco) per auto in classifica/pannello telemetria.
- [x] **`simulator/scripts/seed.js`** — se `compound` diventa obbligatorio in telemetria, aggiungerlo ai sample seed.

### 2.7 — Config
- [x] **`simulator/config/default.js`** — aggiungere parametri mescole (durata/giro per mescola, `tireWearPitThreshold`, `tireWearVariancePct`); rimuovere/ripensare `tireServiceLap` e `wearPerLap` ([default.js:43,54](simulator/config/default.js#L43)).

### 2.8 — Test Step 2
- [x] Aggiornare/estendere `test-tire-fuel.js`, `test-conditions.js`, `test-fsm.js` (il trigger `tire-service` non è più lap-based).
- [x] Nuovo mini-test per `compounds.js` (random di partenza, `pickDifferentCompound` mai uguale alla corrente).
- [x] `npm test` verde.
- [x] **Verifica funzionale:** run del simulatore e conferma che le auto si fermano in **giri diversi** e rimontano una mescola **diversa** da quella che avevano.

---

## STEP 3 — Performance diversificate (più distacchi)

- [x] **`simulator/config/default.js`** — allargare `teamPerformanceFactor` ([default.js:90-96](simulator/config/default.js#L90-L96)) (es. ~0.97–1.03 invece di 0.995–1.012).
- [x] Aggiungere un **fattore per-pilota** così i due compagni di team non sono identici (piccola varianza per `carId`).
- [x] **`car.js`** — introdurre `this._driverFactor` nel costruttore e applicarlo nel target velocità ([car.js:170-171](simulator/src/car/car.js#L170-L171)) insieme a `_teamFactor`.
- [x] (Eventuale) ritarare `speedJitterKmh`.
- [x] **Verifica:** controllare che i distacchi aumentino **senza** sballare i limiti SC/VSC/velocità massima; classifica realistica.
- [x] `npm test` verde.

---

## Chiusura

- [ ] Aggiornare i punti diventati nei `docs/` se necessario.
- [ ] `npm test` completo verde + run funzionale finale con screenshot dashboard.
- [ ] Commit per step (conventional commits) e merge finale su `main`.

---

### File coinvolti (mappa rapida)
| Area | File |
|---|---|
| Modello mescole (nuovo) | `simulator/src/car/compounds.js` |
| Stato auto, pit, telemetria | `simulator/src/car/car.js` |
| Trigger pit | `simulator/src/car/conditions.js` |
| Modello termico/usura | `simulator/src/car/tire-fuel.js` |
| Config | `simulator/config/default.js` |
| Schema telemetria | `schemas/telemetry.schema.json` |
| Schema eventi | `schemas/event.schema.json` |
| Dashboard | `node-red/data/public/dashboard.js` |
| Seed dati | `simulator/scripts/seed.js` |
| Test | `simulator/scripts/test-{tire-fuel,conditions,fsm}.js` + nuovo per compounds |
