const { MongoClient } = require('mongodb');
const {
  getFuelTireTrend,
  getLapTimes,
} = require('../src/persistence/telemetry-store');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'f1_telemetry';

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

async function main() {
  const raceId = intEnv('RACE_ID', 1);
  const carId = intEnv('CAR_ID', null);
  const lap = intEnv('LAP', null);
  const bucketSeconds = intEnv('BUCKET_SECONDS', 5);
  const limit = intEnv('LIMIT', 20);

  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const [lapTimes, fuelTireTrend] = await Promise.all([
      getLapTimes(db, { raceId, carId, limit }),
      getFuelTireTrend(db, { raceId, carId, lap, bucketSeconds, limit }),
    ]);

    console.log(JSON.stringify({
      raceId,
      carId,
      lap,
      bucketSeconds,
      lapTimes,
      fuelTireTrend,
    }, null, 2));
  } catch (err) {
    console.error('[query-history] error:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
