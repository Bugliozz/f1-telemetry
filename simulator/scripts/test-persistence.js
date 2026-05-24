const assert = require('assert');
const {
  assertTelemetryConsistency,
  buildFuelTireTrendPipeline,
  buildLapTimesPipeline,
  bulkInsertTelemetry,
  ensurePersistenceIndexes,
  findTelemetryConsistencyErrors,
  normalizeTelemetryDocument,
} = require('../src/persistence/telemetry-store');
const {
  RUNTIME_COLLECTIONS,
  resetRaceData,
} = require('../src/persistence/race-reset');

let passed = 0;
let failed = 0;

function sampleTelemetry(overrides = {}) {
  return {
    timestamp: '2026-04-27T14:32:10.512Z',
    raceId: 1,
    teamId: 'ferrari',
    carId: 16,
    lap: 3,
    trackPos: 0.42,
    speed: 287.4,
    rpm: 11800,
    gear: 7,
    throttle: 0.92,
    brake: 0,
    drs: true,
    tireTemp: { fl: 102.1, fr: 99.8, rl: 105.3, rr: 104.7 },
    fuel: 38.2,
    compound: 'medium',
    state: 'RUNNING',
    ...overrides,
  };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

function hasIndexCall(calls, collection, key, predicate) {
  return calls.some((call) => {
    try {
      assert.deepStrictEqual(call.collection, collection);
      assert.deepStrictEqual(call.key, key);
      if (predicate) predicate(call.options || {});
      return true;
    } catch (err) {
      return false;
    }
  });
}

async function main() {
  console.log('=== Persistence layer test ===');

  await test('normalizes MQTT telemetry payload into MongoDB document', () => {
    const payload = sampleTelemetry();
    const original = JSON.stringify(payload);
    const doc = normalizeTelemetryDocument(payload);

    assert.ok(doc.timestamp instanceof Date);
    assert.strictEqual(doc.timestamp.toISOString(), payload.timestamp);
    assert.deepStrictEqual(doc.tireTemp, payload.tireTemp);
    assert.strictEqual(JSON.stringify(payload), original);
  });

  await test('bulk insert uses insertMany unordered writes', async () => {
    const payloads = [
      sampleTelemetry({ carId: 16 }),
      sampleTelemetry({ carId: 55, timestamp: '2026-04-27T14:32:10.762Z' }),
    ];
    const fakeCollection = {
      async insertMany(docs, options) {
        assert.strictEqual(docs.length, 2);
        assert.ok(docs[0].timestamp instanceof Date);
        assert.strictEqual(options.ordered, false);
        return { insertedCount: docs.length, insertedIds: { 0: 'a', 1: 'b' } };
      },
    };

    const result = await bulkInsertTelemetry(fakeCollection, payloads);
    assert.strictEqual(result.insertedCount, 2);
  });

  await test('consistency check allows only timestamp Date conversion and _id', () => {
    const payload = sampleTelemetry();
    const document = {
      _id: 'mongo-id',
      ...payload,
      timestamp: new Date(payload.timestamp),
    };

    assert.deepStrictEqual(findTelemetryConsistencyErrors(payload, document), []);
    assert.doesNotThrow(() => assertTelemetryConsistency(payload, document));

    const mismatched = { ...document, fuel: 37.9 };
    assert.throws(() => assertTelemetryConsistency(payload, mismatched), /fuel mismatch/);

    const extraField = { ...document, source: 'node-red' };
    assert.deepStrictEqual(
      findTelemetryConsistencyErrors(payload, extraField),
      ['unexpected document field: source']
    );
  });

  await test('builds lap-time historical query from events', () => {
    const pipeline = buildLapTimesPipeline({ raceId: 1, carId: 16, limit: 5 });

    assert.deepStrictEqual(pipeline[0], {
      $match: {
        raceId: 1,
        type: 'lap-completed',
        'details.lap': { $type: 'number' },
        'details.lapTime': { $type: 'number' },
        carId: 16,
      },
    });
    assert.deepStrictEqual(pipeline[1].$project.lap, '$details.lap');
    assert.deepStrictEqual(pipeline[pipeline.length - 1], { $limit: 5 });
  });

  await test('builds fuel/tire trend query from telemetry', () => {
    const pipeline = buildFuelTireTrendPipeline({
      raceId: 1,
      carId: 16,
      lap: 3,
      from: '2026-04-27T14:32:00.000Z',
      to: '2026-04-27T14:33:00.000Z',
      bucketSeconds: 10,
      limit: 20,
    });

    assert.strictEqual(pipeline[0].$match.raceId, 1);
    assert.strictEqual(pipeline[0].$match.carId, 16);
    assert.strictEqual(pipeline[0].$match.lap, 3);
    assert.ok(pipeline[0].$match.timestamp.$gte instanceof Date);
    assert.ok(pipeline.some((stage) => stage.$group && stage.$group.avgFuel));
    assert.deepStrictEqual(pipeline[pipeline.length - 1], { $limit: 20 });
  });

  await test('ensures persistence indexes and telemetry TTL', async () => {
    const calls = [];
    const fakeDb = {
      collection(collection) {
        return {
          async createIndex(key, options) {
            calls.push({ collection, key, options });
            return JSON.stringify(key);
          },
        };
      },
    };

    const result = await ensurePersistenceIndexes(fakeDb, { telemetryTtlSeconds: 123 });
    assert.strictEqual(result.telemetryTtlSeconds, 123);
    assert.ok(hasIndexCall(calls, 'telemetry', { raceId: 1, carId: 1, lap: 1, timestamp: 1 }));
    assert.ok(hasIndexCall(calls, 'events', { raceId: 1, type: 1, carId: 1, 'details.lap': 1 }));
    assert.ok(hasIndexCall(calls, 'telemetry', { timestamp: 1 }, (options) => {
      assert.strictEqual(options.expireAfterSeconds, 123);
    }));
  });

  await test('resets race-scoped runtime collections before a new start', async () => {
    const calls = [];
    const fakeClient = {
      async connect() {},
      db(dbName) {
        assert.strictEqual(dbName, 'f1_telemetry');
        return {
          collection(collection) {
            return {
              async deleteMany(query) {
                calls.push({ collection, query });
                return { deletedCount: collection.length };
              },
            };
          },
        };
      },
      async close() {},
    };

    const result = await resetRaceData({
      mongoUrl: 'mongodb://example:27017',
      dbName: 'f1_telemetry',
      raceId: 7,
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      clientFactory() {
        return fakeClient;
      },
    });

    assert.deepStrictEqual(
      calls.map((call) => call.collection).sort(),
      [...RUNTIME_COLLECTIONS].sort(),
    );
    for (const call of calls) {
      assert.deepStrictEqual(call.query, { raceId: 7 });
    }
    assert.strictEqual(result.raceId, 7);
    assert.strictEqual(result.totalDeleted, calls.reduce((sum, call) => sum + call.collection.length, 0));
  });

  console.log(`\n=== Result: ${passed} OK, ${failed} FAIL ===`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[test-persistence] unhandled error:', err.message);
  process.exitCode = 1;
});
