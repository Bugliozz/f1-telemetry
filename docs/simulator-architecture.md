# Architettura del Simulatore Multi-Car — F1 Telemetry

Documento di riferimento per la **Fase 3** del piano di implementazione.
Definisce moduli, responsabilita', loop di simulazione, FSM e modello di
configurazione del simulatore che pubblica telemetria/eventi/stati su
MQTT secondo i contratti gia' fissati nelle Fasi 1-2.

> Riferimenti: [mqtt-topics.md](mqtt-topics.md) (topic, QoS, retain) e
> [data-model.md](data-model.md) (schemi JSON e mappa MongoDB).
> Lo stub corrente in [`simulator/index.js`](../simulator/index.js) verra'
> sostituito dalla bootstrap del nuovo modulo descritto qui.

---

## 1. Obiettivi e vincoli

**Obiettivi funzionali**

- Simulare in modo realistico **10 auto / 5 team** in gara a Monza.
- Pubblicare per ogni auto:
  - `telemetry` continua a 2-5 Hz (default 4 Hz).
  - `state` on-change (retained).
  - `events` on-event (pit-stop, lap-completed, sector-completed, ...).
- Reagire alle direttive di **Race Control** (SC, VSC, GREEN/YELLOW/RED/CHECKERED)
  ricevute dal topic `f1/simulation/{raceId}/race-control/flags`.
- Generare dati coerenti con i validator JSON Schema della Fase 2.

**Vincoli non funzionali**

- **Singolo processo Node.js** con **un solo client MQTT** condiviso:
  10 auto × 5 Hz = 50 msg/s, tranquillamente servibili da una connessione.
- Latenza tick → publish < 50 ms.
- Niente dipendenze pesanti: solo `mqtt` e librerie standard.
- **Deterministico se seedato** (PRNG con seed da env), altrimenti random.
- Avvio/arresto puliti: `SIGTERM`/`SIGINT` → flush, disconnect, exit 0.

**Fuori scope (Fase 3)**

- Calcolo classifica e scrittura su MongoDB → Fase 5 (Node-RED).
- Crittografia payload → Fase 5.bis.
- Dashboard → Fase 7.

---

## 2. Vista d'insieme

```
              +------------------------------------------------+
              |              f1-simulator (Node.js)            |
              |                                                |
   roster.json|  +------------+   +-------------+              |
   config env |  |  Bootstrap |-->| Orchestrator|<---tick------|
              |  +------------+   +-------------+   (250 ms)   |
              |                          |                     |
              |                          v                     |
              |                  +---------------+             |
              |   +---------+    |  Car (x10)    |   +-------+ |
              |   |  Track  |<-->| - physics     |-->|MQTT   | |
              |   | (Monza) |    | - tireFuel    |   |Pub.   | |
              |   +---------+    | - FSM         |   +---+---+ |
              |                  +---------------+       |     |
              |                          ^               |     |
              |                          |               |     |
              |                  +---------------+       |     |
              |                  | RaceControl   |<------+     |
              |                  | Subscriber    |             |
              |                  +---------------+             |
              +------------------------------------------------+
                              ^                  |
                              |                  v
                              +-----[ MQTT Broker ]-----+
                                  Mosquitto (1883)
                              +-------------------------+
```

Il flusso e' unidirezionale per la telemetria (simulator → broker), bidirezionale
per Race Control: il simulator pubblica `events` ma **sottoscrive** `flags` per
modulare il comportamento delle auto.

---

## 3. Mappa dei moduli

Layout proposto sotto `simulator/src/`:

