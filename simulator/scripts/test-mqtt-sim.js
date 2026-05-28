// Simulator test: first with 1 car, then with 10 cars.
//
// This script does NOT require a real MQTT broker: it uses a mock publisher
// that collects messages. Verifies that:
//
// 1. With 1 car, the tick loop produces telemetry at ~4 Hz
// 2. Data variability is realistic (speed, rpm, tireTemp, fuel)
// 3. With 10 cars everything works and messages scale proportionally
// 4. The FSM transitions correctly (INIT → RUNNING → possible PIT/FAULT)
// 5. Payloads conform to the JSON schema (required fields present)

const Car = require('../src/car/car');
const Orchestrator = require('../src/orchestrator');
const config = require('../config/default');
const roster = require('../config/roster.json');
const { createCarPrng } = require('../src/util/prng');
const { SCENARIOS, applyScenario } = require('../src/scenarios');
const { LENGTH_M, BRAKING_ZONES, targetSpeed } = require('../src/track/monza');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const schemaDir = path.join(__dirname, '..', '..', 'schemas');
const validateTelemetrySchema = ajv.compile(require(path.join(schemaDir, 'telemetry.schema.json')));
const validateStateSchema = ajv.compile(require(path.join(schemaDir, 'state.schema.json')));
const validateEventSchema = ajv.compile(require(path.join(schemaDir, 'event.schema.json')));
const validateFlagSchema = ajv.compile(require(path.join(schemaDir, 'flag.schema.json')));
const validateClassificationSchema = ajv.compile(require(path.join(schemaDir, 'classification.schema.json')));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

// Mock MQTT Publisher that collects messages
class MockPublisher {
  constructor() {
    this.telemetry = [];
    this.states = [];
    this.events = [];
    this._connected = true;
  }
  get connected() { return this._connected; }
  get publishCount() { return this.telemetry.length + this.states.length + this.events.length; }
  publishTelemetry(teamId, carId, payload) { this.telemetry.push(payload); }
  publishState(teamId, carId, payload) { this.states.push(payload); }
  publishEvent(teamId, carId, payload) { this.events.push(payload); }
  publishCarMessages(messages) {
    if (!messages) return;
    if (messages.telemetry) this.telemetry.push(messages.telemetry);
    if (messages.state) this.states.push(messages.state);
    if (messages.events) {
      for (const e of messages.events) this.events.push(e);
    }
  }
  async end() {}
}

// ============================================================
// TEST 1: Single car — 100 ticks (25 simulated seconds at 4 Hz)
// ============================================================

section('TEST 1: Single car — 100 ticks');

const singleConfig = { ...config, seed: 42 };
const singleRng = createCarPrng(42, 16);
const car = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: singleRng,
  config: singleConfig,
});

const dt = 0.25; // 4 Hz
const ctx = {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  leaderLap: 0,
};

// Race start
const startMsgs = car.startRace(1, ctx.timestamp);
assert(car.fsm.state === 'RUNNING', 'After startRace, state must be RUNNING');
assert(startMsgs.state != null, 'startRace produces a state message');
assert(startMsgs.state.state === 'RUNNING', 'state-change state is RUNNING');

console.log('  Running 100 ticks...');

const telemetryHistory = [];
let eventCount = 0;

for (let i = 0; i < 100; i++) {
  ctx.timestamp = new Date().toISOString();
  ctx.leaderLap = car.lap;
  const msgs = car.tick(dt, ctx);

  if (msgs.telemetry) {
    telemetryHistory.push(msgs.telemetry);
  }
  eventCount += (msgs.events ? msgs.events.length : 0);
}

console.log(`  Generated telemetry: ${telemetryHistory.length} samples`);
console.log(`  Events generated: ${eventCount}`);

// Assertions
assert(telemetryHistory.length === 100, `100 telemetry samples (got ${telemetryHistory.length})`);

// Verify that speed varies and is not constant
const speeds = telemetryHistory.map(t => t.speed);
const minSpeed = Math.min(...speeds);
const maxSpeed = Math.max(...speeds);
console.log(`  Speed range: ${minSpeed.toFixed(1)} - ${maxSpeed.toFixed(1)} km/h`);
assert(maxSpeed > minSpeed + 50, `Sufficient speed variability (range=${(maxSpeed - minSpeed).toFixed(1)})`);
assert(maxSpeed <= 400, `Max speed within 400 km/h (got ${maxSpeed.toFixed(1)})`);
assert(minSpeed >= 0, `Min speed >= 0 (got ${minSpeed.toFixed(1)})`);

// RPM varies with speed
const rpms = telemetryHistory.map(t => t.rpm);
const uniqueRpms = new Set(rpms);
assert(uniqueRpms.size > 20, `RPM varies: ${uniqueRpms.size} unique values over 100 ticks`);

// Tires: different temperatures per corner (asymmetry)
const lastTelemetry = telemetryHistory[telemetryHistory.length - 1];
console.log(`  Tire temps: FL=${lastTelemetry.tireTemp.fl}, FR=${lastTelemetry.tireTemp.fr}, RL=${lastTelemetry.tireTemp.rl}, RR=${lastTelemetry.tireTemp.rr}`);
const tireDiff = Math.abs(lastTelemetry.tireTemp.fl - lastTelemetry.tireTemp.fr);
assert(tireDiff > 0.01, `FL/FR tire asymmetry: diff=${tireDiff.toFixed(2)}`);

