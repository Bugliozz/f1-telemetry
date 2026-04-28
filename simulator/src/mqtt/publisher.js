// MQTT Publisher — singolo client condiviso per tutte le auto.
//
// Gestisce connessione, riconnessione, e publish con QoS/retain corretti
// secondo la policy definita in docs/mqtt-topics.md §2.
//
// Cfr. docs/simulator-architecture.md §3 (mqtt/publisher.js).

const path = require('path');

class MqttPublisher {
  constructor(mqttClient, raceId, logger, options = {}) {
    this.client = mqttClient;
    this.raceId = raceId;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this._connected = false;
    this._publishCount = 0;
    this._validators = options.validateSchemas ? this._loadValidators() : null;

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
    this._publish(topic, payload, { qos: 0, retain: false }, 'telemetry');
  }

  // Pubblica stato FSM (QoS 1, retained)
  publishState(teamId, carId, payload) {
    const topic = this._carTopic(teamId, carId, 'state');
    this._publish(topic, payload, { qos: 1, retain: true }, 'state');
  }

  // Pubblica evento (QoS 1, no retain)
  publishEvent(teamId, carId, payload) {
    const topic = this._carTopic(teamId, carId, 'events');
    this._publish(topic, payload, { qos: 1, retain: false }, 'event');
  }

  // Pubblica flag di gara (QoS 1, retained) — Race Control
  publishFlag(payload) {
    const topic = `f1/simulation/${this.raceId}/race-control/flags`;
    this._publish(topic, payload, { qos: 1, retain: true }, 'flag');
  }

  _publish(topic, payload, options, schemaKey) {
    if (!this.client) {
      this.log.warn('[MqttPublisher] Nessun client MQTT, messaggio scartato:', topic);
      return;
    }

    if (!this._connected) {
      if (options.qos === 0) {
        this.log.debug('[MqttPublisher] Non connesso, telemetria QoS0 scartata:', topic);
        return;
      }
      this.log.warn('[MqttPublisher] Non connesso, messaggio QoS1 in buffer:', topic);
    }

    this._validatePayload(schemaKey, payload, topic);

    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(topic, data, options, (err) => {
      if (err) {
        this.log.error('[MqttPublisher] Errore publish:', topic, err.message);
      }
    });
    this._publishCount++;
    this.log.debug('[MqttPublisher] →', topic);
  }

  _loadValidators() {
    try {
      const Ajv2020 = require('ajv/dist/2020');
      const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
      const schemaDir = path.join(__dirname, '..', '..', '..', 'schemas');
      return {
        telemetry: ajv.compile(require(path.join(schemaDir, 'telemetry.schema.json'))),
        state: ajv.compile(require(path.join(schemaDir, 'state.schema.json'))),
        event: ajv.compile(require(path.join(schemaDir, 'event.schema.json'))),
        flag: ajv.compile(require(path.join(schemaDir, 'flag.schema.json'))),
      };
    } catch (err) {
      this.log.warn('[MqttPublisher] Validazione schema disabilitata:', err.message);
      return null;
    }
  }

  _validatePayload(schemaKey, payload, topic) {
    if (!this._validators || typeof payload === 'string') return;
    const validate = this._validators[schemaKey];
    if (!validate || validate(payload)) return;

    const firstError = validate.errors && validate.errors[0]
      ? `${validate.errors[0].instancePath || '/'} ${validate.errors[0].message}`
      : 'errore sconosciuto';
    this.log.warn(`[MqttPublisher] Payload ${schemaKey} non conforme su ${topic}: ${firstError}`);
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