```
simulator/
├── index.js                  # bootstrap: legge config, avvia Orchestrator
├── package.json
├── Dockerfile
├── config/
│   ├── default.js            # parametri default (hz, soglie, durata gara...)
│   └── roster.json           # 10 auto x 5 team (ferrari, mercedes, redbull,
│                             #  mclaren, alpine) - stesso elenco del seed
├── src/
│   ├── orchestrator.js       # ciclo tick, lifecycle, fan-out alle Car
│   ├── car/
│   │   ├── car.js            # classe Car: stato + tick(dt, ctx)
│   │   ├── physics.js        # avanzamento posizione, velocita, gear/rpm
│   │   ├── tire-fuel.js      # degrado gomme, consumo carburante
│   │   └── fsm.js            # transizioni stato + reason
│   ├── track/
│   │   ├── monza.js          # profilo target speed(trackPos), settori
│   │   └── pit-lane.js       # modello pit (entry/exit, speed limit)
│   ├── race-control/
│   │   └── subscriber.js     # subscribe flags + stato globale
│   ├── mqtt/
│   │   └── publisher.js      # client MQTT + helper per topic/QoS/retain
│   └── util/
│       ├── prng.js           # PRNG seedabile (xorshift32)
│       ├── clock.js          # now() incapsulato (per test)
│       └── log.js            # logger leggero (livello da env)
└── scripts/
    ├── seed.js               # gia' presente (Fase 2)
    └── smoke-test.js         # gia' presente (Fase 0)
```

Principio: **moduli puri quando possibile**. `physics.js`, `tire-fuel.js`,
`fsm.js`, `monza.js` non fanno I/O, ricevono input e ritornano nuovo stato.
L'unico modulo con effetti collaterali e' `mqtt/publisher.js` (e
`race-control/subscriber.js` come sorgente eventi). Questo facilita test
unitari e mantiene il file size sotto le soglie globali (max ~400 righe per
file, target ~200).

---

## 4. Ciclo di simulazione

### 4.1 Tick singolo

Un solo `setInterval(tickFn, TICK_MS)` nell'`Orchestrator` (default
`TICK_MS = 250`, → 4 Hz). A ogni tick, in ordine:

1. **Snapshot del contesto globale** (`ctx`): orario simulato, flag attiva
   (da `RaceControlSubscriber`), giro leader, total laps.
2. Per ogni `Car` del roster:
   1. `car.tick(dt, ctx)` → aggiorna stato interno (posizione, velocita,
      gomme, fuel, FSM) **senza pubblicare**.
   2. Se la FSM e' transitata → genera evento `state-change` e payload
      `state` (retained).
   3. Se ha completato un settore o un giro → genera evento
      `sector-completed` o `lap-completed`.
3. **Publish batch**: l'Orchestrator passa la lista di messaggi al
   `MqttPublisher`, che li serializza e invia uno per uno con QoS/retain
   corretti (vedi tabella in `mqtt-topics.md` §2).
4. Aggiorna eventuali contatori globali (es. `leaderLap`).

`dt` e' calcolato come `(now - lastTickAt)` reale, **clampato** a
`[TICK_MS * 0.5, TICK_MS * 2]` per evitare salti se l'event loop e'
intasato. La fisica e' tempo-continua: se `dt` raddoppia, le auto avanzano
del doppio, niente perdita.

### 4.2 Tick rate unico (fisica = publish)

A 4 Hz le velocita' tipiche (60 m/s) producono un avanzamento di circa
15 m / tick = `~0.0026` di `trackPos` su Monza (5.793 km). E' abbastanza
fine per un publish e abbastanza grosso da non richiedere sub-step di
fisica. Se in futuro la dashboard chiede campioni a 5 Hz, basta cambiare
`TICK_MS = 200` senza altri ritocchi.

### 4.3 Schema temporale

```
t=0 ms     Orchestrator.start()
            ├─ MqttPublisher.connect() → on('connect')
            ├─ RaceControlSubscriber.subscribe(flags)
            └─ scheduleTick(TICK_MS)

t=N*250    tick():
            ├─ ctx = buildContext()
            ├─ for car in roster: car.tick(dt, ctx)
            ├─ for msg in pendingMessages: publisher.publish(msg)
            └─ pendingMessages.clear()

SIGTERM    stop():
            ├─ clearInterval
            ├─ pubblica per ogni auto state finale (FINISHED/RETIRED se in gara)
            ├─ publisher.end({ force: false })
            └─ process.exit(0)
```

