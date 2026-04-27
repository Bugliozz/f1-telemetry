// MQTT Publisher — singolo client condiviso per tutte le auto.
//
// Gestisce connessione, riconnessione, e publish con QoS/retain corretti
// secondo la policy definita in docs/mqtt-topics.md §2.
//
// Cfr. docs/simulator-architecture.md §3 (mqtt/publisher.js).

class MqttPublisher {
  constructor(mqttClient, raceId, logger) {
    this.client = mqttClient;
    this.raceId = raceId;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this._connected = false;
    this._publishCount = 0;

    if (this.client) {
      this.client.on('connect', () => {
        this._connected = true;
        this.log.info('[MqttPublisher] Connesso al broker');
      });
      this.client.on('close', () => {
        this._connected = false;
      });
      this.client.on('error', (err) => {
        this.log.error('[MqttPublisher] Errore MQTT:', err.message);
      });
    }
  }

  get connected() {
    return this._connected;
  }

  get publishCount() {
    return this._publishCount;
  }

  // Topic builder
  _carTopic(teamId, carId, suffix) {
    return `f1/simulation/${this.raceId}/teams/${teamId}/cars/${carId}/${suffix}`;
  }

  // Pubblica telemetria (QoS 0, no retain)
  publishTelemetry(teamId, carId, payload) {
    const topic = this._carTopic(teamId, carId, 'telemetry');
    this._publish(topic, payload, { qos: 0, retain: false });
  }

  // Pubblica stato FSM (QoS 1, retained)
  publishState(teamId, carId, payload) {
    const topic = this._carTopic(teamId, carId, 'state');
    this._publish(topic, payload, { qos: 1, retain: true });
  }

  // Pubblica evento (QoS 1, no retain)
  publishEvent(teamId, carId, payload) {
    const topic = this._carTopic(teamId, carId, 'events');
    this._publish(topic, payload, { qos: 1, retain: false });
  }

  _publish(topic, payload, options) {
    if (!this.client || !this._connected) {
      // Best-effort per telemetria (QoS 0): drop.
      // Per QoS 1: logga warning (il client MQTT bufferizza internamente).
      if (options.qos > 0) {
        this.log.warn('[MqttPublisher] Non connesso, messaggio QoS1 in buffer:', topic);
      }
    }

    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, data, options, (err) => {
      if (err) {
        this.log.error('[MqttPublisher] Errore publish:', topic, err.message);
      }
    });
    this._publishCount++;
    this.log.debug('[MqttPublisher] →', topic);
  }

  // Pubblica tutti i messaggi di un tick per un'auto
  publishCarMessages(messages) {
    if (!messages) return;

    if (messages.telemetry) {
      this.publishTelemetry(messages.telemetry.teamId, messages.telemetry.carId, messages.telemetry);
    }

    if (messages.state) {
      this.publishState(messages.state.teamId, messages.state.carId, messages.state);
    }

    if (Array.isArray(messages.events)) {
      for (const event of messages.events) {
        this.publishEvent(event.teamId, event.carId, event);
      }
    }
  }

  async end() {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end(false, {}, resolve);
      } else {
        resolve();
      }
    });
  }
}

module.exports = MqttPublisher;
