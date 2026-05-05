const { MongoClient } = require('mongodb');

const RUNTIME_COLLECTIONS = Object.freeze([
  'telemetry',
  'events',
  'states',
  'classifications',
  'race_control',
]);

function noopLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

async function resetRaceData(options) {
  const {
    mongoUrl,
    dbName = 'f1_telemetry',
    raceId,
    logger = noopLogger(),
    collections = RUNTIME_COLLECTIONS,
    clientFactory = (url, clientOptions) => new MongoClient(url, clientOptions),
  } = options || {};

  const numericRaceId = Number(raceId);
  if (!Number.isInteger(numericRaceId) || numericRaceId < 1) {
    throw new Error(`invalid raceId ${raceId}`);
  }
  if (!mongoUrl) {
    throw new Error('MONGO_URL is required when RESET_RACE_ON_START=true');
  }

  const client = clientFactory(mongoUrl, {
    serverSelectionTimeoutMS: 5000,
  });

  const deleted = {};
  try {
    await client.connect();
    const db = client.db(dbName);

    await Promise.all(collections.map(async (name) => {
      const result = await db.collection(name).deleteMany({ raceId: numericRaceId });
      deleted[name] = result.deletedCount || 0;
    }));

    const totalDeleted = Object.values(deleted).reduce((sum, count) => sum + count, 0);
    logger.info(`[RaceReset] Puliti ${totalDeleted} documenti da ${dbName} per raceId=${numericRaceId}`);

    return {
      dbName,
      raceId: numericRaceId,
      deleted,
      totalDeleted,
    };
  } finally {
    await client.close();
  }
}

module.exports = {
  RUNTIME_COLLECTIONS,
  resetRaceData,
};
