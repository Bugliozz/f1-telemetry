// Bootstrap del simulatore F1 — entry point.
//
// Legge configurazione, crea le dipendenze, avvia l'Orchestrator.
// Cfr. docs/simulator-architecture.md §12.1.

const mqtt = require('mqtt');
const config = require('./config/default');
const roster = require('./config/roster.json');
const MqttPublisher = require('./src/mqtt/publisher');
const Orchestrator = require('./src/orchestrator');
const RaceControlSubscriber = require('./src/race-control/subscriber');
const { createLogger } = require('./src/util/log');

const log = createLogger(config.logLevel);

// --- Avvio ---

log.info('╔══════════════════════════════════════════════════╗');
log.info('║         🏎️  F1 Telemetry Simulator  🏎️          ║');
log.info('╚══════════════════════════════════════════════════╝');
log.info(`Broker: ${config.mqttBroker}`);
log.info(`Race ID: ${config.raceId}`);
log.info(`Tick rate: ${1000 / config.tickMs} Hz (${config.tickMs} ms)`);
log.info(`Auto: ${roster.length}`);
log.info(`Giri totali: ${config.totalLaps}`);
log.info(`Seed: ${config.seed != null ? config.seed : 'random'}`);

const client = mqtt.connect(config.mqttBroker, {
  reconnectPeriod: 2000,
  connectTimeout: 10000,
  clientId: `f1-simulator-${config.raceId}-${Date.now()}`,
});

const publisher = new MqttPublisher(client, config.raceId, log, {
  validateSchemas: config.logLevel === 'debug',
});
let orchestrator = null;
let rcSubscriber = null;

// Aspetta la connessione prima di avviare
client.on('connect', () => {
  if (orchestrator) {
    log.info('[main] Broker MQTT riconnesso, simulazione gia attiva');
    return;
  }

  log.info('[main] Connesso al broker MQTT — avvio simulazione...');

  orchestrator = new Orchestrator({
    roster,
    config,
    publisher,
    logger: log,
  });

  // Avvia il subscriber per flag esterne (Fase 4 — Race Control)
  rcSubscriber = new RaceControlSubscriber({
    mqttClient: client,
    raceId: config.raceId,
    raceController: orchestrator.raceController,
    logger: log,
  });
  rcSubscriber.start();

  orchestrator.start();

  // Shutdown ordinato (§12.2)
  const shutdown = async (signal) => {
    log.info(`[main] Ricevuto ${signal}, shutdown in corso...`);
    orchestrator.stop();
    await publisher.end();
    log.info('[main] Disconnesso. Bye! 👋');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});

client.on('error', (err) => {
  log.error('[main] Errore connessione MQTT:', err.message);
});

// Timeout connessione
setTimeout(() => {
  if (!publisher.connected) {
    log.error('[main] Timeout connessione al broker dopo 10s. Uscita.');
    process.exit(1);
  }
}, 10000);