// Fuel decreases
const firstFuel = telemetryHistory[0].fuel;
const lastFuel = lastTelemetry.fuel;
console.log(`  Fuel: ${firstFuel} → ${lastFuel} kg`);
assert(lastFuel < firstFuel, `Fuel decreases: ${firstFuel} → ${lastFuel}`);

// DRS active in at least one sample
const drsActive = telemetryHistory.filter(t => t.drs === true);
assert(drsActive.length > 0, `DRS active in at least 1 sample (got ${drsActive.length})`);

// Brake active in braking zones
const brakeActive = telemetryHistory.filter(t => t.brake > 0);
assert(brakeActive.length > 0, `Brake active in at least 1 sample (got ${brakeActive.length})`);

// Payload schema compliance (required fields)
const REQUIRED_FIELDS = ['timestamp', 'raceId', 'teamId', 'carId', 'lap', 'trackPos',
  'speed', 'rpm', 'gear', 'throttle', 'brake', 'drs', 'tireTemp', 'fuel', 'compound', 'state'];
const sample = telemetryHistory[50];
for (const field of REQUIRED_FIELDS) {
  assert(sample[field] !== undefined, `Required field '${field}' is present in telemetry`);
}
assert(typeof sample.tireTemp === 'object', 'tireTemp is an object');
assert(sample.tireTemp.fl !== undefined, 'tireTemp.fl present');
assert(sample.tireTemp.fr !== undefined, 'tireTemp.fr present');
assert(sample.tireTemp.rl !== undefined, 'tireTemp.rl present');
assert(sample.tireTemp.rr !== undefined, 'tireTemp.rr present');

// trackPos in [0,1]
for (const t of telemetryHistory) {
  assert(t.trackPos >= 0 && t.trackPos <= 1,
    `trackPos in [0,1]: got ${t.trackPos} at tick`);
}

// Lap progresses (25 seconds at ~250 km/h avg -> ~1.7 km -> ~0.3 laps)
assert(car.lap >= 0, `Valid lap counter: ${car.lap}`);

// ============================================================
// TEST 1B: Car integration edge cases
// ============================================================

section('TEST 1B: Car integration edge cases');

const minimalCar = new Car({ teamId: 'test', carId: 99 });
const minimalMsgs = minimalCar.tick(dt, ctx);
assert(minimalMsgs.telemetry && minimalMsgs.telemetry.state === 'INIT',
  'Car without config produces INIT telemetry without exceptions');

const driverFactorA = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: () => 0.5,
  config: { ...config, teamPerformanceFactor: { ferrari: 1 }, driverPerformanceVariancePct: 0.01 },
});
const driverFactorB = new Car({
  teamId: 'ferrari',
  carId: 55,
  driver: 'C. Sainz',
  rng: () => 0.5,
  config: { ...config, teamPerformanceFactor: { ferrari: 1 }, driverPerformanceVariancePct: 0.01 },
});
const driverFactorARepeat = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: () => 0.5,
  config: { ...config, teamPerformanceFactor: { ferrari: 1 }, driverPerformanceVariancePct: 0.01 },
});
assert(driverFactorA._driverFactor !== driverFactorB._driverFactor,
  'Driver performance factor differs between team-mates by carId');
assert(driverFactorA._driverFactor === driverFactorARepeat._driverFactor,
  'Driver performance factor is deterministic for the same carId');
assert(driverFactorA._driverFactor >= 0.99 && driverFactorA._driverFactor <= 1.01,
  `Driver performance factor stays within configured variance (got ${driverFactorA._driverFactor})`);

const serraglioCar = new Car({
  teamId: 'alpine',
  carId: 31,
  driver: 'E. Ocon',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { alpine: 1 },
  },
});
serraglioCar.startRace(1, ctx.timestamp);
serraglioCar.trackPos = 0.589;
serraglioCar.speed = 163.6;
const serraglioMsgs = serraglioCar.tick(dt, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(targetSpeed(0.589) >= 295,
  `Serraglio has straight target speed (got ${targetSpeed(0.589).toFixed(1)} km/h)`);
assert(serraglioMsgs.telemetry && serraglioMsgs.telemetry.throttle >= 0.9,
  `Car on Serraglio accelerates (throttle=${serraglioMsgs.telemetry && serraglioMsgs.telemetry.throttle})`);
assert(serraglioMsgs.telemetry && serraglioMsgs.telemetry.brake === 0,
  `Car on Serraglio does not brake (brake=${serraglioMsgs.telemetry && serraglioMsgs.telemetry.brake})`);

const firstVariant = BRAKING_ZONES.find(z => z.id === 'prima-variante');
const startApproachCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { ferrari: 1 },
  },
});
startApproachCar.startRace(1, ctx.timestamp);
let earlyBrakeBeforeRettifilo = null;
let firstBrakeFromStart = null;
for (let i = 0; i < 120 && !firstBrakeFromStart; i += 1) {
  const msgs = startApproachCar.tick(dt, {
    raceId: 1,
    timestamp: new Date().toISOString(),
    totalLaps: 15,
    checkeredActive: false,
    activeFlag: 'GREEN',
  });
  const telemetry = msgs.telemetry;
  if (telemetry && telemetry.trackPos < firstVariant.start - 0.002 && telemetry.brake > 0) {
    earlyBrakeBeforeRettifilo = telemetry;
  }
  if (telemetry && telemetry.brake > 0) {
    firstBrakeFromStart = telemetry;
  }
}
assert(earlyBrakeBeforeRettifilo === null,
  `Main straight must not have premature braking at the start (sample=${JSON.stringify(earlyBrakeBeforeRettifilo)})`);
