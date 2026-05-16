/**
 * Seed - Fase 2
 * Popola MongoDB con dati di esempio coerenti con i $jsonSchema validator.
 *
 *   - 5 teams x 2 cars = 10 entries (Monza, race 1)
 *   - ~50 telemetry samples per car, over ~2 laps
 *   - 1 FSM state per car
 *   - alcuni eventi tipici (lap-completed, pit-stop, state-change)
 *   - 1 current classification
 *   - 1 race-control event (initial green flag)
 *
 * Uso:
 *   node simulator/scripts/seed.js
 *   MONGO_URL=mongodb://localhost:27017 node simulator/scripts/seed.js
 *   RACE_ID=2 node simulator/scripts/seed.js   # different race
 */

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'f1_telemetry';
const RACE_ID = parseInt(process.env.RACE_ID || '1', 10);
const SAMPLES_PER_CAR = parseInt(process.env.SAMPLES_PER_CAR || '50', 10);
const SAMPLE_INTERVAL_MS = 250;

const ROSTER = [
  { teamId: 'ferrari',  carId: 16 },
  { teamId: 'ferrari',  carId: 55 },
  { teamId: 'mercedes', carId: 44 },
  { teamId: 'mercedes', carId: 63 },
  { teamId: 'redbull',  carId: 1  },
  { teamId: 'redbull',  carId: 11 },
  { teamId: 'mclaren',  carId: 4  },
  { teamId: 'mclaren',  carId: 81 },
  { teamId: 'alpine',   carId: 10 },
  { teamId: 'alpine',   carId: 31 },
];

const FSM_STATES = ['INIT', 'RUNNING', 'PIT', 'FAULT', 'RETIRED', 'FINISHED'];

// Avanzamento di un campione lungo il giro: usa parametri stabili per
// rendere il dataset deterministico ma realistico.
function buildTelemetrySamples(car, baseTime) {
  const samples = [];
  // Slightly different average speed per car -> non-trivial classification.
  const speedBias = ((car.carId * 7) % 13) - 6; // -6..+6
  let lap = 1;
  let trackPos = 0;
  for (let i = 0; i < SAMPLES_PER_CAR; i++) {
    const t = new Date(baseTime.getTime() + i * SAMPLE_INTERVAL_MS);
    // Speed profile with two Monza corners (Lesmo + Parabolica).
    const phase = trackPos * Math.PI * 2;
    const speed = 240 + speedBias + 50 * Math.sin(phase) + 8 * Math.cos(phase * 3);
    const throttle = Math.max(0, Math.min(1, 0.7 + 0.3 * Math.sin(phase)));
    const brake = Math.max(0, Math.min(1, -Math.sin(phase) * 0.4));
    const rpm = Math.round(7000 + speed * 22);
    const gear = Math.max(1, Math.min(7, Math.round(speed / 50)));
    const tireBase = 95 + i * 0.05;
    samples.push({
      timestamp: t,
      raceId: RACE_ID,
      teamId: car.teamId,
      carId: car.carId,
      lap,
      trackPos: Number(trackPos.toFixed(4)),
      speed: Number(speed.toFixed(2)),
      rpm,
      gear,
      throttle: Number(throttle.toFixed(3)),
      brake: Number(brake.toFixed(3)),
      drs: phase > Math.PI && phase < Math.PI * 1.4,
      tireTemp: {
        fl: Number((tireBase + 1.2).toFixed(2)),
        fr: Number((tireBase - 0.4).toFixed(2)),
        rl: Number((tireBase + 2.1).toFixed(2)),
        rr: Number((tireBase + 1.7).toFixed(2)),
      },
      fuel: Number((100 - i * 0.4).toFixed(2)),
      state: 'RUNNING',
    });
    // Avanza la posizione sul giro; quando supera 1, incrementa il giro.
    trackPos += 0.04 + (speedBias + 6) * 0.0005;
    if (trackPos >= 1) {
      trackPos -= 1;
      lap += 1;
    }
  }
  return samples;
}

