// Script di inizializzazione MongoDB - F1 Telemetry
// Eseguito automaticamente alla prima creazione del container.
//
// Crea le collection con $jsonSchema validator (dialetto MongoDB, basato su
// Draft-04 con estensioni bsonType) coerenti con i documenti in /schemas.
// Gli indici sono pensati per i pattern di lettura piu' frequenti:
//   - serie temporali per (raceId, carId)
//   - lookup per giro
//   - retain "ultimo valore" per states e classifications.

db = db.getSiblingDB('f1_telemetry');

// ---------------------------------------------------------------------------
// Costanti riusabili nei validator
// ---------------------------------------------------------------------------

const TEAM_ID_PATTERN = '^[a-z][a-z0-9-]{1,31}$';
const FSM_STATES = ['INIT', 'RUNNING', 'PIT', 'FAULT', 'RETIRED', 'FINISHED'];
const FLAG_VALUES = ['GREEN', 'YELLOW', 'RED', 'CHECKERED', 'SC', 'VSC'];
const EVENT_TYPES = [
  'pit-entry', 'pit-stop', 'pit-exit',
  'fault', 'retirement',
  'lap-completed', 'sector-completed',
  'overtake', 'state-change'
];
const DEFAULT_TELEMETRY_TTL_SECONDS = 30 * 24 * 60 * 60;

function envNumber(name, fallback) {
  const raw = (typeof process !== 'undefined' && process.env) ? process.env[name] : null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const TELEMETRY_TTL_SECONDS = envNumber('TELEMETRY_TTL_SECONDS', DEFAULT_TELEMETRY_TTL_SECONDS);

// ---------------------------------------------------------------------------
// telemetry - serie temporale ad alta frequenza (2-5 Hz per auto)
// ---------------------------------------------------------------------------

// Nota sui bsonType: il driver Node.js di MongoDB serializza i Number JS come
// BSON double; usiamo l'alias 'number' (matcha int/long/double/decimal) per
// non rifiutare scritture legittime dal simulator.

db.createCollection('telemetry', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'timestamp', 'raceId', 'teamId', 'carId', 'lap', 'trackPos',
        'speed', 'rpm', 'gear', 'throttle', 'brake', 'drs',
        'tireTemp', 'fuel', 'state'
      ],
      properties: {
        timestamp: { bsonType: 'date' },
        raceId: { bsonType: 'number', minimum: 1 },
        teamId: { bsonType: 'string', pattern: TEAM_ID_PATTERN },
        carId: { bsonType: 'number', minimum: 1, maximum: 99 },
        lap: { bsonType: 'number', minimum: 0 },
        trackPos: { bsonType: 'number', minimum: 0, maximum: 1 },
        speed: { bsonType: 'number', minimum: 0, maximum: 400 },
        rpm: { bsonType: 'number', minimum: 0, maximum: 16000 },
        gear: { bsonType: 'number', minimum: 0, maximum: 8 },
        throttle: { bsonType: 'number', minimum: 0, maximum: 1 },
        brake: { bsonType: 'number', minimum: 0, maximum: 1 },
        drs: { bsonType: 'bool' },
        tireTemp: {
          bsonType: 'object',
          required: ['fl', 'fr', 'rl', 'rr'],
          properties: {
            fl: { bsonType: 'number' },
            fr: { bsonType: 'number' },
            rl: { bsonType: 'number' },
            rr: { bsonType: 'number' }
          }
        },
        fuel: { bsonType: 'number', minimum: 0, maximum: 40 },
        state: { enum: FSM_STATES }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'error'
});
db.telemetry.createIndex({ raceId: 1, carId: 1, timestamp: -1 });
db.telemetry.createIndex({ raceId: 1, lap: 1 });
db.telemetry.createIndex({ raceId: 1, teamId: 1, carId: 1, lap: 1 });
db.telemetry.createIndex({ raceId: 1, carId: 1, lap: 1, timestamp: 1 });
db.telemetry.createIndex({ timestamp: 1 }, { expireAfterSeconds: TELEMETRY_TTL_SECONDS });

