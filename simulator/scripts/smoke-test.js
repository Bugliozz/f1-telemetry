/**
 * Smoke Test — Fase 0
 * Verifica la connettività tra Mosquitto, MongoDB e Node-RED
 */

const mqtt = require('mqtt');
const { MongoClient } = require('mongodb');

const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const NODE_RED_URL = process.env.NODE_RED_URL || 'http://localhost:1880/admin';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ❌ ${label}: ${err.message}`);
  failed++;
}

async function testMQTT() {
  console.log('\n[1/3] Test Mosquitto MQTT...');
  return new Promise((resolve) => {
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 5000 });

    const timeout = setTimeout(() => {
      fail('Connessione MQTT', new Error('timeout'));
      client.end(true);
      resolve();
    }, 5000);

    client.on('connect', () => {
      clearTimeout(timeout);
      ok('Connessione MQTT su porta 1883');

      const testTopic = 'f1/smoke-test';
      client.subscribe(testTopic, { qos: 1 }, (err) => {
        if (err) return fail('Subscribe MQTT', err);

        client.publish(testTopic, JSON.stringify({ test: true, ts: Date.now() }), { qos: 1 }, (err) => {
          if (err) return fail('Publish MQTT', err);
          ok('Publish/Subscribe MQTT (QoS 1)');
          client.end();
          resolve();
        });
      });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      fail('Connessione MQTT', err);
      client.end(true);
      resolve();
    });
  });
}

async function testMongoDB() {
  console.log('\n[2/3] Test MongoDB...');
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    ok('Connessione MongoDB su porta 27017');

    const db = client.db('f1_telemetry');
    const collections = await db.listCollections().toArray();
    const names = collections.map(c => c.name);

    const expected = ['telemetry', 'events', 'states', 'classifications', 'race_control'];
    for (const col of expected) {
      if (names.includes(col)) {
        ok(`Collection '${col}' present`);
      } else {
        fail(`Collection '${col}'`, new Error('non trovata'));
      }
    }
  } catch (err) {
    fail('Connessione MongoDB', err);
  } finally {
    await client.close();
  }
}

async function testNodeRed() {
  console.log('\n[3/3] Test Node-RED...');
  try {
    const res = await fetch(NODE_RED_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok || res.status === 200) {
      ok(`Node-RED raggiungibile su porta 1880 (HTTP ${res.status})`);
    } else {
      fail('Node-RED', new Error(`HTTP ${res.status}`));
    }
  } catch (err) {
    fail('Node-RED', err);
  }
}

async function main() {
  console.log('=== F1 Telemetry — Smoke Test Fase 0 ===');

  await testMQTT();
  await testMongoDB();
  await testNodeRed();

  console.log(`\n=== Risultato: ${passed} ✅  ${failed} ❌ ===`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[smoke-test] unhandled error:', err.message);
  process.exitCode = 1;
});