---

## 5. Modello dell'auto

### 5.1 Stato interno (`Car`)

| Campo | Tipo | Note |
|---|---|---|
| `teamId`, `carId` | identita' | da `roster.json` |
| `state` | enum FSM | INIT inizialmente |
| `previousState` | enum FSM \| null | per il payload `state` |
| `lap` | int | 0 prima del via |
| `trackPos` | `[0,1)` | posizione normalizzata sul giro |
| `speed` | km/h | derivata dalla `targetSpeed` di Monza × modificatori |
| `gear`, `rpm` | derivati | `gear = clamp(round(speed/50), 1, 7)`, `rpm = 7000 + speed*22` con jitter |
| `throttle`, `brake` | `[0,1]` | derivati dalla differenza speed/targetSpeed |
| `drs` | bool | true sui rettilinei lunghi (settore 1 e 3 di Monza) |
| `tireTemp.{fl,fr,rl,rr}` | C | partono ~95°C, salgono con velocita' e curve, scendono in pit |
| `fuel` | kg | parte 105 kg, decrementa con throttle + speed |
| `pitStateTimer` | s \| null | per la durata del pit-stop |
| `lapStartTime` | timestamp | per calcolare `lapTime` su `lap-completed` |

Tutte le mutazioni avvengono in `car.tick()`; il chiamante (Orchestrator)
**non** scrive nei campi.

### 5.2 Output di un tick

`car.tick(dt, ctx)` ritorna un oggetto **immutabile** con i messaggi
pendenti:

```ts
{
  telemetry: TelemetryPayload,         // sempre
  state?: CarStatePayload,              // se transizione FSM
  events: CarEventPayload[]             // 0..N
}
```

Cosi' l'Orchestrator e' un semplice fan-out, e i test possono asserire
sui payload senza mockare MQTT.

---

## 6. Modello del circuito

### 6.1 Monza — profilo `targetSpeed(trackPos)`

Punti chiave (lookup table interpolata linearmente):

| trackPos | Punto | Target km/h |
|---|---|---|
| 0.000 | Start/Finish (rettilineo) | 340 |
| 0.060 | Variante del Rettifilo (chicane) | 95 |
| 0.180 | Curva Biassono (Curva Grande) | 290 |
| 0.300 | Variante della Roggia | 110 |
| 0.420 | Lesmo 1 | 200 |
| 0.480 | Lesmo 2 | 215 |
| 0.660 | Variante Ascari | 130 |
| 0.830 | Parabolica | 230 |
| 0.940 | Rettilineo arrivo | 335 |
| 1.000 | (= 0.000) | 340 |

`physics.js` clamp-segue il target con accelerazione/decelerazione
limitate (`+8 m/s^2` accel, `-25 m/s^2` brake): la `speed` reale non salta,
solo segue il profilo. Risultato: i giri durano 80-95 s a seconda
dell'auto e dello stato gomme/fuel.

> **Nota implementazione (Fase 3, task velocita)**: il pure target-following
> con interpolazione lineare anticipa la frenata (l'auto inizia a rallentare
> appena il target scende, invece di tenere il rettilineo e staccare tardi).
> Lap time misurato del modello base: ~110 s. La finestra 80-95 s qui sopra
> e' ottenibile aggiungendo punti di "hold" sui rettilinei o un lookahead di
> frenata; per la Fase 3 si accetta il modello base, il raffinamento e'
> previsto se la Fase 8 di tuning lo richiede.

### 6.2 Settori

Settori (per gli eventi `sector-completed`):

- **S1**: `[0.000, 0.330)`
- **S2**: `[0.330, 0.660)`
- **S3**: `[0.660, 1.000)`

Quando `trackPos` attraversa una soglia di settore, `Car` emette
`sector-completed` con `sectorTime`.

### 6.3 Pit lane

Pit ingresso a `trackPos = 0.95`, uscita a `trackPos = 0.04` del giro
successivo. Mentre `state == PIT`:

