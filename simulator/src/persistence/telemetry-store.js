const DEFAULT_TELEMETRY_TTL_SECONDS = 30 * 24 * 60 * 60;

const TELEMETRY_REQUIRED_FIELDS = [
  'timestamp',
  'raceId',
  'teamId',
  'carId',
  'lap',
  'trackPos',
  'speed',
  'rpm',
  'gear',
  'throttle',
  'brake',
  'drs',
  'tireTemp',
  'fuel',
  'compound',
  'state',
];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function asPositiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function asOptionalPositiveInteger(value, label) {
  if (value == null || value === '') return null;
  return asPositiveInteger(value, label);
}

function asOptionalInteger(value, label) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

function asOptionalDate(value, label) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

function stableJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}';
}

function normalizeTelemetryDocument(payload) {
  if (!isPlainObject(payload)) {
    throw new Error('telemetry payload must be an object');
  }

  for (const field of TELEMETRY_REQUIRED_FIELDS) {
    if (payload[field] === undefined) {
      throw new Error(`telemetry payload missing required field: ${field}`);
    }
  }

  const timestamp = asOptionalDate(payload.timestamp, 'timestamp');
  if (!timestamp) {
    throw new Error('timestamp must be a valid date');
  }

  const doc = { ...payload, timestamp };
  doc.raceId = asPositiveInteger(doc.raceId, 'raceId');
  doc.carId = asPositiveInteger(doc.carId, 'carId');

  if (!isPlainObject(doc.tireTemp)) {
    throw new Error('tireTemp must be an object');
  }
  doc.tireTemp = { ...doc.tireTemp };

  return doc;
}

function normalizeTelemetryBatch(payloads) {
  if (!Array.isArray(payloads)) {
    throw new Error('telemetry batch must be an array');
  }
  return payloads.map(normalizeTelemetryDocument);
}

async function bulkInsertTelemetry(collection, payloads, options = {}) {
  if (!collection || typeof collection.insertMany !== 'function') {
    throw new Error('collection must expose insertMany');
  }

  const docs = normalizeTelemetryBatch(payloads);
  if (docs.length === 0) {
    return { insertedCount: 0, insertedIds: {} };
  }

  return collection.insertMany(docs, {
    ordered: false,
    ...options,
  });
}

function findTelemetryConsistencyErrors(payload, document) {
  const errors = [];
  let expected;
  let actual;

  try {
    expected = normalizeTelemetryDocument(payload);
  } catch (err) {
    return [`invalid payload: ${err.message}`];
  }

  try {
    actual = normalizeTelemetryDocument(document);
  } catch (err) {
    return [`invalid document: ${err.message}`];
  }

  const allowedExtraFields = new Set(['_id']);
  for (const field of Object.keys(document || {})) {
    if (!Object.prototype.hasOwnProperty.call(payload, field) && !allowedExtraFields.has(field)) {
      errors.push(`unexpected document field: ${field}`);
    }
  }

  for (const field of Object.keys(payload)) {
    if (field === 'timestamp') {
      if (expected.timestamp.toISOString() !== actual.timestamp.toISOString()) {
        errors.push('timestamp mismatch');
      }
      continue;
    }
    if (stableJson(expected[field]) !== stableJson(actual[field])) {
      errors.push(`${field} mismatch`);
    }
  }

  return errors;
}

function assertTelemetryConsistency(payload, document) {
  const errors = findTelemetryConsistencyErrors(payload, document);
  if (errors.length > 0) {
    throw new Error(`telemetry document mismatch: ${errors.join(', ')}`);
  }
}

function buildLapTimesPipeline(params = {}) {
  const raceId = asPositiveInteger(params.raceId, 'raceId');
  const carId = asOptionalPositiveInteger(params.carId, 'carId');
  const limit = asOptionalPositiveInteger(params.limit, 'limit');

  const match = {
    raceId,
    type: 'lap-completed',
    'details.lap': { $type: 'number' },
    'details.lapTime': { $type: 'number' },
  };
  if (carId != null) match.carId = carId;

  const pipeline = [
    { $match: match },
    {
      $project: {
        _id: 0,
        timestamp: 1,
        raceId: 1,
        teamId: 1,
        carId: 1,
        lap: '$details.lap',
        lapTime: '$details.lapTime',
      },
    },
    { $sort: { carId: 1, lap: 1, timestamp: 1 } },
  ];

  if (limit != null) pipeline.push({ $limit: limit });
  return pipeline;
}

