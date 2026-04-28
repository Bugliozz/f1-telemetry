// Test Race Control — flag-state, triggers, race-controller.
//
// Verifica:
//   1. flag-state: transizioni ammesse/negate, stato terminale
//   2. triggers: tutti i trigger automatici
//   3. race-controller: integrazione tick + forceFlag
//
// Eseguire con: node scripts/test-race-control.js

const assert = require('assert');

// --- 1. Flag State ---

const {
  FLAGS,
  initialFlagState,
  changeFlag,
  canTransitionFlag,
  isTerminalFlag,
  isValidFlag,
} = require('../src/race-control/flag-state');

function testFlagState() {
  console.log('\n=== Flag State ===');

  // Initial state
  const init = initialFlagState();
  assert.strictEqual(init.flag, 'GREEN');
  assert.strictEqual(init.sector, null);
  assert.strictEqual(init.previousFlag, null);
  console.log('  ✅ initialFlagState()');

  // Valid transitions
  assert.ok(canTransitionFlag('GREEN', 'YELLOW'));
  assert.ok(canTransitionFlag('GREEN', 'SC'));
  assert.ok(canTransitionFlag('GREEN', 'VSC'));
  assert.ok(canTransitionFlag('GREEN', 'RED'));
  assert.ok(canTransitionFlag('GREEN', 'CHECKERED'));
  assert.ok(canTransitionFlag('YELLOW', 'GREEN'));
  assert.ok(canTransitionFlag('YELLOW', 'SC'));
  assert.ok(canTransitionFlag('YELLOW', 'CHECKERED'));
  assert.ok(canTransitionFlag('SC', 'GREEN'));
  assert.ok(canTransitionFlag('SC', 'RED'));
  assert.ok(canTransitionFlag('SC', 'CHECKERED'));
  assert.ok(canTransitionFlag('VSC', 'GREEN'));
  assert.ok(canTransitionFlag('VSC', 'CHECKERED'));
  assert.ok(canTransitionFlag('RED', 'GREEN'));
  assert.ok(canTransitionFlag('RED', 'CHECKERED'));
  console.log('  ✅ canTransitionFlag() — valid transitions');

  // Invalid transitions
  assert.ok(!canTransitionFlag('CHECKERED', 'GREEN'));
  assert.ok(!canTransitionFlag('CHECKERED', 'RED'));
  assert.ok(!canTransitionFlag('GREEN', 'GREEN'));
  assert.ok(!canTransitionFlag('RED', 'YELLOW'));
  assert.ok(!canTransitionFlag('SC', 'VSC'));
  console.log('  ✅ canTransitionFlag() — invalid transitions');

  // CHECKERED is terminal
  assert.ok(isTerminalFlag('CHECKERED'));
  assert.ok(!isTerminalFlag('GREEN'));
  assert.ok(!isTerminalFlag('RED'));
  console.log('  ✅ isTerminalFlag()');

  // changeFlag — valid
  const result1 = changeFlag(init, 'YELLOW', { sector: 2, reason: 'debris' });
  assert.ok(result1.changed);
  assert.strictEqual(result1.flag, 'YELLOW');
  assert.strictEqual(result1.sector, 2);
  assert.strictEqual(result1.previousFlag, 'GREEN');
  assert.strictEqual(result1.reason, 'debris');
  console.log('  ✅ changeFlag() GREEN → YELLOW');

  // changeFlag — sector only for YELLOW
  const result2 = changeFlag(init, 'SC', { sector: 1, reason: 'test' });
  assert.ok(result2.changed);
  assert.strictEqual(result2.sector, null); // SC e' globale
  console.log('  ✅ changeFlag() SC sector ignored (globale)');

  // changeFlag — invalid
  const result3 = changeFlag(init, 'GREEN');
  assert.ok(!result3.changed); // same flag, no-op
  console.log('  ✅ changeFlag() same flag → no-op');

  // changeFlag — CHECKERED is absorbing
  const checkered = changeFlag(init, 'CHECKERED', { reason: 'race-end' });
  assert.ok(checkered.changed);
  const afterCheckered = changeFlag(checkered, 'GREEN');
  assert.ok(!afterCheckered.changed);
  console.log('  ✅ changeFlag() CHECKERED is absorbing');

  console.log('  ✅ Flag State: tutti i test passati');
}