- Velocita' clampata a 80 km/h fino al box.
- All'arrivo al box (`trackPos == pitBox`), `speed = 0` per
  `pitDuration` secondi (default 2.4 s); evento `pit-stop` con
  `{duration, tyreCompound, fuelAdded}`.
- Reset di `tireTemp` (90°C) e ricarica `fuel += fuelAdded`.
- All'uscita pit, FSM torna a `RUNNING`.

---

## 7. Macchina a stati finiti (FSM)

```
                +--------+   race-start    +---------+
   bootstrap -->| INIT   |---------------->| RUNNING |---------+
                +--------+                 +---------+         |
                                            |  ^               |
                                fuel<thr OR |  | pit-exit      |
                                 lap%pitInt |  |               |
                                            v  |               |
                                          +-----+              |
                                          | PIT |              |
                                          +-----+              |
                                            |                  |
                                  pit-failure (rare)           |
                                            v                  |
                +---------+  diagnose>5s  +-------+           lap >= totalLaps
                | RETIRED |<--------------| FAULT |<------------+
                +---------+               +-------+      tireTemp>180 (sus)
                    ^                                    OR engine fault
                    |                                          |
        manual/crash|                                          |
                    |                                          |
                    +------------------------------------------+

                           +-----------+
                           | FINISHED  |
                           +-----------+
                              ^
                              | lap >= totalLaps AND CHECKERED active
                              |
                       (entrabile da RUNNING o PIT)
```

### 7.1 Tabella delle transizioni

