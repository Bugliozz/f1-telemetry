// Test del simulatore: prima con 1 auto, poi con 10.
//
// Questo script NON richiede un broker MQTT reale: usa un mock publisher
// che conta i messaggi. Verifica che:
//
// 1. Con 1 auto il loop di tick produce telemetria a ~4 Hz
// 2. La variabilita' dei dati e' realistica (speed, rpm, tireTemp, fuel)
// 3. Con 10 auto tutto funziona e i messaggi sono proporzionali
// 4. La FSM transita correttamente (INIT → RUNNING → eventuali PIT/FAULT)
// 5. I payload sono conformi allo schema JSON (campi obbligatori presenti)

const Car = require('../src/car/car');
const Orchestrator = require('../src/orchestrator');
const config = require('../config/default');
const roster = require('../config/roster.json');
const { createCarPrng } = require('../src/util/prng');
const { LENGTH_M } = require('../src/track/monza');
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

// Mock MQTT Publisher che raccoglie i messaggi
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
// TEST 1: Singola auto — 100 tick (25 secondi simulati a 4 Hz)
// ============================================================

section('TEST 1: Singola auto — 100 tick');

const singleConfig = { ...config, seed: 42 };
const singleRng = createCarPrng(42, 16);
const car = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [8],
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
assert(car.fsm.state === 'RUNNING', 'Dopo startRace, stato deve essere RUNNING');
assert(startMsgs.state != null, 'startRace produce un messaggio state');
assert(startMsgs.state.state === 'RUNNING', 'Stato state-change e\' RUNNING');

console.log('  Esecuzione 100 tick...');

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

console.log(`  Telemetria generata: ${telemetryHistory.length} campioni`);
console.log(`  Eventi generati: ${eventCount}`);

// Verifiche
assert(telemetryHistory.length === 100, `100 campioni di telemetria (got ${telemetryHistory.length})`);

// Verificare che la velocita' varia (non costante)
const speeds = telemetryHistory.map(t => t.speed);
const minSpeed = Math.min(...speeds);
const maxSpeed = Math.max(...speeds);
console.log(`  Speed range: ${minSpeed.toFixed(1)} - ${maxSpeed.toFixed(1)} km/h`);
assert(maxSpeed > minSpeed + 50, `Variabilita velocita sufficiente (range=${(maxSpeed - minSpeed).toFixed(1)})`);
assert(maxSpeed <= 400, `Velocita max entro 400 km/h (got ${maxSpeed.toFixed(1)})`);
assert(minSpeed >= 0, `Velocita min >= 0 (got ${minSpeed.toFixed(1)})`);

// RPM varia con la velocita'
const rpms = telemetryHistory.map(t => t.rpm);
const uniqueRpms = new Set(rpms);
assert(uniqueRpms.size > 20, `RPM varia: ${uniqueRpms.size} valori unici su 100 tick`);

// Gomme: temperature diverse per angolo (asimmetria)
const lastTelemetry = telemetryHistory[telemetryHistory.length - 1];
console.log(`  Tire temps: FL=${lastTelemetry.tireTemp.fl}, FR=${lastTelemetry.tireTemp.fr}, RL=${lastTelemetry.tireTemp.rl}, RR=${lastTelemetry.tireTemp.rr}`);
const tireDiff = Math.abs(lastTelemetry.tireTemp.fl - lastTelemetry.tireTemp.fr);
assert(tireDiff > 0.01, `Asimmetria gomme FL/FR: diff=${tireDiff.toFixed(2)}`);

// Fuel decresce
const firstFuel = telemetryHistory[0].fuel;
const lastFuel = lastTelemetry.fuel;
console.log(`  Fuel: ${firstFuel} → ${lastFuel} kg`);
assert(lastFuel < firstFuel, `Fuel decresce: ${firstFuel} → ${lastFuel}`);

// DRS attivo in almeno un campione
const drsActive = telemetryHistory.filter(t => t.drs === true);
assert(drsActive.length > 0, `DRS attivato in almeno 1 campione (got ${drsActive.length})`);

// Payload schema compliance (campi obbligatori)
const REQUIRED_FIELDS = ['timestamp', 'raceId', 'teamId', 'carId', 'lap', 'trackPos',
  'speed', 'rpm', 'gear', 'throttle', 'brake', 'drs', 'tireTemp', 'fuel', 'state'];
