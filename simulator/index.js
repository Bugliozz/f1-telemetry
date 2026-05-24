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
const { resetRaceData } = require('./src/persistence/race-reset');
const { SCENARIOS, applyScenario } = require('./src/scenarios');
const { createLogger } = require('./src/util/log');

const log = createLogger(config.logLevel);

// --- Startup ---

log.info('╔══════════════════════════════════════════════════╗');
log.info('║         🏎️  F1 Telemetry Simulator  🏎️          ║');
log.info('╚══════════════════════════════════════════════════╝');
log.info(`Broker: ${config.mqttBroker}`);
log.info(`Race ID: ${config.raceId}`);
log.info(`Tick rate: ${1000 / config.tickMs} Hz (${config.tickMs} ms)`);
log.info(`Cars: ${roster.length}`);
log.info(`Total laps: ${config.totalLaps}`);
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
let startSubscribed = false;
let startInProgress = false;
const startTopic = `f1/simulation/${config.raceId}/control/start`;

function parseStartCommand(message) {
  const payload = JSON.parse(message.toString());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload is not an object');
  }
  const raceId = Number(payload.raceId == null ? config.raceId : payload.raceId);
  if (!Number.isInteger(raceId) || raceId !== config.raceId) {
    throw new Error(`invalid raceId ${payload.raceId}`);
  }
  return payload.scenario || payload.scenarioId || SCENARIOS.BALANCED;
}

async function startSimulation(scenarioId, source) {
  if (orchestrator) {
    log.info(`[main] Start command ignored: simulation already active (${source || 'unknown'})`);
    return;
  }
  if (startInProgress) {
    log.info(`[main] Start command ignored: startup already in progress (${source || 'unknown'})`);
    return;
  }

  startInProgress = true;
  try {
    const scenarioConfig = applyScenario(config, scenarioId);
    log.info(`[main] Scenario selezionato: ${scenarioConfig.scenario.label} (${scenarioConfig.scenario.id})`);

    if (scenarioConfig.resetRaceOnStart) {
      await resetRaceData({
        mongoUrl: scenarioConfig.mongoUrl,
        dbName: scenarioConfig.mongoDb,
        raceId: scenarioConfig.raceId,
        logger: log,
      });
    }

    orchestrator = new Orchestrator({
      roster,
      config: scenarioConfig,
      publisher,
      logger: log,
    });

    orchestrator.start();

    // Start the external flag subscriber after the initial GREEN flag.
    rcSubscriber = new RaceControlSubscriber({
      mqttClient: client,
      raceId: scenarioConfig.raceId,
      raceController: orchestrator.raceController,
      logger: log,
    });
    rcSubscriber.start();

    client.unsubscribe(startTopic);
    startSubscribed = false;
  } catch (err) {
    log.error('[main] Simulation startup failed:', err.message);
  } finally {
    startInProgress = false;
  }
}

function subscribeStartTopic() {
  if (startSubscribed) return;
  client.subscribe(startTopic, { qos: 1 }, (err) => {
    if (err) {
      log.error('[main] Start scenario subscription error:', err.message);
      startSubscribed = false;
      return;
    }
    startSubscribed = true;
    log.info(`[main] Waiting for scenario selection on ${startTopic}`);
  });
}

client.on('message', (topic, message) => {
  if (topic !== startTopic) return;
  try {
    const scenarioId = parseStartCommand(message);
    startSimulation(scenarioId, 'dashboard').catch((err) => {
      log.error('[main] Simulation startup failed:', err.message);
    });
  } catch (err) {
    log.warn('[main] Comando start scenario non valido:', err.message);
  }
});

async function shutdown(signal) {
  log.info(`[main] Ricevuto ${signal}, shutdown in corso...`);
  if (orchestrator) orchestrator.stop();
  await publisher.end();
  log.info('[main] Disconnected. Bye!');
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// Aspetta la connessione prima di avviare
client.on('connect', () => {
  if (orchestrator) {
    log.info('[main] MQTT broker reconnected, simulation already active');
    return;
  }

  log.info('[main] Connected to MQTT broker');

  if (config.autoStart) {
    startSimulation(process.env.RACE_SCENARIO || SCENARIOS.BALANCED, 'auto-start').catch((err) => {
      log.error('[main] Simulation startup failed:', err.message);
    });
  } else {
    subscribeStartTopic();
  }
});

client.on('error', (err) => {
  log.error('[main] MQTT connection error:', err.message);
});

// Timeout connessione
setTimeout(() => {
  if (!publisher.connected) {
    log.error('[main] Timeout connessione al broker dopo 10s. Uscita.');
    process.exit(1);
  }
}, 10000);