function buildFuelTireTrendPipeline(params = {}) {
  const raceId = asPositiveInteger(params.raceId, 'raceId');
  const carId = asOptionalPositiveInteger(params.carId, 'carId');
  const lap = asOptionalInteger(params.lap, 'lap');
  const from = asOptionalDate(params.from, 'from');
  const to = asOptionalDate(params.to, 'to');
  const limit = asOptionalPositiveInteger(params.limit, 'limit');
  const bucketSeconds = params.bucketSeconds == null
    ? 5
    : asOptionalPositiveInteger(params.bucketSeconds, 'bucketSeconds');

  const match = { raceId };
  if (carId != null) match.carId = carId;
  if (lap != null) match.lap = lap;
  if (from || to) {
    match.timestamp = {};
    if (from) match.timestamp.$gte = from;
    if (to) match.timestamp.$lte = to;
  }

  const avgTireTemp = {
    $avg: ['$tireTemp.fl', '$tireTemp.fr', '$tireTemp.rl', '$tireTemp.rr'],
  };

  const pipeline = [
    { $match: match },
    { $sort: { timestamp: 1, carId: 1 } },
  ];

  if (bucketSeconds && bucketSeconds > 0) {
    pipeline.push(
      {
        $project: {
          raceId: 1,
          carId: 1,
          lap: 1,
          timestamp: 1,
          trackPos: 1,
          fuel: 1,
          avgTireTemp,
          bucket: {
            $dateTrunc: {
              date: '$timestamp',
              unit: 'second',
              binSize: bucketSeconds,
            },
          },
        },
      },
      {
        $group: {
          _id: {
            raceId: '$raceId',
            carId: '$carId',
            lap: '$lap',
            bucket: '$bucket',
          },
          timestamp: { $first: '$bucket' },
          raceId: { $first: '$raceId' },
          carId: { $first: '$carId' },
          lap: { $first: '$lap' },
          avgTrackPos: { $avg: '$trackPos' },
          avgFuel: { $avg: '$fuel' },
          avgTireTemp: { $avg: '$avgTireTemp' },
          samples: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          timestamp: 1,
          raceId: 1,
          carId: 1,
          lap: 1,
          avgTrackPos: { $round: ['$avgTrackPos', 5] },
          avgFuel: { $round: ['$avgFuel', 3] },
          avgTireTemp: { $round: ['$avgTireTemp', 3] },
          samples: 1,
        },
      },
      { $sort: { carId: 1, timestamp: 1, lap: 1 } }
    );
  } else {
    pipeline.push(
      {
        $project: {
          _id: 0,
          timestamp: 1,
          raceId: 1,
          carId: 1,
          lap: 1,
          trackPos: 1,
          fuel: 1,
          tireTemp: 1,
          avgTireTemp,
        },
      },
      { $sort: { carId: 1, timestamp: 1, lap: 1 } }
    );
  }

  if (limit != null) pipeline.push({ $limit: limit });
  return pipeline;
}

async function getLapTimes(db, params) {
  return db.collection('events').aggregate(buildLapTimesPipeline(params)).toArray();
}

async function getFuelTireTrend(db, params) {
  return db.collection('telemetry').aggregate(buildFuelTireTrendPipeline(params)).toArray();
}

function getTelemetryTtlSeconds(value) {
  if (value == null || value === '') return DEFAULT_TELEMETRY_TTL_SECONDS;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error('telemetry TTL must be a positive integer of seconds');
  }
  return ttl;
}

async function ensurePersistenceIndexes(db, options = {}) {
  const telemetryTtlSeconds = getTelemetryTtlSeconds(options.telemetryTtlSeconds);

  await db.collection('telemetry').createIndex({ raceId: 1, carId: 1, timestamp: -1 });
  await db.collection('telemetry').createIndex({ raceId: 1, lap: 1 });
  await db.collection('telemetry').createIndex({ raceId: 1, teamId: 1, carId: 1, lap: 1 });
  await db.collection('telemetry').createIndex({ raceId: 1, carId: 1, lap: 1, timestamp: 1 });
  await db.collection('telemetry').createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: telemetryTtlSeconds }
  );

  await db.collection('events').createIndex({ raceId: 1, carId: 1, timestamp: -1 });
  await db.collection('events').createIndex({ raceId: 1, type: 1, timestamp: -1 });
  await db.collection('events').createIndex({ raceId: 1, type: 1, carId: 1, 'details.lap': 1 });

  return { telemetryTtlSeconds };
}

module.exports = {
  DEFAULT_TELEMETRY_TTL_SECONDS,
  TELEMETRY_REQUIRED_FIELDS,
  normalizeTelemetryDocument,
  normalizeTelemetryBatch,
  bulkInsertTelemetry,
  findTelemetryConsistencyErrors,
  assertTelemetryConsistency,
  buildLapTimesPipeline,
  buildFuelTireTrendPipeline,
  getLapTimes,
  getFuelTireTrend,
  getTelemetryTtlSeconds,
  ensurePersistenceIndexes,
};