assert(firstBrakeFromStart && firstBrakeFromStart.trackPos >= firstVariant.start,
  `First braking after start must begin at the Prima Variante braking point (trackPos=${firstBrakeFromStart && firstBrakeFromStart.trackPos}, start=${firstVariant.start})`);
assert(firstBrakeFromStart && firstBrakeFromStart.speed >= 300,
  `Car must arrive at Prima Variante braking zone already at high speed (speed=${firstBrakeFromStart && firstBrakeFromStart.speed})`);

const firstVariantCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { ferrari: 1 },
  },
});
firstVariantCar.startRace(1, ctx.timestamp);
firstVariantCar.trackPos = firstVariant.start + 0.001;
firstVariantCar.speed = 350;
const firstVariantMsgs = firstVariantCar.tick(dt, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(firstVariantMsgs.telemetry && firstVariantMsgs.telemetry.brake === 1,
  `Prima Variante brakes at 100% at the 150m board (brake=${firstVariantMsgs.telemetry && firstVariantMsgs.telemetry.brake})`);
assert(firstVariantMsgs.telemetry && firstVariantMsgs.telemetry.throttle === 0,
  `Prima Variante closes throttle under braking (throttle=${firstVariantMsgs.telemetry && firstVariantMsgs.telemetry.throttle})`);
assert(firstVariantMsgs.telemetry && firstVariantMsgs.telemetry.drs === false,
  'DRS closed automatically during Prima Variante braking');

const roggiaApproachCar = new Car({
  teamId: 'mclaren',
  carId: 4,
  driver: 'L. Norris',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { mclaren: 1 },
  },
});
roggiaApproachCar.startRace(1, ctx.timestamp);
roggiaApproachCar.trackPos = 0.270;
roggiaApproachCar.speed = 320;
const roggiaApproachMsgs = roggiaApproachCar.tick(dt, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(roggiaApproachMsgs.telemetry && roggiaApproachMsgs.telemetry.brake === 0,
  `Straight before Roggia must not brake before the 100m board (brake=${roggiaApproachMsgs.telemetry && roggiaApproachMsgs.telemetry.brake})`);
assert(roggiaApproachMsgs.telemetry && roggiaApproachMsgs.telemetry.throttle >= 0.9,
  `Straight before Roggia stays flat out (throttle=${roggiaApproachMsgs.telemetry && roggiaApproachMsgs.telemetry.throttle})`);

const curvaGrandeCar = new Car({
  teamId: 'redbull',
  carId: 1,
  driver: 'M. Verstappen',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { redbull: 1 },
  },
});
curvaGrandeCar.startRace(1, ctx.timestamp);
curvaGrandeCar.trackPos = 0.205;
curvaGrandeCar.speed = 305;
const curvaGrandeMsgs = curvaGrandeCar.tick(dt, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(curvaGrandeMsgs.telemetry && curvaGrandeMsgs.telemetry.brake === 0,
  `Curva Grande must not brake (brake=${curvaGrandeMsgs.telemetry && curvaGrandeMsgs.telemetry.brake})`);
assert(curvaGrandeMsgs.telemetry && curvaGrandeMsgs.telemetry.throttle === 1,
  `Curva Grande must stay full throttle (throttle=${curvaGrandeMsgs.telemetry && curvaGrandeMsgs.telemetry.throttle})`);

const parabolicaCar = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  rng: () => 0.5,
  config: {
    ...config,
    engineFailureProbPerTick: 0,
    speedJitterKmh: 0,
    teamPerformanceFactor: { mercedes: 1 },
  },
});
parabolicaCar.startRace(1, ctx.timestamp);
parabolicaCar.trackPos = 0.855;
parabolicaCar.speed = targetSpeed(0.855);
const parabolicaMsgs = parabolicaCar.tick(dt, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(parabolicaMsgs.telemetry && parabolicaMsgs.telemetry.brake === 0,
  `Parabolica must have released brakes on exit (brake=${parabolicaMsgs.telemetry && parabolicaMsgs.telemetry.brake})`);
assert(parabolicaMsgs.telemetry && parabolicaMsgs.telemetry.throttle > 0.25 && parabolicaMsgs.telemetry.throttle < 1,
  `Parabolica must progressively reopen throttle (throttle=${parabolicaMsgs.telemetry && parabolicaMsgs.telemetry.throttle})`);

const lapCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(777, 16),
  config: { ...config, engineFailureProbPerTick: 0 },
});
lapCar.startRace(1, ctx.timestamp);
const lapEvents = [];
for (let i = 0; i < 1300 && lapEvents.length < 2; i++) {
  const msgs = lapCar.tick(dt, {
    raceId: 1,
    timestamp: new Date().toISOString(),
    totalLaps: 15,
    checkeredActive: false,
  });
  for (const e of msgs.events || []) {
    if (e.type === 'lap-completed') lapEvents.push(e);
  }
}
assert(lapEvents.length >= 2, `lap-completed emitted for two laps (got ${lapEvents.length})`);
assert(lapEvents[0] && lapEvents[0].details.lap === 1,
  `first lap-completed has lap=1 (got ${lapEvents[0] && lapEvents[0].details.lap})`);
