// Broker-level MQTT checks for Phase 1.
// Requires a running Mosquitto broker, e.g. `docker compose up -d mosquitto`.

const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const RACE_ID = parseInt(process.env.TEST_RACE_ID || process.env.RACE_ID || '901', 10);
const TEAM_ID = 'ferrari';
const CAR_ID = 16;
const TIMEOUT_MS = parseInt(process.env.MQTT_TEST_TIMEOUT_MS || '3000', 10);

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

function assert(condition, label) {
  if (condition) ok(label);
  else fail(label, new Error('assertion failed'));
}

function topic(suffix) {
  return `f1/simulation/${RACE_ID}/teams/${TEAM_ID}/cars/${CAR_ID}/${suffix}`;
}

function connectClient(label) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, {
      clientId: `f1-test-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      connectTimeout: TIMEOUT_MS,
      reconnectPeriod: 0,
    });

    const timeout = setTimeout(() => {
      client.end(true);
      reject(new Error(`timeout connecting ${label}`));
    }, TIMEOUT_MS);

    client.once('connect', () => {
      clearTimeout(timeout);
      resolve(client);
    });

    client.once('error', (err) => {
      clearTimeout(timeout);
      client.end(true);
      reject(err);
    });
  });
}

function endClient(client) {
  if (!client) return Promise.resolve();
  return new Promise((resolve) => client.end(false, {}, resolve));
}

function publish(client, targetTopic, payload, options) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    client.publish(targetTopic, data, options, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function subscribe(client, targetTopic, options) {
  return new Promise((resolve, reject) => {
    client.subscribe(targetTopic, options, (err, granted) => {
      if (err) return reject(err);
      const grant = granted && granted[0];
      if (grant && grant.qos === 128) return reject(new Error('subscription rejected'));
      resolve(grant);
    });
  });
}

function waitForMessage(client, expectedTopic, predicate, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.removeListener('message', onMessage);
      reject(new Error(`timeout waiting for ${expectedTopic}`));
    }, timeoutMs);

    function onMessage(actualTopic, message, packet) {
      if (actualTopic !== expectedTopic) return;

      let payload;
      try {
        payload = JSON.parse(message.toString());
      } catch (err) {
        payload = message.toString();
      }

      if (predicate && !predicate(payload, packet)) return;
      clearTimeout(timeout);
      client.removeListener('message', onMessage);
      resolve({ payload, packet });
    }

    client.on('message', onMessage);
  });
}

function expectNoMessage(client, expectedTopic, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.removeListener('message', onMessage);
      resolve();
    }, timeoutMs);

    function onMessage(actualTopic, message) {
      if (actualTopic !== expectedTopic) return;
      clearTimeout(timeout);
      client.removeListener('message', onMessage);
      reject(new Error(`unexpected message: ${message.toString()}`));
    }

    client.on('message', onMessage);
  });
}

async function clearRetained(client, targetTopic) {
  await publish(client, targetTopic, '', { qos: 1, retain: true });
}

async function checkRetained(pub, targetTopic, payload, label) {
  await clearRetained(pub, targetTopic);
  await publish(pub, targetTopic, payload, { qos: 1, retain: true });

  const sub = await connectClient(`${label}-retained`);
  try {
    const wait = waitForMessage(
      sub,
      targetTopic,
      (received) => received && received.raceId === RACE_ID,
      TIMEOUT_MS
    );
    await subscribe(sub, targetTopic, { qos: 1 });
    const message = await wait;
    assert(message.packet.retain === true, `${label} retained message is delivered`);
  } finally {
    await endClient(sub);
    await clearRetained(pub, targetTopic);
  }
}

async function checkOutsideTree(pub) {
  const outsideTopic = `outside/f1-telemetry-${Date.now()}`;
  const sub = await connectClient('outside-sub');
  try {
    try {
      await subscribe(sub, outsideTopic, { qos: 1 });
    } catch (err) {
      ok('outside topic subscription rejected');
      return;
    }

    const noMessage = expectNoMessage(sub, outsideTopic, 1000);
    try {
      await publish(pub, outsideTopic, { denied: true }, { qos: 1, retain: false });
    } catch (err) {
      ok('outside topic publish rejected');
      return;
    }
    await noMessage;
    ok('outside topic is not delivered');
  } finally {
    await endClient(sub);
  }
}

async function main() {
  console.log(`=== MQTT broker Phase 1 test (${MQTT_URL}, raceId=${RACE_ID}) ===`);

  const pub = await connectClient('pub');
  const sub = await connectClient('telemetry-sub');
  try {
    ok('connected to broker');

    const telemetryTopic = topic('telemetry');
    const telemetryPayload = {
      timestamp: new Date().toISOString(),
      raceId: RACE_ID,
      teamId: TEAM_ID,
      carId: CAR_ID,
      compound: 'medium',
      lap: 1,
      trackPos: 0.123,
      speed: 250,
      rpm: 11000,
      gear: 6,
      throttle: 0.8,
      brake: 0,
      drs: true,
      tireTemp: { fl: 95, fr: 96, rl: 98, rr: 99 },
      fuel: 80,
      state: 'RUNNING',
    };

    const telemetryWait = waitForMessage(
      sub,
      telemetryTopic,
      (payload) => payload && payload.raceId === RACE_ID && payload.carId === CAR_ID,
      TIMEOUT_MS
    );
    await subscribe(sub, telemetryTopic, { qos: 1 });
    await publish(pub, telemetryTopic, telemetryPayload, { qos: 0, retain: false });
    const telemetryMsg = await telemetryWait;
    assert(telemetryMsg.packet.retain === false, 'telemetry live publish is not retained');

    await checkRetained(pub, topic('state'), {
      timestamp: new Date().toISOString(),
      raceId: RACE_ID,
      teamId: TEAM_ID,
      carId: CAR_ID,
      state: 'RUNNING',
      previousState: 'INIT',
      reason: 'broker-test',
    }, 'state');

    await checkRetained(pub, `f1/simulation/${RACE_ID}/race-control/flags`, {
      timestamp: new Date().toISOString(),
      raceId: RACE_ID,
      flag: 'GREEN',
      active: true,
      sector: null,
      reason: 'broker-test',
    }, 'flags');

    await checkRetained(pub, `f1/simulation/${RACE_ID}/race-control/classification`, {
      timestamp: new Date().toISOString(),
      raceId: RACE_ID,
      lap: 1,
      leaderLap: 1,
      standings: [
        { position: 1, carId: CAR_ID, teamId: TEAM_ID, lap: 1, gap: 0, state: 'RUNNING' },
      ],
    }, 'classification');

    await checkOutsideTree(pub);
  } catch (err) {
    fail('broker test', err);
  } finally {
    await endClient(sub);
    await endClient(pub);
  }

  console.log(`\n=== Result: ${passed} OK, ${failed} FAIL ===`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[test-mqtt-broker] unhandled error:', err.message);
  process.exitCode = 1;
});