const sample = telemetryHistory[50];
for (const field of REQUIRED_FIELDS) {
  assert(sample[field] !== undefined, `Campo obbligatorio '${field}' presente nella telemetria`);
}
assert(typeof sample.tireTemp === 'object', 'tireTemp e\' un oggetto');
assert(sample.tireTemp.fl !== undefined, 'tireTemp.fl presente');
assert(sample.tireTemp.fr !== undefined, 'tireTemp.fr presente');
assert(sample.tireTemp.rl !== undefined, 'tireTemp.rl presente');
assert(sample.tireTemp.rr !== undefined, 'tireTemp.rr presente');

// trackPos in [0,1]
for (const t of telemetryHistory) {
  assert(t.trackPos >= 0 && t.trackPos <= 1,
    `trackPos in [0,1]: got ${t.trackPos} at tick`);
}

// Lap avanza (25 secondi a ~250 km/h avg → ~1.7 km → ~0.3 giri)
assert(car.lap >= 0, `Lap counter valido: ${car.lap}`);

// ============================================================
// TEST 1B: Car integration edge cases
// ============================================================

section('TEST 1B: Car integration edge cases');

const minimalCar = new Car({ teamId: 'test', carId: 99 });
const minimalMsgs = minimalCar.tick(dt, ctx);
assert(minimalMsgs.telemetry && minimalMsgs.telemetry.state === 'INIT',
  'Car senza config produce telemetria INIT senza eccezioni');

const lapCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [],
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
assert(lapEvents.length >= 2, `lap-completed emesso per due giri (got ${lapEvents.length})`);
assert(lapEvents[0] && lapEvents[0].details.lap === 1,
  `primo lap-completed ha lap=1 (got ${lapEvents[0] && lapEvents[0].details.lap})`);
assert(lapEvents[1] && lapEvents[1].details.lap === 2,
  `secondo lap-completed ha lap=2 (got ${lapEvents[1] && lapEvents[1].details.lap})`);

const pitConfig = { ...config, engineFailureProbPerTick: 0 };
const pitCar = new Car({
  teamId: 'ferrari',
  carId: 55,
  driver: 'C. Sainz',
  pitStrategy: [1],
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
  `PIT scatta alla pit entry (trackPos=${pitEntryTelemetry && pitEntryTelemetry.trackPos})`);
assert(pitStopEvent != null, 'pit-stop emesso dopo ingresso pit');
assert(pitExitTelemetry && pitExitTelemetry.lap > pitEntryLap && pitExitTelemetry.trackPos >= pitConfig.pitExitPos,
  `pit-exit dopo giro wrap e pitExitPos (lap=${pitExitTelemetry && pitExitTelemetry.lap}, trackPos=${pitExitTelemetry && pitExitTelemetry.trackPos})`);

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
  pitStrategy: [],
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
  `SC leader limitato a ${scConfig.safetyCarSpeedKmh} km/h (got ${scLeader.speed.toFixed(1)})`);

const scChaser = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [],
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
  `SC auto lontana accelera per compattare (got ${scChaser.speed.toFixed(1)})`);
assert(scChaser.speed <= scConfig.safetyCarCatchupSpeedKmh,
  `SC catch-up resta sotto ${scConfig.safetyCarCatchupSpeedKmh} km/h (got ${scChaser.speed.toFixed(1)})`);
assert(chaserMsgs.telemetry && chaserMsgs.telemetry.drs === false,
  'DRS disattivato sotto Safety Car');

const scClose = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  pitStrategy: [],
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
  `SC auto troppo vicina rallenta per tenere gap (got ${scClose.speed.toFixed(1)})`);

const scOrchestrator = new Orchestrator({
  roster: [
    { teamId: 'redbull', carId: 1, driver: 'M. Verstappen', pitStrategy: [] },
    { teamId: 'ferrari', carId: 16, driver: 'C. Leclerc', pitStrategy: [] },
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
  'Orchestrator identifica il leader sotto SC');
assert(scContexts.get(16) && scContexts.get(16).gapToCarAheadS > scConfig.safetyCarTargetGapS,
  `Orchestrator calcola gap SC verso auto davanti (got ${scContexts.get(16) && scContexts.get(16).gapToCarAheadS})`);

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
  pitStrategy: [],
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
  `VSC limita la velocita a ${vscConfig.virtualSafetyCarSpeedKmh} km/h (got ${vscLeader.speed.toFixed(1)})`);
assert(leaderMsgs.telemetry && leaderMsgs.telemetry.drs === false,
  'DRS disattivato sotto Virtual Safety Car');

const leaderProgress = 0.5;
const maxVscProgress = leaderProgress - (vscConfig.virtualSafetyCarMinGapM / LENGTH_M);
const vscChaser = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [],
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
  `VSC blocca il sorpasso (progress=${chaserProgress.toFixed(6)}, max=${maxVscProgress.toFixed(6)})`);