assert(lapEvents[1] && lapEvents[1].details.lap === 2,
  `second lap-completed has lap=2 (got ${lapEvents[1] && lapEvents[1].details.lap})`);

const pitConfig = { ...config, engineFailureProbPerTick: 0 };
const pitCar = new Car({
  teamId: 'ferrari',
  carId: 55,
  driver: 'C. Sainz',
  rng: createCarPrng(888, 55),
  config: pitConfig,
});
pitCar.startRace(1, ctx.timestamp);
let pitEntryTelemetry = null;
let pitStopEvent = null;
let pitExitTelemetry = null;
let pitEntryLap = null;
for (let i = 0; i < 1800 && !pitExitTelemetry; i++) {
  const msgs = pitCar.tick(dt, {
    raceId: 1,
    timestamp: new Date().toISOString(),
    totalLaps: 15,
    checkeredActive: false,
  });

  if (msgs.state && msgs.state.state === 'PIT') {
    pitEntryTelemetry = msgs.telemetry;
    pitEntryLap = pitCar.lap;
  }
  for (const e of msgs.events || []) {
    if (e.type === 'pit-stop') pitStopEvent = e;
  }
  if (msgs.state && msgs.state.previousState === 'PIT' && msgs.state.state === 'RUNNING') {
    pitExitTelemetry = msgs.telemetry;
  }
}
assert(pitEntryTelemetry && pitEntryTelemetry.trackPos >= pitConfig.pitEntryPos,
  `PIT triggers at pit entry (trackPos=${pitEntryTelemetry && pitEntryTelemetry.trackPos})`);
assert(pitStopEvent != null, 'pit-stop event emitted after pit entry');
assert(pitExitTelemetry && pitExitTelemetry.lap > pitEntryLap && pitExitTelemetry.trackPos >= pitConfig.pitExitPos,
  `pit-exit after lap wrap and pitExitPos (lap=${pitExitTelemetry && pitExitTelemetry.lap}, trackPos=${pitExitTelemetry && pitExitTelemetry.trackPos})`);

// ============================================================
// TEST 1C: Safety Car
// ============================================================

section('TEST 1C: Safety Car');

const scConfig = {
  ...config,
  engineFailureProbPerTick: 0,
  safetyCarSpeedKmh: 140,
  safetyCarCatchupSpeedKmh: 180,
  safetyCarTargetGapS: 0.5,
  safetyCarGapGainKmhPerS: 12,
  safetyCarCloseGapSlowdownKmhPerS: 60,
  safetyCarMinSpeedKmh: 60,
};

const scLeader = new Car({
  teamId: 'redbull',
  carId: 1,
  driver: 'M. Verstappen',
  rng: createCarPrng(1001, 1),
  config: scConfig,
});
scLeader.startRace(1, ctx.timestamp);
scLeader.trackPos = 0.2;
scLeader.speed = 250;
scLeader.tick(2, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'SC',
  safetyCar: { isLeader: true, gapToCarAheadS: 0, targetGapS: scConfig.safetyCarTargetGapS },
});
assert(scLeader.speed <= scConfig.safetyCarSpeedKmh + 0.1,
  `SC leader capped at ${scConfig.safetyCarSpeedKmh} km/h (got ${scLeader.speed.toFixed(1)})`);

const scChaser = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1002, 16),
  config: scConfig,
});
scChaser.startRace(1, ctx.timestamp);
scChaser.trackPos = 0.19;
scChaser.speed = scConfig.safetyCarSpeedKmh;
const chaserMsgs = scChaser.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'SC',
  safetyCar: { isLeader: false, gapToCarAheadS: 8, targetGapS: scConfig.safetyCarTargetGapS },
});
assert(scChaser.speed > scConfig.safetyCarSpeedKmh,
  `SC distant car accelerates to bunch up (got ${scChaser.speed.toFixed(1)})`);
assert(scChaser.speed <= scConfig.safetyCarCatchupSpeedKmh,
  `SC catch-up stays below ${scConfig.safetyCarCatchupSpeedKmh} km/h (got ${scChaser.speed.toFixed(1)})`);
assert(chaserMsgs.telemetry && chaserMsgs.telemetry.drs === false,
  'DRS disattivato sotto Safety Car');

const scClose = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  rng: createCarPrng(1003, 44),
  config: scConfig,
});
scClose.startRace(1, ctx.timestamp);
scClose.trackPos = 0.19;
scClose.speed = scConfig.safetyCarSpeedKmh;
scClose.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'SC',
  safetyCar: { isLeader: false, gapToCarAheadS: 0.1, targetGapS: scConfig.safetyCarTargetGapS },
});
assert(scClose.speed < scConfig.safetyCarSpeedKmh,
  `SC car too close slows down to maintain gap (got ${scClose.speed.toFixed(1)})`);

