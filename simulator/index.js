const mqtt = require('mqtt');

// Connessione al broker sfruttando la variabile definita in docker-compose
const brokerUrl = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
console.log(`Connessione in corso al broker MQTT: ${brokerUrl}...`);

const client = mqtt.connect(brokerUrl);

client.on('connect', () => {
  console.log('Connesso al broker MQTT con successo!');
  
  // Mantiene vivo il processo Node.js e fa da base per il simulatore (Fase 3)
  setInterval(() => {
    const telemetry = {
      timestamp: new Date().toISOString(),
      speed: Math.floor(Math.random() * 350),
      rpm: Math.floor(Math.random() * 15000)
    };
    
    // Invio dei dati nel formato gerarchico definito nel piano d'implementazione
    client.publish('f1/simulation/1/teams/ferrari/cars/16/telemetry', JSON.stringify(telemetry));
    console.log('Inviati dati di telemetria:', telemetry);
  }, 1000); // Impostato provvisoriamente a 1 Hz
});

client.on('error', (err) => {
  console.error('Errore di connessione MQTT:', err);
});

process.on('SIGTERM', () => {
  console.log('[simulator] Shutdown...');
  client.end();
  process.exit(0);
});