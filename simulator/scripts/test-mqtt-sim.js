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