| Da | A | Condizione | `reason` |
|---|---|---|---|
| INIT | RUNNING | flag GREEN attiva (race-start) | `race-start` |
| RUNNING | PIT | `fuel < FUEL_PIT_THRESHOLD` (default 8 kg) | `low-fuel` |
| RUNNING | PIT | giro pianificato in `pitStrategy` (es. lap 18) | `scheduled-pit` |
| PIT | RUNNING | timer pit elapsed (durata sorteggiata 2.0-3.5 s) | `pit-out` |
| RUNNING | FAULT | `max(tireTemp) > 180°C` per 3 tick consecutivi | `tire-overheat` |
| RUNNING | FAULT | random engine failure (probabilita' < 1e-4 per tick) | `engine-failure` |
| FAULT | RETIRED | timer diagnostico > 5 s e fault non riparabile | `unrecoverable` |
| RUNNING/PIT | FINISHED | `lap >= TOTAL_LAPS` e flag CHECKERED ricevuta | `race-end` |
| any (manuale) | RETIRED | comando esterno (Fase 4) | `manual-retire` |

Le condizioni numeriche vengono lette da `config/default.js`. Le
transizioni emettono **sempre** un evento `state-change` e un payload
`state` retained.

### 7.2 Comportamento per stato

| Stato | speed | fuel/tire dyn. | Telemetria |
|---|---|---|---|
| INIT | 0 | nessuna | si (state=INIT) |
| RUNNING | segue Monza | normale | si |
| PIT | 80→0→80 km/h | reset al pit-stop | si |
| FAULT | decelera a 0 | tire si raffredda | si (1 Hz, ridotta) |
| RETIRED | 0 | nessuna | no — solo state retained |
| FINISHED | decelera al boxes | nessuna | si fino a fermarsi |

In **RETIRED** il simulator smette di pubblicare `telemetry`: l'ultimo
`state` retained e' sufficiente per la dashboard.

---

## 8. Coupling con Race Control

### 8.1 Flow

`race-control/subscriber.js`:

1. Si sottoscrive a `f1/simulation/{raceId}/race-control/flags` con QoS 1
   (allineato alla policy di Phase 1).
2. Mantiene una variabile `activeFlag` con l'ultima flag con `active=true`,
   esposta come `getActiveFlag()`.
3. L'`Orchestrator` legge `activeFlag` a ogni tick e la mette in `ctx`.

### 8.2 Effetti per flag

| Flag | Effetto sulla `Car.tick()` |
|---|---|
| `GREEN` | Nessun modificatore; targetSpeed = Monza standard. |
| `YELLOW` (sector) | Se `currentSector == flag.sector`: `targetSpeed *= 0.6`, `drs = false`. |
| `RED` | `targetSpeed = 0`, gradual brake; nessun overtake; classifica congelata. |
| `SC` | `targetSpeed = min(140, distance-to-leader-policy)`; auto si compattano. |
| `VSC` | `targetSpeed = min(120, targetSpeed)`; lap time forzato a delta fisso. |
| `CHECKERED` | Nessun effetto immediato; abilita transizione → FINISHED. |

L'implementazione concreta (in particolare SC con compattamento) sara'
dettagliata in **Fase 4 — Race Control**. La Fase 3 prepara solo i ganci
nell'API di `Car` e nell'`Orchestrator`.

---

## 9. Configurazione

### 9.1 Sorgenti

In ordine di priorita' (alta a bassa):

1. **Variabili d'ambiente** (override docker-compose):
   - `MQTT_BROKER` (es. `mqtt://mosquitto:1883`)
   - `RACE_ID` (default `1`)
   - `TICK_MS` (default `250`)
   - `TOTAL_LAPS` (default `15`, abbastanza corta per i test)
   - `SEED` (intero, abilita PRNG deterministico)
   - `LOG_LEVEL` (`debug` | `info` | `warn` | `error`, default `info`)
2. **`config/default.js`**: soglie fisiche, durate pit, probabilita'
   guasto.
3. **`config/roster.json`**: lista delle auto. Stesso identico elenco del
   seed (Fase 2) per coerenza.

### 9.2 Esempio `roster.json`

```json
[
  { "teamId": "ferrari",  "carId": 16, "driver": "C. Leclerc"   },
  { "teamId": "ferrari",  "carId": 55, "driver": "C. Sainz"     },
  { "teamId": "mercedes", "carId": 44, "driver": "L. Hamilton"  },
  { "teamId": "mercedes", "carId": 63, "driver": "G. Russell"   },
  { "teamId": "redbull",  "carId": 1,  "driver": "M. Verstappen"},
  { "teamId": "redbull",  "carId": 11, "driver": "S. Perez"     },
  { "teamId": "mclaren",  "carId": 4,  "driver": "L. Norris"    },
  { "teamId": "mclaren",  "carId": 81, "driver": "O. Piastri"   },
  { "teamId": "alpine",   "carId": 10, "driver": "P. Gasly"     },
  { "teamId": "alpine",   "carId": 31, "driver": "E. Ocon"      }
]
```

Il campo `driver` non finisce nel payload MQTT (lo schema non lo prevede)
ma e' utile per i log e la dashboard.

---

## 10. Determinismo, randomness, testabilita'

### 10.1 PRNG

`util/prng.js` espone una factory:

```js
const rand = createPrng(seed);   // -> () => float in [0,1)
```

Implementazione `xorshift32`. Se `SEED` env e' assente, si usa
`Math.random` (non deterministico). Ogni `Car` riceve la propria istanza
seedata con `seed ^ carId`, in modo che gara intera sia riproducibile da
un singolo seed.

### 10.2 Test unitari proposti

| Modulo | Cosa testare |
|---|---|
| `track/monza.js` | `targetSpeed(0)` ≈ 340; monotonia per settori ed estremi. |
| `car/physics.js` | `dt = 1s` con target 100 → speed +<= 8; brake limit. |
| `car/tire-fuel.js` | fuel decrementa monotonamente; tireTemp sale con speed. |
| `car/fsm.js` | matrice transizioni: input sintetici → stato atteso + reason. |
| `car/car.js` | tick produce telemetria valida vs. JSON Schema (Ajv). |
| `orchestrator` | con N=2 auto e 5 tick: 5*2 telemetry pubblicati. |

`Orchestrator` riceve `MqttPublisher` per dependency injection: nei test
si passa un mock che memorizza in un array.

### 10.3 Validazione schema

Lo schema [`schemas/telemetry.schema.json`](../schemas/telemetry.schema.json)
e' la **single source of truth**. In modalita' `LOG_LEVEL=debug` il
publisher valida ogni payload con Ajv prima di inviarlo, e logga la prima
violazione (se presente). In produzione la validazione e' off (overhead).

---

## 11. Budget di performance

Target: 10 auto × 4 Hz = 40 messaggi telemetry/s + sporadici state/event.

| Voce | Stima |
|---|---|
| `Car.tick()` | < 0.5 ms (solo aritmetica) |
| 10 × tick | < 5 ms |
| JSON.stringify telemetry | < 0.1 ms × 10 = 1 ms |
| `mqtt.publish` (QoS 0) | < 0.5 ms × 10 = 5 ms |
| **Totale per tick** | **~10-15 ms su 250 disponibili** |

Margine ampio. Il collo di bottiglia atteso sara' Node-RED nella Fase 5,
non il simulator.

---

## 12. Lifecycle e gestione errori

### 12.1 Avvio

1. `index.js` carica `default.js` + `roster.json` + override env.
2. Crea `MqttPublisher`, `RaceControlSubscriber`, `Track`, `Cars`,
   `Orchestrator`.
3. `await publisher.connect()` (aspetta `connect`, fallisce dopo 10 s).
4. `await subscriber.start()` (subscribe `flags`).
5. `orchestrator.start()` → primo tick.

### 12.2 Errori

| Evento | Reazione |
|---|---|
| `mqtt error` ricorrente | retry esponenziale fino a 30 s, poi `process.exit(1)`. |
| Disconnessione | `mqtt.js` riconnette automaticamente; in stato disconnesso il publisher mette in **drop** la telemetria (QoS 0 best-effort) e in **buffer** stati/eventi (QoS 1, max 100). |
| Eccezione in `Car.tick()` | log error, FSM forzata a `FAULT` con `reason="internal-error"`, gara prosegue. |
| `SIGTERM` / `SIGINT` | shutdown ordinato (vedi §4.3). |

### 12.3 Health

Niente endpoint HTTP (sarebbe un secondo protocollo non richiesto, vedi
nota progetto su solo-MQTT). Il segnale di "vivo" e' la telemetria stessa
sul broker; un consumer puo' vedere `f1/simulation/{raceId}/teams/+/cars/+/telemetry`
e dichiarare KO se non arrivano messaggi per > 2 s.

---

## 13. Dipendenze esterne

| Pacchetto | Scopo | Note |
|---|---|---|
| `mqtt` | client MQTT | gia' presente. |
| `ajv` (devDependency) | validazione schemi nei test e in `LOG_LEVEL=debug` | nuova dep, opzionale a runtime. |

Niente altro: nessun ORM, nessun framework, nessun lib di physics. Tutto
in JavaScript "vanilla" coerentemente con la scala del progetto.

---

## 14. Open points (da chiudere nelle sotto-task della Fase 3)

- [x] **Pit strategy**: implementata lap-based in `config/roster.json`.
  Verstappen lap 7, Ferrari 16 lap 8, Perez lap 8, Sainz/McLaren lap 9,
  Mercedes lap 10, Alpine lap 11. Strategia adattiva rinviata.
- [x] **Coefficiente degrado gomme**: `wearPerLap = 0.03` in
  `config/default.js`. `wearFactor = 1 + lap * 0.03` → a lap 15 vale
  1.45 (+45% riscaldamento). Percepibile: la temperatura sale sensibilmente
  nella seconda meta' di gara.
- [x] **Probabilita' guasto**: `engineFailureProbPerTick = 1e-4` in
  `config/default.js`. Con 10 auto × ~2400 tick (15 giri a 4 Hz) →
  E[ritiri] ≈ 2.4, mediana ~1-2 per gara. Bilanciato.
- [ ] **Compattamento Safety Car**: definire algoritmo (gap target 0.5 s)
  in collaborazione con la Fase 4.