// --- 2. Triggers ---

const {
  initialTriggerTracker,
  evaluateTriggers,
  countCarsInState,
  findNewRetirements,
} = require('../src/race-control/triggers');
const { STATES } = require('../src/car/fsm');

function makeCar(carId, state, sector) {
  return {
    carId,
    fsm: { state },
    currentSector: sector || 1,
  };
}

function testTriggers() {
  console.log('\n=== Triggers ===');

  const green = initialFlagState();

  // CHECKERED trigger
  {
    const cars = [makeCar(1, STATES.RUNNING)];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(green, cars, { leaderLap: 15, totalLaps: 15, nowS: 100, rng: Math.random }, tracker);
    assert.strictEqual(r.action.flag, 'CHECKERED');
    assert.strictEqual(r.action.reason, 'leader-finished');
    console.log('  ✅ CHECKERED trigger when leader finishes');
  }

  // No trigger when leader hasn't finished
  {
    const cars = [makeCar(1, STATES.RUNNING)];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(green, cars, { leaderLap: 10, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action, null);
    console.log('  ✅ No trigger in normal conditions');
  }

  // RED FLAG — mass incident
  {
    const cars = [
      makeCar(1, STATES.FAULT),
      makeCar(2, STATES.RETIRED),
      makeCar(3, STATES.FAULT),
      makeCar(4, STATES.RUNNING),
    ];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(green, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action.flag, 'RED');
    assert.ok(r.action.reason.includes('mass-incident'));
    console.log('  ✅ RED FLAG on mass incident (3+ FAULT/RETIRED)');
  }

  // SC trigger — new retirement with probability match
  {
    const cars = [
      makeCar(1, STATES.RETIRED),
      makeCar(2, STATES.RUNNING),
    ];
    const tracker = initialTriggerTracker();
    // rng returns 0.1 < 0.4 threshold → SC triggered
    const r = evaluateTriggers(green, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.1 }, tracker);
    assert.strictEqual(r.action.flag, 'SC');
    assert.ok(r.action.reason.includes('debris-retirement'));
    console.log('  ✅ SC trigger on retirement (probability hit)');
  }

  // SC NOT triggered — retirement but probability miss
  {
    const cars = [
      makeCar(1, STATES.RETIRED),
      makeCar(2, STATES.RUNNING),
    ];
    const tracker = initialTriggerTracker();
    // rng returns 0.9 > 0.4 threshold → SC NOT triggered
    const r = evaluateTriggers(green, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.9 }, tracker);
    // Might get YELLOW instead (single fault = 0 faults here, just retired)
    // No FAULT cars, so should be null
    assert.strictEqual(r.action, null);
    console.log('  ✅ SC NOT triggered when probability miss');
  }

  // VSC trigger — multiple faults
  {
    const cars = [
      makeCar(1, STATES.FAULT),
      makeCar(2, STATES.FAULT),
      makeCar(3, STATES.RUNNING),
    ];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(green, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action.flag, 'VSC');
    assert.ok(r.action.reason.includes('multi-fault'));
    console.log('  ✅ VSC trigger on multiple faults');
  }

  // YELLOW trigger — single fault
  {
    const cars = [
      makeCar(1, STATES.FAULT, 2),
      makeCar(2, STATES.RUNNING),
    ];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(green, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action.flag, 'YELLOW');
    assert.strictEqual(r.action.sector, 2);
    console.log('  ✅ YELLOW trigger on single fault (sector local)');
  }

  // Clearance — GREEN after SC min duration and no faults
  {
    const scState = changeFlag(green, 'SC', { reason: 'test', nowS: 10 });
    const cars = [makeCar(1, STATES.RUNNING), makeCar(2, STATES.RUNNING)];
    const tracker = initialTriggerTracker();
    // nowS = 50, SC activated at 10 → elapsed = 40 > 30 min
    const r = evaluateTriggers(scState, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action.flag, 'GREEN');
    assert.ok(r.action.reason.includes('clearance'));
    console.log('  ✅ Clearance GREEN after SC min duration');
  }

  // No clearance — SC but faults still present
  {
    const scState = changeFlag(green, 'SC', { reason: 'test', nowS: 10 });
    const cars = [makeCar(1, STATES.FAULT), makeCar(2, STATES.RUNNING)];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(scState, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action, null); // Still FAULT, can't clear
    console.log('  ✅ No clearance while faults present');
  }

  // No clearance — SC but min duration not elapsed
  {
    const scState = changeFlag(green, 'SC', { reason: 'test', nowS: 45 });
    const cars = [makeCar(1, STATES.RUNNING)];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(scState, cars, { leaderLap: 5, totalLaps: 15, nowS: 50, rng: () => 0.99 }, tracker);
    assert.strictEqual(r.action, null); // Only 5s elapsed, need 30
    console.log('  ✅ No clearance before SC min duration');
  }

  // countCarsInState
  {
    const cars = [
      makeCar(1, STATES.RUNNING),
      makeCar(2, STATES.FAULT),
      makeCar(3, STATES.RUNNING),
      makeCar(4, STATES.RETIRED),
    ];
    assert.strictEqual(countCarsInState(cars, STATES.RUNNING), 2);
    assert.strictEqual(countCarsInState(cars, STATES.FAULT), 1);
    assert.strictEqual(countCarsInState(cars, STATES.RETIRED), 1);
    console.log('  ✅ countCarsInState()');
  }

  // findNewRetirements
  {
    const cars = [
      makeCar(1, STATES.RETIRED),
      makeCar(2, STATES.RUNNING),
      makeCar(3, STATES.RETIRED),
    ];
    const newR = findNewRetirements(cars, [1]); // car 1 already processed
    assert.deepStrictEqual(newR, [3]);
    console.log('  ✅ findNewRetirements()');
  }

  // No triggers on terminal flag (CHECKERED)
  {
    const checkeredState = changeFlag(green, 'CHECKERED', { reason: 'done' });
    const cars = [makeCar(1, STATES.FAULT), makeCar(2, STATES.FAULT), makeCar(3, STATES.FAULT)];
    const tracker = initialTriggerTracker();
    const r = evaluateTriggers(checkeredState, cars, { leaderLap: 15, totalLaps: 15, nowS: 100, rng: () => 0.01 }, tracker);
    assert.strictEqual(r.action, null);
    console.log('  ✅ No triggers on CHECKERED (terminal)');
  }

  console.log('  ✅ Triggers: tutti i test passati');
}

