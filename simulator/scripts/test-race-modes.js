// Test 5-lap race modes without a real MQTT broker.
//
// Uses real Orchestrator/Car/RaceController with a fake clock and publisher.
// Run with: node scripts/test-race-modes.js

const assert = require('assert');

const baseConfig = require('../config/default');
const roster = require('../config/roster.json');
const Orchestrator = require('../src/orchestrator');
const { SCENARIOS, applyScenario, normalizeScenarioId } = require('../src/scenarios');

const TOTAL_LAPS = 5;
const TICK_MS = 250;

class PublisherSpy {
  constructor() {
    this.flags = [];
    this.telemetry = [];
    this.states = [];
    this.events = [];
  }

  publishFlag(payload) {
    this.flags.push(payload);
  }

  publishCarMessages(messages) {
    if (!messages) return;
    if (messages.telemetry) this.telemetry.push(messages.telemetry);
    if (messages.state) this.states.push(messages.state);
    if (Array.isArray(messages.events)) this.events.push(...messages.events);
  }
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function manualClock(stepMs) {
  let nowMs = 0;
  return {
    advance() {
      nowMs += stepMs;
    },
    nowMs() {
      return nowMs;
    },
    isoNow() {
      return new Date(nowMs).toISOString();
    },
  };
}

function raceConfig(scenarioId, seed) {
  return applyScenario({
    ...baseConfig,
    raceId: 1,
    seed,
    totalLaps: TOTAL_LAPS,
    tickMs: TICK_MS,
    autoStart: false,
    logLevel: 'error',
  }, scenarioId);
}

function runRace(scenarioId, seed, maxTicks = 5000) {
  const config = raceConfig(scenarioId, seed);
  const publisher = new PublisherSpy();
  const orchestrator = new Orchestrator({
    roster,
    config,
    publisher,
    logger: silentLogger(),
  });
  const clock = manualClock(config.tickMs);
  orchestrator.clock = clock;

  let firstFault = null;

  try {
    orchestrator.start();
    if (orchestrator._intervalId) {
      clearInterval(orchestrator._intervalId);
      orchestrator._intervalId = null;
    }

    for (let i = 0; i < maxTicks; i += 1) {
      const eventStart = publisher.events.length;
      clock.advance();
      orchestrator._tick();

      if (!firstFault) {
        const fault = publisher.events.slice(eventStart).find((event) => event.type === 'fault');
        if (fault) {
          const faultCar = orchestrator.cars.find((car) => Number(car.carId) === Number(fault.carId));
          firstFault = {
            carId: fault.carId,
            reason: fault.details && fault.details.reason,
            atS: orchestrator._simulatedTimeS,
            leaderLap: orchestrator._leaderLap,
            carLap: faultCar ? faultCar.lap : null,
          };
        }
      }

      const activeFlag = orchestrator.raceController.activeFlag;
      if (activeFlag === 'RED' || activeFlag === 'CHECKERED' || orchestrator._raceFinished) {
        break;
      }
    }
  } finally {
    if (orchestrator._intervalId) {
      clearInterval(orchestrator._intervalId);
      orchestrator._intervalId = null;
    }
  }

  return {
    config,
    activeFlag: orchestrator.raceController.activeFlag,
    leaderLap: orchestrator._leaderLap,
    simulatedTimeS: orchestrator._simulatedTimeS,
    tickCount: orchestrator._tickCount,
    flags: publisher.flags,
    events: publisher.events,
    firstFault,
  };
}

function countEvents(result, type) {
  return result.events.filter((event) => event.type === type).length;
}

function hasFlag(result, flag) {
  return result.flags.some((entry) => entry.flag === flag);
}

function testScenarioTuning() {
  console.log('\n=== Scenario tuning ===');

  const balanced = raceConfig(SCENARIOS.BALANCED, 1);
  assert.strictEqual(balanced.totalLaps, TOTAL_LAPS);
  assert.strictEqual(balanced.engineFailureProbPerTick, 1e-5);
  assert.strictEqual(balanced.faultGraceS, 60);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(balanced, 'wearPerLap'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(balanced, 'tireServiceLap'), false);
  assert.strictEqual(balanced.tireWearPitThreshold, baseConfig.tireWearPitThreshold);
  assert.strictEqual(balanced.tireWearVariancePct, baseConfig.tireWearVariancePct);
  assert.deepStrictEqual(Object.keys(balanced.tireCompounds).sort(), ['hard', 'medium', 'soft']);
  assert.strictEqual(balanced.tireOverheatThresholdC, 145);
  assert.strictEqual(balanced.tireOverheatTicksRequired, 8);
  assert.strictEqual(balanced.raceControlTriggers.retirementScProbability, 0);
  assert.strictEqual(balanced.raceControlTriggers.multiFaultVscThreshold, 1);
  assert.strictEqual(balanced.raceControlTriggers.massIncidentThreshold, 99);

  const failureLikely = raceConfig(SCENARIOS.RED_FLAG, 1);
  assert.strictEqual(failureLikely.scenario.label, 'Failure likely');
  assert.strictEqual(failureLikely.engineFailureProbPerTick, 0.0012);
  assert.strictEqual(failureLikely.faultGraceS, 300);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(failureLikely, 'wearPerLap'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(failureLikely, 'tireServiceLap'), false);
  assert.strictEqual(failureLikely.tireOverheatThresholdC, 142);
  assert.strictEqual(failureLikely.tireOverheatTicksRequired, 8);
  assert.strictEqual(failureLikely.raceControlTriggers.retirementScProbability, 0);
  assert.strictEqual(failureLikely.raceControlTriggers.multiFaultVscThreshold, 1);
  assert.strictEqual(failureLikely.raceControlTriggers.massIncidentThreshold, 3);

  assert.strictEqual(normalizeScenarioId('checkered'), SCENARIOS.BALANCED);
  console.log('  OK profile values and checkered fallback');
}

function testBalancedSeeds() {
  console.log('\n=== Balanced mode ===');

  const nominal = runRace(SCENARIOS.BALANCED, 1);
  assert.strictEqual(nominal.activeFlag, 'CHECKERED');
  assert.strictEqual(nominal.leaderLap, TOTAL_LAPS);
  assert.ok(!hasFlag(nominal, 'RED'), 'balanced nominal must not red flag');
  console.log('  OK nominal seed reaches checkered');

  const eventful = runRace(SCENARIOS.BALANCED, 4);
  assert.strictEqual(eventful.activeFlag, 'CHECKERED');
  assert.strictEqual(eventful.leaderLap, TOTAL_LAPS);
  assert.ok(!hasFlag(eventful, 'RED'), 'balanced eventful must not red flag');
  assert.ok(
    countEvents(eventful, 'fault') > 0 || hasFlag(eventful, 'VSC'),
    'balanced eventful seed should produce a fault or VSC event',
  );
  console.log('  OK eventful seed stays below red flag');
}

function testFailureLikelySeeds() {
  console.log('\n=== Failure likely mode ===');

  for (const seed of [2, 8, 24]) {
    const result = runRace(SCENARIOS.RED_FLAG, seed);
    assert.strictEqual(result.activeFlag, 'RED', `seed ${seed} should red flag`);
    assert.ok(result.leaderLap === 3 || result.leaderLap === 4,
      `seed ${seed} red flag at leaderLap ${result.leaderLap}`);
    assert.ok(result.firstFault, `seed ${seed} should record first fault`);
    assert.ok(result.firstFault.atS >= result.config.faultGraceS,
      `seed ${seed} first fault before grace: ${result.firstFault.atS}s`);
    assert.ok(result.firstFault.leaderLap >= 3,
      `seed ${seed} first fault too early at leaderLap ${result.firstFault.leaderLap}`);
  }

  console.log('  OK deterministic seeds fail after grace window');
}

function testFailureLikelyMonteCarlo() {
  console.log('\n=== Failure likely Monte Carlo ===');

  const seeds = Array.from({ length: 30 }, (_, index) => index + 1);
  const results = seeds.map((seed) => runRace(SCENARIOS.RED_FLAG, seed));
  const redFlags = results.filter((result) => result.activeFlag === 'RED');
  const earlyFaults = results.filter((result) => result.firstFault && result.firstFault.leaderLap < 3);
  const earlyReds = redFlags.filter((result) => result.leaderLap < 3);

  assert.ok(redFlags.length > seeds.length / 2,
    `expected majority red flags, got ${redFlags.length}/${seeds.length}`);
  assert.strictEqual(earlyFaults.length, 0,
    `expected no first-lap/early faults, got ${earlyFaults.length}`);
  assert.strictEqual(earlyReds.length, 0,
    `expected no early red flags, got ${earlyReds.length}`);

  console.log(`  OK ${redFlags.length}/${seeds.length} runs red flagged after lap 3`);
}

try {
  testScenarioTuning();
  testBalancedSeeds();
  testFailureLikelySeeds();
  testFailureLikelyMonteCarlo();
  console.log('\nRace modes tests passed.\n');
  process.exit(0);
} catch (err) {
  console.error('\nTest failed:', err.message);
  console.error(err.stack);
  process.exit(1);
}