function buildEvents(car, baseTime) {
  const events = [];
  // Race start: state-change INIT -> RUNNING.
  events.push({
    timestamp: new Date(baseTime.getTime() - 1000),
    raceId: RACE_ID,
    teamId: car.teamId,
    carId: car.carId,
    type: 'state-change',
    details: { from: 'INIT', to: 'RUNNING', reason: 'race-start' },
  });
  // Lap completed a meta dataset.
  events.push({
    timestamp: new Date(baseTime.getTime() + 25 * SAMPLE_INTERVAL_MS),
    raceId: RACE_ID,
    teamId: car.teamId,
    carId: car.carId,
    type: 'lap-completed',
    details: { lap: 1, lapTime: 84.5 + (car.carId % 5) * 0.3 },
  });
  // Per una sola auto simuliamo un pit-stop, per dare varieta al dataset.
  if (car.carId === 16) {
    events.push({
      timestamp: new Date(baseTime.getTime() + 30 * SAMPLE_INTERVAL_MS),
      raceId: RACE_ID,
      teamId: car.teamId,
      carId: car.carId,
      type: 'pit-stop',
      details: { duration: 2.4, tyreCompound: 'soft', fuelAdded: 25 },
    });
  }
  return events;
}

function buildState(car, baseTime) {
  return {
    timestamp: new Date(baseTime.getTime() + SAMPLES_PER_CAR * SAMPLE_INTERVAL_MS),
    raceId: RACE_ID,
    teamId: car.teamId,
    carId: car.carId,
    state: 'RUNNING',
    previousState: 'INIT',
    reason: 'race-start',
  };
}

function buildClassification(baseTime) {
  // Ordina per (lap desc, gap asc) - qui per semplicita usiamo l'ordine
  // del roster con un piccolo gap progressivo.
  const standings = ROSTER.map((car, idx) => ({
    position: idx + 1,
    carId: car.carId,
    teamId: car.teamId,
    lap: 2,
    gap: Number((idx * 1.337).toFixed(3)),
    state: 'RUNNING',
  }));
  return {
    timestamp: new Date(baseTime.getTime() + SAMPLES_PER_CAR * SAMPLE_INTERVAL_MS),
    raceId: RACE_ID,
    lap: 2,
    leaderLap: 2,
    standings,
  };
}

function buildRaceStartFlag(baseTime) {
  return {
    timestamp: new Date(baseTime.getTime() - 2000),
    raceId: RACE_ID,
    flag: 'GREEN',
    active: true,
    sector: null,
    reason: 'race-start',
  };
}

async function main() {
  console.log(`[seed] Connessione a ${MONGO_URL} (db=${DB_NAME}, raceId=${RACE_ID})`);
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const baseTime = new Date();

    // Pulisce solo i documenti relativi a questo RACE_ID (idempotente).
    await Promise.all([
      db.collection('telemetry').deleteMany({ raceId: RACE_ID }),
      db.collection('events').deleteMany({ raceId: RACE_ID }),
      db.collection('states').deleteMany({ raceId: RACE_ID }),
      db.collection('classifications').deleteMany({ raceId: RACE_ID }),
      db.collection('race_control').deleteMany({ raceId: RACE_ID }),
    ]);

    // Telemetry.
    const allTelemetry = ROSTER.flatMap((car) => buildTelemetrySamples(car, baseTime));
    const telemRes = await db.collection('telemetry').insertMany(allTelemetry, { ordered: false });
    console.log(`[seed] telemetry: ${telemRes.insertedCount} documenti`);

    // Eventi.
    const allEvents = ROSTER.flatMap((car) => buildEvents(car, baseTime));
    const evtRes = await db.collection('events').insertMany(allEvents, { ordered: false });
    console.log(`[seed] events: ${evtRes.insertedCount} documenti`);

    // Stati (upsert per (raceId, carId), coerente con indice unique).
    for (const car of ROSTER) {
      const state = buildState(car, baseTime);
      await db.collection('states').updateOne(
        { raceId: RACE_ID, carId: car.carId },
        { $set: state },
        { upsert: true }
      );
    }
    console.log(`[seed] states: ${ROSTER.length} upsert`);

    // Classification (upsert by raceId).
    const classification = buildClassification(baseTime);
    await db.collection('classifications').updateOne(
      { raceId: RACE_ID },
      { $set: classification },
      { upsert: true }
    );
    console.log('[seed] classifications: 1 upsert');

    // Race-control: green flag iniziale.
    const flag = buildRaceStartFlag(baseTime);
    await db.collection('race_control').insertOne(flag);
    console.log('[seed] race_control: 1 event (GREEN)');

    console.log('[seed] OK - dataset pronto per i test della Fase 5.');
  } catch (err) {
    console.error('[seed] error:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
