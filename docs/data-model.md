# Data Model - F1 Telemetry

Documento di riferimento per la **Fase 2** del piano di implementazione.
Definisce gli **schemi JSON** dei payload MQTT e la mappatura sulle
**collection MongoDB** (con indici e validator).

> Lo schema MQTT illustrativo della Fase 1 ([mqtt-topics.md](mqtt-topics.md))
> viene qui formalizzato. Le definizioni JSON Schema vivono nella cartella
> [`/schemas`](../schemas/) e sono utilizzabili da qualunque validator
> esterno (Ajv, jsonschema, ...). I validator MongoDB equivalenti sono
> codificati in [`mongo/init/01-init.js`](../mongo/init/01-init.js)
> usando il dialetto `$jsonSchema` (basato su Draft-04 con `bsonType`).

---

## 1. Mappatura topic <-> collection

| Topic MQTT | Collection MongoDB | Pattern di scrittura | Schema |
|---|---|---|---|
| `f1/.../cars/{carId}/telemetry` | `telemetry` | insert (append) | [telemetry.schema.json](../schemas/telemetry.schema.json) |
| `f1/.../cars/{carId}/state` | `states` | upsert su `(raceId, carId)` | [state.schema.json](../schemas/state.schema.json) |
| `f1/.../cars/{carId}/events` | `events` | insert (append) | [event.schema.json](../schemas/event.schema.json) |
| `f1/.../race-control/flags` | `race_control` | insert (append) | [flag.schema.json](../schemas/flag.schema.json) |
| `f1/.../race-control/classification` | `classifications` | upsert su `raceId` | [classification.schema.json](../schemas/classification.schema.json) |

I dati cumulativi (telemetria, eventi, flag) sono **append-only** per
preservare lo storico necessario all'analisi post-gara. Stato auto e
classifica sono **single-doc** perche' il consumatore tipico (dashboard)
ha bisogno solo dell'ultima versione, gia' garantita dalla `retain` MQTT.

---

## 2. Convenzioni dei tipi

| Concetto | Tipo JSON | Tipo BSON | Note |
|---|---|---|---|
| timestamp | `string` ISO-8601 UTC | `Date` | I consumatori Node-RED convertono con `new Date(payload.timestamp)`. |
| raceId | `integer >= 1` | `int` | |
| teamId | `string` regex `^[a-z][a-z0-9-]{1,31}$` | `string` | Slug minuscolo. |
| carId | `integer 1..99` | `int` | |
| trackPos | `number [0,1]` | `double` | Posizione normalizzata sul giro. |
| stato FSM | `enum` | `string` | `INIT`, `RUNNING`, `PIT`, `FAULT`, `RETIRED`, `FINISHED`. |
| flag | `enum` | `string` | `GREEN`, `YELLOW`, `RED`, `CHECKERED`, `SC`, `VSC`. |

---

## 3. Schemi - panoramica

### 3.1 Telemetria (`telemetry.schema.json`)

Stream continuo a 2-5 Hz per auto. Campi obbligatori:

```
timestamp, raceId, teamId, carId, lap, trackPos,
speed, rpm, gear, throttle, brake, drs, tireTemp, fuel, state
```

Note di design:

- `state` e' **denormalizzato** dentro la telemetria per semplificare le
  query analitiche (es. "tutti i campioni in stato PIT") senza un join
  con la collection `states`.
- `tireTemp` e' un sub-document con i 4 angoli (`fl, fr, rl, rr`).
- `drs` e' booleano: rappresenta il **sensore digitale** richiesto dalla
  consegna ("eterogeneita' analogico/digitale").

Range numerici applicati come bound nel validator:
`speed in [0,400]`, `rpm in [0,16000]`, `fuel in [0,110]`,
`gear in [0,8]`, `throttle/brake/trackPos in [0,1]`.

### 3.2 Stato FSM (`state.schema.json`)

Snapshot pubblicato **on-change** (retained). Contiene lo stato corrente
piu', opzionalmente, lo `previousState` e una `reason` testuale (es.
`tire-overheat`, `low-fuel`, `engine-failure`).

In MongoDB la collection `states` ha indice unique su `(raceId, carId)`:
ogni publish e' in pratica un **upsert** che aggiorna il singolo
documento dell'auto.

### 3.3 Eventi auto (`event.schema.json`)

Eventi discreti pubblicati on-event. La forma di `details` dipende dal
campo `type` ed e' vincolata da regole condizionali (`allOf` con `if/then`
nello schema JSON):

| `type` | Forma di `details` |
|---|---|
| `pit-stop` | `{ duration, tyreCompound?, fuelAdded? }` |
| `lap-completed` | `{ lap, lapTime }` |
| `sector-completed` | `{ sector, sectorTime }` |
| `state-change` | `{ from, to, reason? }` |
| `pit-entry`, `pit-exit`, `fault`, `retirement`, `overtake` | libera (object) |

