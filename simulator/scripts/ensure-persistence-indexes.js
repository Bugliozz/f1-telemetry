const { MongoClient } = require('mongodb');
const { ensurePersistenceIndexes } = require('../src/persistence/telemetry-store');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'f1_telemetry';
const TELEMETRY_TTL_SECONDS = process.env.TELEMETRY_TTL_SECONDS;

async function main() {
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });

  try {
    await client.connect();
    const result = await ensurePersistenceIndexes(client.db(DB_NAME), {
      telemetryTtlSeconds: TELEMETRY_TTL_SECONDS,
    });
    console.log(`[persistence-indexes] OK db=${DB_NAME} telemetryTtlSeconds=${result.telemetryTtlSeconds}`);
  } catch (err) {
    console.error('[persistence-indexes] error:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
