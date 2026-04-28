// MongoDB schema/index checks for Phase 2.
// Requires a running MongoDB container initialized by docker compose.

const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'f1_telemetry';
const RACE_ID = parseInt(process.env.TEST_RACE_ID || process.env.RACE_ID || '902', 10);

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  OK   ${label}`);
  passed++;
}

function fail(label, err) {
  console.error(`  FAIL ${label}: ${err.message}`);
  failed++;
}

function sameKey(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasIndex(indexes, key, unique) {
  return indexes.some((idx) => {
    if (!sameKey(idx.key, key)) return false;
    if (unique == null) return true;
    return Boolean(idx.unique) === Boolean(unique);
  });
}

async function expectReject(label, fn) {
  try {
    await fn();
    fail(label, new Error('operation unexpectedly succeeded'));
  } catch (err) {
    ok(label);
  }
}

async function cleanup(db) {
  await Promise.all([
    db.collection('telemetry').deleteMany({ raceId: RACE_ID }),
    db.collection('events').deleteMany({ raceId: RACE_ID }),
    db.collection('states').deleteMany({ raceId: RACE_ID }),
    db.collection('classifications').deleteMany({ raceId: RACE_ID }),
    db.collection('race_control').deleteMany({ raceId: RACE_ID }),
  ]);
}

async function main() {
  console.log(`=== MongoDB Phase 2 test (${MONGO_URL}, db=${DB_NAME}, raceId=${RACE_ID}) ===`);

  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    ok('connected to MongoDB');

    const db = client.db(DB_NAME);
    await cleanup(db);

    const expectedCollections = ['telemetry', 'events', 'states', 'classifications', 'race_control'];
    const collectionInfos = await db.listCollections().toArray();
    const collectionByName = new Map(collectionInfos.map((info) => [info.name, info]));

    for (const name of expectedCollections) {
      if (collectionByName.has(name)) ok(`collection ${name} exists`);
      else fail(`collection ${name} exists`, new Error('missing collection'));

      const info = collectionByName.get(name);
      if (info && info.options && info.options.validator) ok(`collection ${name} has validator`);
      else fail(`collection ${name} has validator`, new Error('missing validator'));
    }

    const expectedIndexes = {
      telemetry: [
        { key: { raceId: 1, carId: 1, timestamp: -1 } },
        { key: { raceId: 1, lap: 1 } },
        { key: { raceId: 1, teamId: 1, carId: 1, lap: 1 } },
      ],
      events: [
        { key: { raceId: 1, carId: 1, timestamp: -1 } },
        { key: { raceId: 1, type: 1, timestamp: -1 } },
      ],
      states: [
        { key: { raceId: 1, carId: 1 }, unique: true },
      ],
      classifications: [
        { key: { raceId: 1 }, unique: true },
      ],
      race_control: [
        { key: { raceId: 1, timestamp: -1 } },
        { key: { raceId: 1, flag: 1, timestamp: -1 } },
      ],
    };

    for (const [name, expected] of Object.entries(expectedIndexes)) {
      const indexes = await db.collection(name).indexes();
      for (const idx of expected) {
        if (hasIndex(indexes, idx.key, idx.unique)) ok(`${name} index ${JSON.stringify(idx.key)}`);
        else fail(`${name} index ${JSON.stringify(idx.key)}`, new Error('missing index'));
      }
    }

    const timestamp = new Date();
    await db.collection('telemetry').insertOne({
      timestamp,
      raceId: RACE_ID,
      teamId: 'ferrari',
      carId: 16,
      lap: 1,
      trackPos: 0.25,
      speed: 250,
      rpm: 11000,
      gear: 6,
      throttle: 0.8,
      brake: 0,
      drs: true,
      tireTemp: { fl: 95, fr: 96, rl: 98, rr: 99 },
      fuel: 80,
      state: 'RUNNING',
    });
    ok('valid telemetry insert accepted');

    await expectReject('invalid telemetry insert rejected', async () => {
      await db.collection('telemetry').insertOne({ raceId: RACE_ID });
    });

    await db.collection('events').insertOne({
      timestamp,
      raceId: RACE_ID,
      teamId: 'ferrari',
      carId: 16,
      type: 'state-change',
      details: { from: 'INIT', to: 'RUNNING', reason: 'mongo-test' },
    });
    ok('valid event insert accepted');

    const stateDoc = {
      timestamp,
      raceId: RACE_ID,
      teamId: 'ferrari',
      carId: 16,
      state: 'RUNNING',
      previousState: 'INIT',
      reason: 'mongo-test',
    };
    await db.collection('states').insertOne(stateDoc);
    ok('valid state insert accepted');
    await expectReject('states unique index rejects duplicate car', async () => {
      await db.collection('states').insertOne({ ...stateDoc, timestamp: new Date() });
    });

    const classificationDoc = {
      timestamp,
      raceId: RACE_ID,
      lap: 1,
      leaderLap: 1,
      standings: [
        { position: 1, carId: 16, teamId: 'ferrari', lap: 1, gap: 0, state: 'RUNNING' },
      ],
    };
    await db.collection('classifications').insertOne(classificationDoc);
    ok('valid classification insert accepted');
    await expectReject('classifications unique index rejects duplicate race', async () => {
      await db.collection('classifications').insertOne({ ...classificationDoc, timestamp: new Date() });
    });

    await db.collection('race_control').insertOne({
      timestamp,
      raceId: RACE_ID,
      flag: 'GREEN',
      active: true,
      sector: null,
      reason: 'mongo-test',
    });
    ok('valid race_control insert accepted');
  } catch (err) {
    fail('mongo schema test', err);
  } finally {
    try {
      await cleanup(client.db(DB_NAME));
    } catch (err) {
      fail('cleanup', err);
    }
    await client.close();
  }

  console.log(`\n=== Result: ${passed} OK, ${failed} FAIL ===`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[test-mongo-schema] unhandled error:', err.message);
  process.exitCode = 1;
});
