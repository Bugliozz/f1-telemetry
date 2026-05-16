// Verifica end-to-end Fase 4 — pit sensor-based (low-fuel).
//
// Runs a complete 5-lap race with all 10 cars in
// headless (nessun broker MQTT reale) e controlla:
//
//   1. Ogni auto esegue almeno una sequenza pit-entry → pit-stop.
//   2. Il trigger di ogni pit inizia con "low-fuel" (nessun scheduled-pit).
//   3. Pit stops are staggered across at least 2 different laps (jitter effect).
//   4. Ogni auto raggiunge FINISHED.
//   5. Nessun riferimento a `scheduled-pit` in nessun messaggio.
//   6. `fuelAdded` in ogni pit-stop è un valore reale (>0, <40 kg).
//   7. pit-entry e pit-stop bilanciati (ogni entrata è servita).
//   8. pit-exit <= pit-entry (some cars finish from PIT state via race-end).

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
// Synchronous race execution with deterministic dt.
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

  // 5 laps × ~150 s/lap (with pit) / 0.25 s per tick + large margin
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

section('Phase 4 - E2E: 5-lap race, deterministic seed (20260514)');

const SEED = 20260514;
const TOTAL_LAPS = 5;
const { publisher, orch } = runRace(SEED, TOTAL_LAPS);

// -- 1. The race has finished
ok(orch._raceFinished, 'the race has finished (allTerminal -> _raceFinished)');

// -- 2. All cars are in FINISHED state
const carStates = orch.cars.map((c) => ({ carId: c.carId, state: c.fsm.state }));
const allFinished = carStates.every((c) => c.state === 'FINISHED');
ok(
  allFinished,
  `all 10 cars are in FINISHED state (${carStates.map((c) => `#${c.carId}:${c.state}`).join(', ')})`,
);

// -- 3. No reference to scheduled-pit in any event
const scheduledPitRefs = publisher.allEvents.filter((e) =>
  (e.type && e.type.includes('scheduled-pit')) ||
  (e.reason && String(e.reason).includes('scheduled-pit')) ||
  (e.details && JSON.stringify(e.details).includes('scheduled-pit'))
);
ok(scheduledPitRefs.length === 0, `no event contains "scheduled-pit" (found: ${scheduledPitRefs.length})`);

const scheduledPitInStates = publisher.allStates.filter((s) =>
  s.reason && String(s.reason).includes('scheduled-pit')
);
ok(scheduledPitInStates.length === 0, `nessuno state payload contiene "scheduled-pit" (trovati: ${scheduledPitInStates.length})`);

// -- 4. Each car has at least one pit-entry and one pit-stop
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
  `pit-exit (${pitExitEvents.length}) <= pit-entry (${pitEntryEvents.length}) - some cars finish from PIT via race-end`,
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

// -- 6. Pit stops are staggered across at least 2 different laps
const pitLapsByEvent = pitEntryEvents.map((e) => e.details && e.details.lap);
const uniquePitLaps = [...new Set(pitLapsByEvent.filter((l) => l != null))];
ok(
  uniquePitLaps.length >= 2,
  `pit stops staggered across >=2 different laps - pit laps: [${[...uniquePitLaps].sort((a, b) => a - b).join(', ')}]`,
);

// Distribuzione pit per giro (informativa)
const lapBuckets = {};
for (const lap of pitLapsByEvent) {
  if (lap != null) lapBuckets[lap] = (lapBuckets[lap] || 0) + 1;
}
console.log(`\n  Distribuzione pit per giro: ${JSON.stringify(lapBuckets)}`);
const secondStopCars = pitEntryEvents.length - 10;
if (secondStopCars > 0) {
  console.log(`  (${secondStopCars} cars with low initial fuel make 2 stops - physically correct)`);
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
    // Car that made the second stop at race end and finished from PIT via race-end:
    // non ha pit-exit ma ha sicuramente un pit-stop
    const firstStop = pitStopEvents.find((e) => e.carId === car.carId);
    ok(
      firstStop != null,
      `car #${car.carId}: no pit-exit (finished via race-end from PIT) but pit-stop is present`,
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
