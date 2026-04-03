// Script di inizializzazione MongoDB — F1 Telemetry
// Eseguito automaticamente alla prima creazione del container

db = db.getSiblingDB('f1_telemetry');

// Collection: telemetria in tempo reale
db.createCollection('telemetry');
db.telemetry.createIndex({ raceId: 1, carId: 1, timestamp: -1 });
db.telemetry.createIndex({ raceId: 1, lap: 1 });

// Collection: eventi per singola auto (pit stop, fault, retirement)
db.createCollection('events');
db.events.createIndex({ raceId: 1, carId: 1, timestamp: -1 });
db.events.createIndex({ raceId: 1, type: 1 });

// Collection: stati FSM delle auto
db.createCollection('states');
db.states.createIndex({ raceId: 1, carId: 1 }, { unique: true });

// Collection: classifica in tempo reale
db.createCollection('classifications');
db.classifications.createIndex({ raceId: 1 }, { unique: true });

// Collection: eventi race control (flag, SC, VSC)
db.createCollection('race_control');
db.race_control.createIndex({ raceId: 1, timestamp: -1 });

print('✅ MongoDB F1 Telemetry inizializzato correttamente');