const scOrchestrator = new Orchestrator({
  roster: [
    { teamId: 'redbull', carId: 1, driver: 'M. Verstappen' },
    { teamId: 'ferrari', carId: 16, driver: 'C. Leclerc' },
  ],
  config: scConfig,
  publisher: new MockPublisher(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
for (const c of scOrchestrator.cars) c.startRace(1, ctx.timestamp);
scOrchestrator.cars[0].lap = 1;
scOrchestrator.cars[0].trackPos = 0.5;
scOrchestrator.cars[1].lap = 1;
scOrchestrator.cars[1].trackPos = 0.45;
const scContexts = scOrchestrator._buildSafetyCarContexts('SC');
assert(scContexts.get(1) && scContexts.get(1).isLeader === true,
  'Orchestrator identifies the leader under SC');
assert(scContexts.get(16) && scContexts.get(16).gapToCarAheadS > scConfig.safetyCarTargetGapS,
  `Orchestrator computes SC gap to car ahead (got ${scContexts.get(16) && scContexts.get(16).gapToCarAheadS})`);

// ============================================================
// TEST 1D: Virtual Safety Car
// ============================================================

section('TEST 1D: Virtual Safety Car');

const vscConfig = {
  ...config,
  engineFailureProbPerTick: 0,
  virtualSafetyCarSpeedKmh: 120,
  virtualSafetyCarMinGapM: 5,
};

const vscLeader = new Car({
  teamId: 'redbull',
  carId: 1,
  driver: 'M. Verstappen',
  rng: createCarPrng(1101, 1),
  config: vscConfig,
});
vscLeader.startRace(1, ctx.timestamp);
vscLeader.trackPos = 0.94;
vscLeader.speed = 250;
const leaderMsgs = vscLeader.tick(2, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'VSC',
  virtualSafetyCar: { isLeader: true, position: 1 },
});
assert(vscLeader.speed <= vscConfig.virtualSafetyCarSpeedKmh + 0.1,
  `VSC limits speed to ${vscConfig.virtualSafetyCarSpeedKmh} km/h (got ${vscLeader.speed.toFixed(1)})`);
assert(leaderMsgs.telemetry && leaderMsgs.telemetry.drs === false,
  'DRS disabled under Virtual Safety Car');

const leaderProgress = 0.5;
const maxVscProgress = leaderProgress - (vscConfig.virtualSafetyCarMinGapM / LENGTH_M);
const vscChaser = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1102, 16),
  config: vscConfig,
});
vscChaser.startRace(1, ctx.timestamp);
vscChaser.trackPos = 0.49;
vscChaser.speed = 300;
vscChaser.tick(2, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'VSC',
  virtualSafetyCar: { isLeader: false, position: 2, maxProgress: maxVscProgress },
});
const chaserProgress = vscChaser.lap + vscChaser.trackPos;
assert(chaserProgress <= maxVscProgress + 1e-9,
  `VSC prevents overtaking (progress=${chaserProgress.toFixed(6)}, max=${maxVscProgress.toFixed(6)})`);

const vscOrchestrator = new Orchestrator({
  roster: [
    { teamId: 'redbull', carId: 1, driver: 'M. Verstappen' },
    { teamId: 'ferrari', carId: 16, driver: 'C. Leclerc' },
  ],
  config: vscConfig,
  publisher: new MockPublisher(),
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});
for (const c of vscOrchestrator.cars) c.startRace(1, ctx.timestamp);
vscOrchestrator.cars[0].lap = 1;
vscOrchestrator.cars[0].trackPos = 0.5;
vscOrchestrator.cars[1].lap = 1;
vscOrchestrator.cars[1].trackPos = 0.49;
const vscContexts = vscOrchestrator._buildVirtualSafetyCarContexts('VSC');
assert(vscContexts.get(1) && vscContexts.get(1).isLeader === true,
  'Orchestrator identifies the leader under VSC');
assert(vscContexts.get(16) && vscContexts.get(16).maxProgress < 1.5,
  'Orchestrator computes the VSC anti-overtaking limit');

// ============================================================
// TEST 1E: Race flags (GREEN / YELLOW / RED / CHECKERED)
// ============================================================

section('TEST 1E: Race flags');

const flagConfig = {
  ...config,
  engineFailureProbPerTick: 0,
  yellowSpeedMultiplier: 0.6,
};

const greenFlagCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1201, 16),
  config: flagConfig,
});
greenFlagCar.startRace(1, ctx.timestamp);
greenFlagCar.currentSector = 3;
greenFlagCar.trackPos = 0.94;
greenFlagCar.speed = 250;
const greenFlagMsgs = greenFlagCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(greenFlagCar.speed > 250,
  `GREEN keeps the race active and the car accelerates (got ${greenFlagCar.speed.toFixed(1)})`);
assert(greenFlagMsgs.telemetry && greenFlagMsgs.telemetry.drs === true,
  'GREEN does not disable DRS in enabled zones');

const yellowFlagCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1201, 16),
  config: flagConfig,
});
yellowFlagCar.startRace(1, ctx.timestamp);
yellowFlagCar.currentSector = 3;
yellowFlagCar.trackPos = 0.94;
yellowFlagCar.speed = 250;
const yellowFlagMsgs = yellowFlagCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'YELLOW',
  activeFlagSector: 3,
});
assert(yellowFlagCar.speed < greenFlagCar.speed,
  `YELLOW slows down in the active sector (${yellowFlagCar.speed.toFixed(1)} < ${greenFlagCar.speed.toFixed(1)})`);
assert(yellowFlagMsgs.telemetry && yellowFlagMsgs.telemetry.drs === false,
  'YELLOW disables DRS in the affected sector');

const yellowOtherSectorCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1201, 16),
  config: flagConfig,
});
yellowOtherSectorCar.startRace(1, ctx.timestamp);
yellowOtherSectorCar.currentSector = 3;
yellowOtherSectorCar.trackPos = 0.94;
yellowOtherSectorCar.speed = 250;
const yellowOtherSectorMsgs = yellowOtherSectorCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'YELLOW',
  activeFlagSector: 2,
});
assert(yellowOtherSectorCar.speed === greenFlagCar.speed,
  'Local YELLOW does not slow down outside the affected sector');
assert(yellowOtherSectorMsgs.telemetry && yellowOtherSectorMsgs.telemetry.drs === true,
  'Local YELLOW outside sector does not disable DRS');

const redFlagCar = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  rng: createCarPrng(1202, 44),
  config: flagConfig,
});
redFlagCar.startRace(1, ctx.timestamp);
redFlagCar.trackPos = 0.2;
redFlagCar.speed = 220;
const redFlagMsgs = redFlagCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'RED',
});
assert(redFlagCar.speed < 220,
  `RED makes the car brake (got ${redFlagCar.speed.toFixed(1)})`);
assert(redFlagMsgs.telemetry && redFlagMsgs.telemetry.brake > 0,
  'RED produces braking in telemetry');
assert(redFlagMsgs.telemetry && redFlagMsgs.telemetry.drs === false,
  'RED disables DRS');

for (let i = 0; i < 3; i++) {
  redFlagCar.tick(1, {
    raceId: 1,
    timestamp: new Date().toISOString(),
    totalLaps: 15,
    checkeredActive: false,
    activeFlag: 'RED',
  });
}
const stoppedPos = redFlagCar.trackPos;
redFlagCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'RED',
});
assert(redFlagCar.speed === 0 && redFlagCar.trackPos === stoppedPos,
  'RED suspends the race: car stopped after braking');

const checkeredFlagCar = new Car({
  teamId: 'mclaren',
  carId: 4,
  driver: 'L. Norris',
  rng: createCarPrng(1203, 4),
  config: flagConfig,
});
checkeredFlagCar.startRace(1, ctx.timestamp);
checkeredFlagCar.lap = 15;
const checkeredMsgs = checkeredFlagCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: true,
  activeFlag: 'CHECKERED',
});
assert(checkeredFlagCar.fsm.state === 'FINISHED',
  `CHECKERED closes the race on the final lap (state=${checkeredFlagCar.fsm.state})`);
assert(checkeredMsgs.state && checkeredMsgs.state.state === 'FINISHED',
  'CHECKERED produces the FINISHED state');

// ============================================================
// TEST 1F: Combined race scenarios
// ============================================================

section('TEST 1F: Combined race scenarios');

const combinedConfig = {
  ...config,
  engineFailureProbPerTick: 0,
  pitBoxPos: 0.951,
  pitDurationMinS: 2,
  pitDurationMaxS: 2,
  pitLaneSpeedKmh: 80,
};

const pitUnderScCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  rng: createCarPrng(1301, 16),
  config: combinedConfig,
});
pitUnderScCar.startRace(1, ctx.timestamp);
pitUnderScCar.lap = 2;
pitUnderScCar._tireWear = 0.9; // >= pit threshold to trigger tire-service entry
pitUnderScCar.trackPos = combinedConfig.pitEntryPos;
pitUnderScCar.speed = 60;
pitUnderScCar.fuel = 4;
const scPitEntryMsgs = pitUnderScCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(scPitEntryMsgs.state && scPitEntryMsgs.state.state === 'PIT',
  'tire-service pit enters PIT before Safety Car phase');
const scPitMsgs = pitUnderScCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'SC',
  safetyCar: { isLeader: false, gapToCarAheadS: 8, targetGapS: combinedConfig.safetyCarTargetGapS },
});
assert(pitUnderScCar.fsm.state === 'PIT',
  'SC during pit stop keeps the car in PIT state');
assert(pitUnderScCar.speed <= combinedConfig.pitLaneSpeedKmh,
  `SC during pit stop respects pit-lane speed limit (got ${pitUnderScCar.speed.toFixed(1)})`);
assert((scPitMsgs.events || []).some(e => e.type === 'pit-stop'),
  'SC during pit stop still emits pit-stop event');

const redPitCar = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  rng: createCarPrng(1302, 44),
  config: combinedConfig,
});
redPitCar.startRace(1, ctx.timestamp);
redPitCar.fsm = { state: 'PIT', previousState: 'RUNNING', reason: 'tire-service' };
redPitCar._pitServiced = true;
redPitCar._pitEntryLap = 1;
redPitCar.lap = 2;
redPitCar.trackPos = combinedConfig.pitExitPos + 0.001;
redPitCar.speed = 40;
redPitCar.simulatedTimeS = 10;
redPitCar.condTracker = {
  ...redPitCar.condTracker,
  pitEnteredAtS: 0,
  pitDurationS: 2,
};
const redPitPos = redPitCar.trackPos;
const redPitMsgs = redPitCar.tick(1, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'RED',
});
assert(redPitCar.fsm.state === 'PIT',
  'RED during pit exit keeps the car in PIT state');
assert(!redPitMsgs.state,
  'RED during pit exit does not publish PIT to RUNNING');
assert(redPitCar.speed === 0 && redPitCar.trackPos === redPitPos,
  'RED during pit exit holds the car stopped in place');

