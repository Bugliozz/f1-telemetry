// Verifica end-to-end Fase 4 — pit sensor-based (low-fuel).
//
// Esegue una gara completa da 5 giri con tutte le 10 auto in modalità
// headless (nessun broker MQTT reale) e controlla:
//
//   1. Ogni auto esegue almeno una sequenza pit-entry → pit-stop.
//   2. Il trigger di ogni pit inizia con "low-fuel" (nessun scheduled-pit).
//   3. I pit sono scaglionati su almeno 2 giri distinti (effetto jitter).
//   4. Ogni auto raggiunge FINISHED.
//   5. Nessun riferimento a `scheduled-pit` in nessun messaggio.
//   6. `fuelAdded` in ogni pit-stop è un valore reale (>0, <40 kg).
//   7. pit-entry e pit-stop bilanciati (ogni entrata è servita).
//   8. pit-exit ≤ pit-entry (alcune auto finiscono dallo stato PIT via race-end).

'use strict';

const Orchestrator = require('../src/orchestrator');
const roster = require('../config/roster.json');
const config = require('../config/default');

// ─────────────────────────────────────────────
// Mock publisher: raccoglie tutti i messaggi
// ─────────────────────────────────────────────
class MockPublisher {
  constructor() {
    this.allEvents = [];
    this.allStates = [];
    this.allTelemetry = [];
    this.flags = [];
  }

  publishCarMessages(messages) {
    if (!messages) return;
    if (messages.telemetry) this.allTelemetry.push(messages.telemetry);
    if (messages.state) this.allStates.push(messages.state);
    if (Array.isArray(messages.events)) {
      for (const e of messages.events) this.allEvents.push(e);
    }
  }