// ---------------------------------------------------------------------------
// events - eventi discreti per singola auto (pit stop, fault, retirement...)
// ---------------------------------------------------------------------------

db.createCollection('events', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['timestamp', 'raceId', 'teamId', 'carId', 'type'],
      properties: {
        timestamp: { bsonType: 'date' },
        raceId: { bsonType: 'number', minimum: 1 },
        teamId: { bsonType: 'string', pattern: TEAM_ID_PATTERN },
        carId: { bsonType: 'number', minimum: 1, maximum: 99 },
        type: { enum: EVENT_TYPES },
        details: { bsonType: 'object' }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'error'
});
db.events.createIndex({ raceId: 1, carId: 1, timestamp: -1 });
db.events.createIndex({ raceId: 1, type: 1, timestamp: -1 });
db.events.createIndex({ raceId: 1, type: 1, carId: 1, 'details.lap': 1 });

// ---------------------------------------------------------------------------
// states - ultimo stato FSM per auto (un solo doc per (raceId, carId))
// ---------------------------------------------------------------------------

db.createCollection('states', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['timestamp', 'raceId', 'teamId', 'carId', 'state'],
      properties: {
        timestamp: { bsonType: 'date' },
        raceId: { bsonType: 'number', minimum: 1 },
        teamId: { bsonType: 'string', pattern: TEAM_ID_PATTERN },
        carId: { bsonType: 'number', minimum: 1, maximum: 99 },
        state: { enum: FSM_STATES },
        previousState: {
          oneOf: [
            { enum: FSM_STATES },
            { bsonType: 'null' }
          ]
        },
        reason: {
          oneOf: [
            { bsonType: 'string', maxLength: 128 },
            { bsonType: 'null' }
          ]
        }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'error'
});
db.states.createIndex({ raceId: 1, carId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// classifications - snapshot corrente della classifica per gara
// ---------------------------------------------------------------------------

db.createCollection('classifications', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['timestamp', 'raceId', 'lap', 'leaderLap', 'standings'],
      properties: {
        timestamp: { bsonType: 'date' },
        raceId: { bsonType: 'number', minimum: 1 },
        lap: { bsonType: 'number', minimum: 0 },
        leaderLap: { bsonType: 'number', minimum: 0 },
        standings: {
          bsonType: 'array',
          minItems: 1,
          items: {
            bsonType: 'object',
            required: ['position', 'carId', 'teamId', 'lap', 'gap'],
            properties: {
              position: { bsonType: 'number', minimum: 1 },
              carId: { bsonType: 'number', minimum: 1, maximum: 99 },
              teamId: { bsonType: 'string', pattern: TEAM_ID_PATTERN },
              lap: { bsonType: 'number', minimum: 0 },
              gap: { bsonType: 'number', minimum: 0 },
              state: { enum: FSM_STATES }
            }
          }
        }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'error'
});
db.classifications.createIndex({ raceId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// race_control - storico dei flag e degli eventi globali di gara
// ---------------------------------------------------------------------------

db.createCollection('race_control', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['timestamp', 'raceId', 'flag', 'active'],
      properties: {
        timestamp: { bsonType: 'date' },
        raceId: { bsonType: 'number', minimum: 1 },
        flag: { enum: FLAG_VALUES },
        active: { bsonType: 'bool' },
        sector: {
          oneOf: [
            { bsonType: 'number', minimum: 1, maximum: 3 },
            { bsonType: 'null' }
          ]
        },
        reason: {
          oneOf: [
            { bsonType: 'string', maxLength: 256 },
            { bsonType: 'null' }
          ]
        }
      }
    }
  },
  validationLevel: 'moderate',
  validationAction: 'error'
});
db.race_control.createIndex({ raceId: 1, timestamp: -1 });
db.race_control.createIndex({ raceId: 1, flag: 1, timestamp: -1 });

print('MongoDB F1 Telemetry inizializzato: 5 collection con validator e indici.');