const greenAfterRedPitMsgs = redPitCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(redPitCar.fsm.state === 'RUNNING',
  'pit exit resumes after RED clears to GREEN');
assert(greenAfterRedPitMsgs.state && greenAfterRedPitMsgs.state.previousState === 'PIT',
  'pit exit publishes state once RED clears');

// ============================================================
// TEST 1G: Scenario tuning
// ============================================================

section('TEST 1G: Scenario tuning');

const redScenarioConfig = applyScenario(config, SCENARIOS.RED_FLAG);
assert(redScenarioConfig.faultGraceS === 300,
  `RED scenario has anti-fault grace window at 300s (got ${redScenarioConfig.faultGraceS})`);
assert(redScenarioConfig.engineFailureProbPerTick === 0.0012,
  'RED scenario resta probabilistico ad alta failure dopo la grace window');
assert(redScenarioConfig.tireOverheatThresholdC === 142,
  'RED scenario uses recalibrated overheat threshold for 5 laps');
assert(redScenarioConfig.tireOverheatTicksRequired === 8,
  'RED scenario requires persistent overheat before fault');

const redScenarioCar = new Car({
  teamId: 'redbull',
  carId: 1,
  driver: 'M. Verstappen',
  rng: () => 0,
  config: redScenarioConfig,
});
redScenarioCar.startRace(1, ctx.timestamp);
for (let i = 0; i < (redScenarioConfig.faultGraceS * 4) - 1; i++) {
  redScenarioCar.tick(0.25, {
    raceId: 1,
    timestamp: new Date().toISOString(),
    totalLaps: 15,
    checkeredActive: false,
    activeFlag: 'GREEN',
  });
}
assert(redScenarioCar.fsm.state === 'RUNNING',
  `RED scenario does not produce fault before the grace window (state=${redScenarioCar.fsm.state})`);
const redScenarioGraceMsgs = redScenarioCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(redScenarioCar.fsm.state === 'FAULT',
  `RED scenario allows fault after the grace window (state=${redScenarioCar.fsm.state})`);
assert((redScenarioGraceMsgs.events || []).some(e => e.type === 'fault'),
  'RED scenario publishes fault event after the grace window');

// ============================================================
// TEST 2: 10 cars — 80 ticks (20 simulated seconds)
// ============================================================

section('TEST 2: 10 cars — 80 ticks (20 simulated seconds)');

const mockPub = new MockPublisher();
const multiConfig = { ...config, seed: 12345, totalLaps: 15 };