  publishFlag(payload) {
    this.flags.push(payload);
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
let passed = 0;
let failed = 0;

function ok(condition, msg) {
  if (condition) {
    console.log(`  ok  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title}`);
}

// ─────────────────────────────────────────────
// Esecuzione gara sincrona con dt deterministico.
//
// `_tick()` usa `clock.nowMs()` (wall time). In un tight loop sincrono,
// rawDtMs ≈ 0 → clampato a tickMs*0.5 = 125ms.
// Per forzare dt = tickMs ad ogni tick, retrodatiamo _lastTickMs prima di
// ogni chiamata: rawDtMs = nowMs - (nowMs - tickMs) = tickMs → dt corretto.
// ─────────────────────────────────────────────
function runRace(seed, totalLaps) {
  const publisher = new MockPublisher();

  const raceConfig = {
    ...config,
    seed,
    totalLaps,
    tickMs: 250,
    engineFailureProbPerTick: 0,
    raceId: seed,
    raceControlTriggers: {
      retirementScProbability: 0,
      multiFaultVscThreshold: 999,
      massIncidentThreshold: 999,
      scMinDurationS: 9999,
      vscMinDurationS: 9999,
      yellowMinDurationS: 9999,
    },
  };

  const orch = new Orchestrator({
    roster,
    config: raceConfig,
    publisher,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  orch.start();
  clearInterval(orch._intervalId);
  orch._intervalId = null;

  // 5 giri × ~150 s/giro (con pit) / 0.25 s per tick + ampio margine
  const maxTicks = Math.ceil((totalLaps * 150) / (raceConfig.tickMs / 1000)) + 500;

  for (let i = 0; i < maxTicks; i++) {
    // Forza rawDtMs = tickMs per dt deterministico
    orch._lastTickMs = orch.clock.nowMs() - raceConfig.tickMs;
    orch._tick();
    if (orch._raceFinished) break;
  }

  return { publisher, orch };
}

// ─────────────────────────────────────────────
// SUITE
// ─────────────────────────────────────────────

section('Fase 4 — E2E: gara 5 giri, seed deterministico (20260514)');

const SEED = 20260514;
const TOTAL_LAPS = 5;
const { publisher, orch } = runRace(SEED, TOTAL_LAPS);

// ── 1. La gara si è conclusa
ok(orch._raceFinished, 'la gara si è conclusa (allTerminal → _raceFinished)');

// ── 2. Tutte le auto in stato FINISHED
const carStates = orch.cars.map((c) => ({ carId: c.carId, state: c.fsm.state }));
const allFinished = carStates.every((c) => c.state === 'FINISHED');
ok(
  allFinished,
  `tutte le 10 auto in stato FINISHED (${carStates.map((c) => `#${c.carId}:${c.state}`).join(', ')})`,
);

// ── 3. Nessun riferimento a scheduled-pit in nessun evento
const scheduledPitRefs = publisher.allEvents.filter((e) =>
  (e.type && e.type.includes('scheduled-pit')) ||
  (e.reason && String(e.reason).includes('scheduled-pit')) ||
  (e.details && JSON.stringify(e.details).includes('scheduled-pit'))
);
ok(scheduledPitRefs.length === 0, `nessun evento contiene "scheduled-pit" (trovati: ${scheduledPitRefs.length})`);

const scheduledPitInStates = publisher.allStates.filter((s) =>
  s.reason && String(s.reason).includes('scheduled-pit')
);
ok(scheduledPitInStates.length === 0, `nessuno state payload contiene "scheduled-pit" (trovati: ${scheduledPitInStates.length})`);

// ── 4. Ogni auto ha fatto almeno un pit-entry e almeno un pit-stop
const pitEntryEvents = publisher.allEvents.filter((e) => e.type === 'pit-entry');
const pitStopEvents = publisher.allEvents.filter((e) => e.type === 'pit-stop');
const pitExitEvents = publisher.allEvents.filter((e) => e.type === 'pit-exit');

const carIdsWithEntry = new Set(pitEntryEvents.map((e) => e.carId));
const carIdsWithStop = new Set(pitStopEvents.map((e) => e.carId));
const carIdsWithExit = new Set(pitExitEvents.map((e) => e.carId));

ok(carIdsWithEntry.size === 10, `tutte le 10 auto hanno almeno un pit-entry (trovate: ${carIdsWithEntry.size})`);
ok(carIdsWithStop.size === 10, `tutte le 10 auto hanno almeno un pit-stop (trovate: ${carIdsWithStop.size})`);
ok(
  pitEntryEvents.length === pitStopEvents.length,
  `pit-entry e pit-stop bilanciati (${pitEntryEvents.length} entry, ${pitStopEvents.length} stop)`,
);
ok(
  pitExitEvents.length <= pitEntryEvents.length,
  `pit-exit (${pitExitEvents.length}) ≤ pit-entry (${pitEntryEvents.length}) — alcune auto finiscono da PIT via race-end`,
);

// ── 5. Il trigger di pit è sempre low-fuel (reason inizia con "low-fuel")
const pitStateChanges = publisher.allStates.filter(
  (s) => s.state === 'PIT' && s.previousState === 'RUNNING'
);
const allLowFuel = pitStateChanges.every(
  (s) => typeof s.reason === 'string' && s.reason.startsWith('low-fuel')
);
ok(
  allLowFuel && pitStateChanges.length === pitEntryEvents.length,
  `tutti gli ingressi in PIT hanno reason che inizia con "low-fuel" (trovati ${pitStateChanges.length})`,
);

// ── 6. I pit sono scaglionati su almeno 2 giri distinti
const pitLapsByEvent = pitEntryEvents.map((e) => e.details && e.details.lap);
const uniquePitLaps = [...new Set(pitLapsByEvent.filter((l) => l != null))];
ok(
  uniquePitLaps.length >= 2,
  `pit scaglionati su ≥2 giri distinti — giri di pit: [${[...uniquePitLaps].sort((a, b) => a - b).join(', ')}]`,
);

// Distribuzione pit per giro (informativa)
const lapBuckets = {};
for (const lap of pitLapsByEvent) {
  if (lap != null) lapBuckets[lap] = (lapBuckets[lap] || 0) + 1;
}
console.log(`\n  Distribuzione pit per giro: ${JSON.stringify(lapBuckets)}`);
const secondStopCars = pitEntryEvents.length - 10;
if (secondStopCars > 0) {
  console.log(`  (${secondStopCars} auto con carburante iniziale basso fanno 2 soste — fisicamente corretto)`);
}

// ── 7. Per ogni auto: il primo pit-exit è in un giro successivo al primo pit-entry
for (const car of orch.cars) {
  const firstEntry = pitEntryEvents.find((e) => e.carId === car.carId);
  const firstExit = pitExitEvents.find((e) => e.carId === car.carId);
  if (firstEntry && firstExit) {
    const entryLap = firstEntry.details && firstEntry.details.lap;
    const exitLap = firstExit.details && firstExit.details.lap;
    ok(
      typeof exitLap === 'number' && typeof entryLap === 'number' && exitLap > entryLap,
      `car #${car.carId}: pit-exit (L${exitLap}) dopo pit-entry (L${entryLap})`,
    );
  } else if (firstEntry && !firstExit) {
    // Auto che ha fatto la seconda sosta a fine gara e finito via race-end da PIT:
    // non ha pit-exit ma ha sicuramente un pit-stop
    const firstStop = pitStopEvents.find((e) => e.carId === car.carId);
    ok(
      firstStop != null,
      `car #${car.carId}: nessun pit-exit (finita via race-end da PIT) ma pit-stop presente`,
    );
  } else {
    ok(false, `car #${car.carId}: pit-entry mancante`);
  }
}

// ── 8. fuelAdded in ogni pit-stop è un valore reale (>0, <40 kg)
const fuelAddedValues = pitStopEvents.map((e) => e.details && e.details.fuelAdded);
const fuelAddedOk = fuelAddedValues.every((v) => typeof v === 'number' && v > 0 && v < 40);
ok(
  fuelAddedOk,
  `fuelAdded in tutti i pit-stop è reale >0 e <40 kg — valori: [${fuelAddedValues.map((v) => v != null ? v.toFixed(1) : 'null').join(', ')}]`,
);

// ─────────────────────────────────────────────
// RISULTATO
// ─────────────────────────────────────────────
console.log(`\n── Risultato`);
if (failed === 0) {
  console.log(`\n  ✅ Fase 4 verificata: ${passed} test passati, 0 falliti.\n`);
  process.exit(0);
} else {
  console.log(`\n  ❌ ${failed} test falliti su ${passed + failed}.\n`);
  process.exit(1);
}