> Le regole condizionali sono solo nel JSON Schema dei payload MQTT (per
> validazione lato simulator/consumer). Il validator MongoDB controlla
> solo i campi top-level e tollera qualsiasi `details` purche' object,
> per non bloccare l'append in caso di evento non ancora modellato.

### 3.4 Flag race-control (`flag.schema.json`)

Eventi globali di gara. Il `reason` e' opzionale ma utile per il replay
("debris on track", "rain at sector 2"). `sector` distingue le yellow
locali dalle globali (`null` = globale).

In MongoDB ogni cambio flag e' un nuovo documento in `race_control`,
indicizzato per `(raceId, timestamp)` e per `(raceId, flag)`.

### 3.5 Classifica (`classification.schema.json`)

Snapshot calcolato da Node-RED a 1 Hz. `standings` e' un array ordinato
di posizioni; il campo `gap` e' espresso in **secondi rispetto al leader**
e auto doppiate hanno `lap < leaderLap`.

In MongoDB l'unico documento per `raceId` viene aggiornato in upsert.

---

## 4. Indici MongoDB

| Collection | Indice | Motivazione |
|---|---|---|
| `telemetry` | `(raceId, carId, timestamp desc)` | query "ultimi N campioni dell'auto X". |
| `telemetry` | `(raceId, lap)` | aggregazioni per giro. |
| `telemetry` | `(raceId, teamId, carId, lap)` | analisi per team/auto/giro. |
| `telemetry` | `(raceId, carId, lap, timestamp)` | andamento storico fuel/tire per auto e giro. |
| `telemetry` | `(timestamp)` TTL | retention automatica dei campioni ad alta frequenza. |
| `events` | `(raceId, carId, timestamp desc)` | timeline auto. |
| `events` | `(raceId, type, timestamp desc)` | filtro per tipo evento (es. "tutti i pit"). |
| `events` | `(raceId, type, carId, details.lap)` | tempi sul giro dagli eventi `lap-completed`. |
| `states` | `(raceId, carId)` **unique** | upsert dello stato corrente. |
| `classifications` | `(raceId)` **unique** | upsert dello snapshot corrente. |
| `race_control` | `(raceId, timestamp desc)` | timeline flag. |
| `race_control` | `(raceId, flag, timestamp desc)` | filtro per tipo bandiera. |

La retention della telemetria e' configurabile con `TELEMETRY_TTL_SECONDS`
(default: 30 giorni). Gli ambienti gia' inizializzati possono applicare gli
stessi indici con:

```bash
npm run ensure:persistence-indexes
```

---

## 5. Validator MongoDB

Le collection sono create con `$jsonSchema` validator a livello
`moderate` + `error`:

- **moderate**: i documenti gia' presenti che non soddisfano lo schema
  non bloccano gli update successivi (utile in fase di sviluppo).
- **error**: gli **insert** e i nuovi update che violano lo schema sono
  rifiutati (`writeError`).

In Phase 5 (Node-RED) e Phase 6 (persistence layer) gli errori di scrittura
vanno catturati e loggati: un payload non conforme indica un bug nel
simulator o nei flow di parsing, non un problema di runtime.

---

## 6. Esempi di documento MongoDB

I file in [`/schemas`](../schemas/) descrivono il **payload MQTT**. La
trasformazione verso MongoDB e' minima:

1. `timestamp` viene parsato in `Date` BSON.
2. Tutti gli altri campi restano invariati (eventuale `_id` aggiunto da
   MongoDB).

Esempio documento `telemetry`:

```json
{
  "_id": "ObjectId(...)",
  "timestamp": "ISODate(2026-04-27T14:32:10.512Z)",
  "raceId": 1,
  "teamId": "ferrari",
  "carId": 16,
  "lap": 12,
  "trackPos": 0.4731,
  "speed": 287.4,
  "rpm": 11800,
  "gear": 7,
  "throttle": 0.92,
  "brake": 0.0,
  "drs": true,
  "tireTemp": { "fl": 102.1, "fr": 99.8, "rl": 105.3, "rr": 104.7 },
  "fuel": 38.2,
  "state": "RUNNING"
}
```

---

## 7. Seed di esempio

Lo script [`simulator/scripts/seed.js`](../simulator/scripts/seed.js)
popola le collection con dati coerenti (5 team x 2 auto, qualche giro di
telemetria, eventi tipici, una classifica). Usato per verificare
indici, validator e per i test dei flow Node-RED prima della Fase 5.

```bash
node simulator/scripts/seed.js
# oppure, con override URL:
MONGO_URL=mongodb://localhost:27017 node simulator/scripts/seed.js
```

## 8. Query storiche

Il modulo [`simulator/src/persistence/telemetry-store.js`](../simulator/src/persistence/telemetry-store.js)
espone query aggregate per:

- tempi sul giro dagli eventi `lap-completed`;
- andamento fuel/tire dalla telemetria, con bucket temporali configurabili.

Esempio CLI:

```bash
RACE_ID=1 CAR_ID=16 BUCKET_SECONDS=10 npm run query:history
```