const orchestrator = new Orchestrator({
  roster,
  config: multiConfig,
  publisher: mockPub,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

// Manual startRace (normally called in start(); done here explicitly for control)
const ts = new Date().toISOString();
for (const c of orchestrator.cars) {
  const startMsgs = c.startRace(1, ts);
  mockPub.publishCarMessages(startMsgs);
}

console.log(`  Cars in roster: ${orchestrator.cars.length}`);
assert(orchestrator.cars.length === 10, `10 cars created (got ${orchestrator.cars.length})`);
const startingCompounds = new Set(orchestrator.cars.map((c) => c.compound));
console.log(`  Starting compounds: ${Array.from(startingCompounds).sort().join(', ')}`);
assert(startingCompounds.size > 1, `Starting compounds staggered across grid (got ${startingCompounds.size})`);

// Simulate 80 manual ticks: differences between cars emerge after the Prima Variante braking zone,
// while in the first seconds from the start all cars are limited by MAX_ACCEL.
const multiCtx = {
  raceId: 1,
  timestamp: ts,
  totalLaps: 15,
  checkeredActive: false,
  leaderLap: 0,
};

const startTelemetryCount = mockPub.telemetry.length;

for (let i = 0; i < 80; i++) {
  multiCtx.timestamp = new Date().toISOString();
  let maxLap = 0;
  for (const c of orchestrator.cars) {
    const msgs = c.tick(dt, multiCtx);
    mockPub.publishCarMessages(msgs);
    if (c.lap > maxLap) maxLap = c.lap;
  }
  multiCtx.leaderLap = maxLap;
}

const multiTelemetryCount = mockPub.telemetry.length - startTelemetryCount;
console.log(`  Telemetry 10 cars × 80 ticks: ${multiTelemetryCount} samples`);

// Each non-terminal car produces 1 telemetry sample per tick
// Assuming all cars are RUNNING (no RETIRED within 80 ticks)
assert(multiTelemetryCount >= 750, `At least 750 samples (10×80 - FAULT margin): got ${multiTelemetryCount}`);
assert(multiTelemetryCount <= 800, `Max 800 samples: got ${multiTelemetryCount}`);

// Different speeds across cars (per-car variability)
const car1Speeds = [];
const car2Speeds = [];
for (const t of mockPub.telemetry.slice(startTelemetryCount)) {
  if (t.carId === 16) car1Speeds.push(t.speed);
  if (t.carId === 44) car2Speeds.push(t.speed);
}

if (car1Speeds.length > 0 && car2Speeds.length > 0) {
  const avg1 = car1Speeds.reduce((a, b) => a + b, 0) / car1Speeds.length;
  const avg2 = car2Speeds.reduce((a, b) => a + b, 0) / car2Speeds.length;
  console.log(`  Average speed Car#16 (Ferrari): ${avg1.toFixed(1)} km/h`);
  console.log(`  Average speed Car#44 (Mercedes): ${avg2.toFixed(1)} km/h`);
  assert(Math.abs(avg1 - avg2) > 0.1, `Different average speeds between cars (diff=${Math.abs(avg1 - avg2).toFixed(2)})`);
}

// Team diversity
const teamSpeeds = {};
for (const t of mockPub.telemetry.slice(startTelemetryCount)) {
  if (!teamSpeeds[t.teamId]) teamSpeeds[t.teamId] = [];
  teamSpeeds[t.teamId].push(t.speed);
}
const teamAvgs = {};
for (const [team, speeds] of Object.entries(teamSpeeds)) {
  teamAvgs[team] = speeds.reduce((a, b) => a + b, 0) / speeds.length;
}
console.log('  Average speeds per team:', Object.entries(teamAvgs)
  .sort(([,a], [,b]) => b - a)
  .map(([t, v]) => `${t}=${v.toFixed(1)}`)
  .join(', '));

// Different fuel values across cars (using internal state, not rounded telemetry)
const rawFuels = orchestrator.cars.map(c => c.fuel);
const uniqueRawFuels = new Set(rawFuels.map(f => f.toFixed(4)));
console.log(`  Fuel range: ${Math.min(...rawFuels).toFixed(4)} - ${Math.max(...rawFuels).toFixed(4)} kg`);
assert(uniqueRawFuels.size > 1, `Fuel differs between cars: ${uniqueRawFuels.size} unique values`);

// ============================================================
// TEST 3: Verify schema compliance on all samples
// ============================================================

section('TEST 3: Schema compliance');

let schemaErrors = 0;
for (const t of mockPub.telemetry) {
  for (const field of REQUIRED_FIELDS) {
    if (t[field] === undefined) {
      schemaErrors++;
      console.error(`  Schema error: field '${field}' missing in car ${t.carId}`);
    }
  }
  if (typeof t.tireTemp !== 'object' ||
      t.tireTemp.fl === undefined ||
      t.tireTemp.fr === undefined ||
      t.tireTemp.rl === undefined ||
      t.tireTemp.rr === undefined) {
    schemaErrors++;
  }
  if (t.speed < 0 || t.speed > 400) schemaErrors++;
  if (t.rpm < 0 || t.rpm > 16000) schemaErrors++;
  if (t.trackPos < 0 || t.trackPos > 1) schemaErrors++;
  if (t.throttle < 0 || t.throttle > 1) schemaErrors++;
  if (t.brake < 0 || t.brake > 1) schemaErrors++;
  if (!validateTelemetrySchema(t)) {
    schemaErrors++;
    console.error(`  Telemetry schema error car ${t.carId}: ${JSON.stringify(validateTelemetrySchema.errors && validateTelemetrySchema.errors[0])}`);
  }
}
for (const s of mockPub.states) {
  if (!validateStateSchema(s)) {
    schemaErrors++;
    console.error(`  State schema error car ${s.carId}: ${JSON.stringify(validateStateSchema.errors && validateStateSchema.errors[0])}`);
  }
}
for (const e of mockPub.events) {
  if (!validateEventSchema(e)) {
    schemaErrors++;
    console.error(`  Event schema error car ${e.carId}: ${JSON.stringify(validateEventSchema.errors && validateEventSchema.errors[0])}`);
  }
}
const sampleFlag = {
  timestamp: new Date().toISOString(),
  raceId: 1,
  flag: 'GREEN',
  active: true,
  sector: null,
  reason: 'schema-test',
};
if (!validateFlagSchema(sampleFlag)) {
  schemaErrors++;
  console.error(`  Flag schema error: ${JSON.stringify(validateFlagSchema.errors && validateFlagSchema.errors[0])}`);
}
const sampleClassification = {
  timestamp: new Date().toISOString(),
  raceId: 1,
  lap: 1,
  leaderLap: 1,
  standings: [
    { position: 1, carId: 16, teamId: 'ferrari', lap: 1, gap: 0, state: 'RUNNING' },
  ],
};
if (!validateClassificationSchema(sampleClassification)) {
  schemaErrors++;
  console.error(`  Classification schema error: ${JSON.stringify(validateClassificationSchema.errors && validateClassificationSchema.errors[0])}`);
}
console.log(`  Verified samples: ${mockPub.telemetry.length}`);
assert(schemaErrors === 0, `No schema errors (${schemaErrors} found)`);

// ============================================================
// TEST 4: State-change events
// ============================================================

section('TEST 4: Events and transitions');

const stateChanges = mockPub.events.filter(e => e.type === 'state-change');
console.log(`  State changes: ${stateChanges.length}`);
assert(stateChanges.length >= 10, `At least 10 state-change events (INIT→RUNNING for each): got ${stateChanges.length}`);

// All state-changes have from and to
for (const sc of stateChanges) {
  assert(sc.details && sc.details.from, `state-change has from: ${JSON.stringify(sc.details)}`);
  assert(sc.details && sc.details.to, `state-change has to: ${JSON.stringify(sc.details)}`);
}

// ============================================================
// RESULTS
// ============================================================

section('RESULTS');

console.log(`  ✓ Passed: ${passed}`);
console.log(`  ✗ Failed: ${failed}`);
console.log();

if (failed > 0) {
  console.error('❌ TESTS FAILED!');
  process.exit(1);
} else {
  console.log('✅ ALL TESTS PASSED!');
  process.exit(0);
}