const vscOrchestrator = new Orchestrator({
  roster: [
    { teamId: 'redbull', carId: 1, driver: 'M. Verstappen', pitStrategy: [] },
    { teamId: 'ferrari', carId: 16, driver: 'C. Leclerc', pitStrategy: [] },
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
  'Orchestrator identifica il leader sotto VSC');
assert(vscContexts.get(16) && vscContexts.get(16).maxProgress < 1.5,
  'Orchestrator calcola il limite anti-sorpasso VSC');

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
  pitStrategy: [],
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
  `GREEN lascia la gara attiva e l'auto accelera (got ${greenFlagCar.speed.toFixed(1)})`);
assert(greenFlagMsgs.telemetry && greenFlagMsgs.telemetry.drs === true,
  'GREEN non disattiva il DRS nelle zone abilitate');

const yellowFlagCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [],
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
  `YELLOW rallenta nel settore attivo (${yellowFlagCar.speed.toFixed(1)} < ${greenFlagCar.speed.toFixed(1)})`);
assert(yellowFlagMsgs.telemetry && yellowFlagMsgs.telemetry.drs === false,
  'YELLOW disattiva il DRS nel settore interessato');

const yellowOtherSectorCar = new Car({
  teamId: 'ferrari',
  carId: 16,
  driver: 'C. Leclerc',
  pitStrategy: [],
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
  'YELLOW locale non rallenta fuori dal settore interessato');
assert(yellowOtherSectorMsgs.telemetry && yellowOtherSectorMsgs.telemetry.drs === true,
  'YELLOW locale fuori settore non disattiva il DRS');

const redFlagCar = new Car({
  teamId: 'mercedes',
  carId: 44,
  driver: 'L. Hamilton',
  pitStrategy: [],
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
  `RED fa frenare l'auto (got ${redFlagCar.speed.toFixed(1)})`);
assert(redFlagMsgs.telemetry && redFlagMsgs.telemetry.brake > 0,
  'RED produce frenata in telemetria');
assert(redFlagMsgs.telemetry && redFlagMsgs.telemetry.drs === false,
  'RED disattiva il DRS');

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
  'RED sospende la gara: auto ferma dopo la frenata');

const checkeredFlagCar = new Car({
  teamId: 'mclaren',
  carId: 4,
  driver: 'L. Norris',
  pitStrategy: [],
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
  `CHECKERED chiude la gara al lap finale (state=${checkeredFlagCar.fsm.state})`);
assert(checkeredMsgs.state && checkeredMsgs.state.state === 'FINISHED',
  'CHECKERED produce lo state FINISHED');

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
  pitStrategy: [1],
  rng: createCarPrng(1301, 16),
  config: combinedConfig,
});
pitUnderScCar.startRace(1, ctx.timestamp);
pitUnderScCar.lap = 1;
pitUnderScCar.trackPos = combinedConfig.pitEntryPos;
pitUnderScCar.speed = 60;
const scPitEntryMsgs = pitUnderScCar.tick(0.25, {
  raceId: 1,
  timestamp: new Date().toISOString(),
  totalLaps: 15,
  checkeredActive: false,
  activeFlag: 'GREEN',
});
assert(scPitEntryMsgs.state && scPitEntryMsgs.state.state === 'PIT',
  'scheduled pit enters PIT before Safety Car phase');
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
  pitStrategy: [],
  rng: createCarPrng(1302, 44),
  config: combinedConfig,
});
redPitCar.startRace(1, ctx.timestamp);
redPitCar.fsm = { state: 'PIT', previousState: 'RUNNING', reason: 'scheduled-pit' };
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
// TEST 2: 10 auto — 40 tick (10 secondi simulati)
// ============================================================

section('TEST 2: 10 auto — 40 tick (10 secondi simulati)');

const mockPub = new MockPublisher();
const multiConfig = { ...config, seed: 12345, totalLaps: 15 };