// --- 3. Race Controller ---

const RaceController = require('../src/race-control/race-controller');

function testRaceController() {
  console.log('\n=== Race Controller ===');

  // Init
  const rc = new RaceController({ raceId: 1, rng: () => 0.99 });
  assert.strictEqual(rc.activeFlag, 'GREEN');
  assert.strictEqual(rc.activeSector, null);
  console.log('  ✅ RaceController init');

  // forceFlag — valid
  const r1 = rc.forceFlag('YELLOW', { sector: 1, reason: 'test-yellow', nowS: 5 });
  assert.ok(r1.flagChanged);
  assert.strictEqual(r1.flagPayload.flag, 'YELLOW');
  assert.strictEqual(r1.flagPayload.active, true);
  assert.strictEqual(r1.flagPayload.sector, 1);
  assert.strictEqual(r1.flagPayload.raceId, 1);
  assert.strictEqual(rc.activeFlag, 'YELLOW');
  console.log('  ✅ forceFlag() GREEN → YELLOW');

  // forceFlag — invalid
  const r2 = rc.forceFlag('YELLOW');
  assert.ok(!r2.flagChanged); // YELLOW → YELLOW not a transition
  assert.strictEqual(rc.activeFlag, 'YELLOW');
  console.log('  ✅ forceFlag() invalid transition rejected');

  // forceFlag — back to GREEN
  const r3 = rc.forceFlag('GREEN', { nowS: 20 });
  assert.ok(r3.flagChanged);
  assert.strictEqual(rc.activeFlag, 'GREEN');
  console.log('  ✅ forceFlag() YELLOW → GREEN');

  // buildFlagContext
  const ctx = rc.buildFlagContext();
  assert.strictEqual(ctx.flag, 'GREEN');
  assert.strictEqual(ctx.sector, null);
  console.log('  ✅ buildFlagContext()');

  // History
  assert.strictEqual(rc.history.length, 2); // YELLOW, GREEN
  assert.strictEqual(rc.history[0].from, 'GREEN');
  assert.strictEqual(rc.history[0].to, 'YELLOW');
  assert.strictEqual(rc.history[1].from, 'YELLOW');
  assert.strictEqual(rc.history[1].to, 'GREEN');
  console.log('  ✅ history tracking');

  // tick() — automatic CHECKERED
  {
    const rc2 = new RaceController({ raceId: 1, rng: () => 0.99 });
    const cars = [makeCar(1, STATES.RUNNING), makeCar(2, STATES.RUNNING)];
    const raceState = { leaderLap: 15, totalLaps: 15, nowS: 100, timestamp: '2026-01-01T00:00:00Z' };
    const result = rc2.tick(cars, raceState);
    assert.ok(result.flagChanged);
    assert.strictEqual(result.flagPayload.flag, 'CHECKERED');
    assert.strictEqual(rc2.activeFlag, 'CHECKERED');
    console.log('  ✅ tick() auto CHECKERED on leader finish');
  }

  // tick() — automatic CHECKERED from active race-control flag
  {
    const rc2b = new RaceController({ raceId: 1, rng: () => 0.99 });
    rc2b.forceFlag('SC', { reason: 'test-sc', nowS: 10 });
    const cars = [makeCar(1, STATES.RUNNING), makeCar(2, STATES.RUNNING)];
    const raceState = { leaderLap: 15, totalLaps: 15, nowS: 100, timestamp: '2026-01-01T00:00:00Z' };
    const result = rc2b.tick(cars, raceState);
    assert.ok(result.flagChanged);
    assert.strictEqual(result.flagPayload.flag, 'CHECKERED');
    assert.strictEqual(rc2b.activeFlag, 'CHECKERED');
    console.log('  ✅ tick() auto CHECKERED also from SC');
  }

  // forceFlag() without nowS uses last simulated time, avoiding immediate clearance
  {
    const rc2c = new RaceController({ raceId: 1, rng: () => 0.99 });
    const cars = [makeCar(1, STATES.RUNNING), makeCar(2, STATES.RUNNING)];
    rc2c.tick(cars, { leaderLap: 1, totalLaps: 15, nowS: 50, timestamp: '2026-01-01T00:00:00Z' });
    rc2c.forceFlag('SC', { reason: 'manual-sc' });
    const result = rc2c.tick(cars, { leaderLap: 1, totalLaps: 15, nowS: 51, timestamp: '2026-01-01T00:00:01Z' });
    assert.ok(!result.flagChanged);
    assert.strictEqual(rc2c.activeFlag, 'SC');
    console.log('  ✅ forceFlag() without nowS does not clear immediately');
  }

  // tick() — no action in normal conditions
  {
    const rc3 = new RaceController({ raceId: 1, rng: () => 0.99 });
    const cars = [makeCar(1, STATES.RUNNING), makeCar(2, STATES.RUNNING)];
    const raceState = { leaderLap: 5, totalLaps: 15, nowS: 50, timestamp: '2026-01-01T00:00:00Z' };
    const result = rc3.tick(cars, raceState);
    assert.ok(!result.flagChanged);
    assert.strictEqual(result.flagPayload, null);
    console.log('  ✅ tick() no action in normal conditions');
  }

  // tick() — auto RED FLAG on mass incident
  {
    const rc4 = new RaceController({ raceId: 1, rng: () => 0.99 });
    const cars = [
      makeCar(1, STATES.FAULT),
      makeCar(2, STATES.RETIRED),
      makeCar(3, STATES.FAULT),
      makeCar(4, STATES.RUNNING),
    ];
    const raceState = { leaderLap: 5, totalLaps: 15, nowS: 50, timestamp: '2026-01-01T00:00:00Z' };
    const result = rc4.tick(cars, raceState);
    assert.ok(result.flagChanged);
    assert.strictEqual(result.flagPayload.flag, 'RED');
    console.log('  ✅ tick() auto RED FLAG on mass incident');
  }

  console.log('  ✅ Race Controller: tutti i test passati');
}

// --- Run ---

try {
  testFlagState();
  testTriggers();
  testRaceController();
  console.log('\n🏁 Tutti i test Race Control passati! ✅\n');
  process.exit(0);
} catch (err) {
  console.error('\n❌ Test fallito:', err.message);
  console.error(err.stack);
  process.exit(1);
}