const orchestrator = new Orchestrator({
  roster,
  config: multiConfig,
  publisher: mockPub,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

// startRace manuale (normalmente fatto in start(), qui lo facciamo a mano per controllare)
const ts = new Date().toISOString();
for (const c of orchestrator.cars) {
  const startMsgs = c.startRace(1, ts);
  mockPub.publishCarMessages(startMsgs);
}

console.log(`  Auto nel roster: ${orchestrator.cars.length}`);
assert(orchestrator.cars.length === 10, `10 auto create (got ${orchestrator.cars.length})`);

// Simula 40 tick manuali
const multiCtx = {
  raceId: 1,
  timestamp: ts,
  totalLaps: 15,
  checkeredActive: false,
  leaderLap: 0,
};

const startTelemetryCount = mockPub.telemetry.length;

for (let i = 0; i < 40; i++) {
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
console.log(`  Telemetria 10 auto × 40 tick: ${multiTelemetryCount} campioni`);

// Ogni auto non terminale produce 1 telemetria per tick
// Consideriamo che tutte sono RUNNING (nessuna RETIRED in 40 tick)
assert(multiTelemetryCount >= 350, `Almeno 350 campioni (10×40 - margine FAULT): got ${multiTelemetryCount}`);
assert(multiTelemetryCount <= 400, `Max 400 campioni: got ${multiTelemetryCount}`);

// Velocita' diverse tra le auto (variabilita' per-car)
const car1Speeds = [];
const car2Speeds = [];
for (const t of mockPub.telemetry.slice(startTelemetryCount)) {
  if (t.carId === 16) car1Speeds.push(t.speed);
  if (t.carId === 44) car2Speeds.push(t.speed);
}

if (car1Speeds.length > 0 && car2Speeds.length > 0) {
  const avg1 = car1Speeds.reduce((a, b) => a + b, 0) / car1Speeds.length;
  const avg2 = car2Speeds.reduce((a, b) => a + b, 0) / car2Speeds.length;
  console.log(`  Velocita media Car#16 (Ferrari): ${avg1.toFixed(1)} km/h`);
  console.log(`  Velocita media Car#44 (Mercedes): ${avg2.toFixed(1)} km/h`);
  assert(Math.abs(avg1 - avg2) > 0.1, `Velocita medie diverse tra auto (diff=${Math.abs(avg1 - avg2).toFixed(2)})`);
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
console.log('  Velocita medie per team:', Object.entries(teamAvgs)
  .sort(([,a], [,b]) => b - a)
  .map(([t, v]) => `${t}=${v.toFixed(1)}`)
  .join(', '));

// Fuel diverso tra le auto (usiamo lo stato interno, non la telemetria arrotondata)
const rawFuels = orchestrator.cars.map(c => c.fuel);
const uniqueRawFuels = new Set(rawFuels.map(f => f.toFixed(4)));
console.log(`  Fuel range: ${Math.min(...rawFuels).toFixed(4)} - ${Math.max(...rawFuels).toFixed(4)} kg`);
assert(uniqueRawFuels.size > 1, `Fuel diverso tra auto: ${uniqueRawFuels.size} valori unici`);

// ============================================================
// TEST 3: Verifica schema compliance su tutti i campioni
// ============================================================

section('TEST 3: Schema compliance');

let schemaErrors = 0;
for (const t of mockPub.telemetry) {
  for (const field of REQUIRED_FIELDS) {
    if (t[field] === undefined) {
      schemaErrors++;
      console.error(`  Schema error: campo '${field}' mancante in car ${t.carId}`);
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
console.log(`  Campioni verificati: ${mockPub.telemetry.length}`);
assert(schemaErrors === 0, `Nessun errore di schema (${schemaErrors} trovati)`);

// ============================================================
// TEST 4: Verifica eventi state-change prodotti
// ============================================================

section('TEST 4: Eventi e transizioni');

const stateChanges = mockPub.events.filter(e => e.type === 'state-change');
console.log(`  State changes: ${stateChanges.length}`);
assert(stateChanges.length >= 10, `Almeno 10 state-change (INIT→RUNNING per ciascuna): got ${stateChanges.length}`);

// Tutti gli state-change hanno from e to
for (const sc of stateChanges) {
  assert(sc.details && sc.details.from, `state-change ha from: ${JSON.stringify(sc.details)}`);
  assert(sc.details && sc.details.to, `state-change ha to: ${JSON.stringify(sc.details)}`);
}

// ============================================================
// RISULTATO
// ============================================================

section('RISULTATO');

console.log(`  ✓ Passati: ${passed}`);
console.log(`  ✗ Falliti: ${failed}`);
console.log();

if (failed > 0) {
  console.error('❌ TEST FALLITI!');
  process.exit(1);
} else {
  console.log('✅ TUTTI I TEST PASSATI!');
  process.exit(0);
}
