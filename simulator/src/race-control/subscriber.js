// Race Control Subscriber — MQTT subscription for external flags.
//
// Subscribes to `f1/simulation/{raceId}/race-control/flags` with QoS 1
// (as defined in docs/mqtt-topics.md §2). When a message arrives
// from an external source (e.g. Node-RED, CLI), it passes it to the
// RaceController as a manual trigger.
//
// This allows the race to be controlled from outside the
// simulator (manual race-control mode).
//
// The subscriber also handles reconnections: on reconnect
// it re-subscribes automatically.
//
// See docs/simulator-architecture.md §8.1

class RaceControlSubscriber {
  /**
   * @param {object} opts
   * @param {object} opts.mqttClient   - already-connected MQTT client
   * @param {number} opts.raceId
   * @param {object} opts.raceController - RaceController instance
   * @param {object} [opts.logger]
   */
  constructor({ mqttClient, raceId, raceController, logger }) {
    this.client = mqttClient;
    this.raceId = raceId || 1;
    this.raceController = raceController;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };

    this._topic = `f1/simulation/${this.raceId}/race-control/flags`;
    this._subscribed = false;
    this._started = false;
  }

  /**
   * Starts the subscription. To be called after the MQTT connection is established.
   */
  start() {
    if (this._started) {
      this.log.debug('[RaceControlSubscriber] start() ignored: already active');
      return;
    }

    if (!this.client) {
      this.log.warn('[RaceControlSubscriber] No MQTT client configured');
      return;
    }

    this._started = true;
    this._subscribe();

    // Gestione messaggi in arrivo
    this.client.on('message', (topic, message) => {
      if (topic !== this._topic) return;
      this._handleMessage(message);
    });

    // Re-subscribe alla riconnessione
    this.client.on('reconnect', () => {
      this.log.info('[RaceControlSubscriber] Reconnected, re-subscribing...');
      this._subscribe();
    });

    this.log.info(`[RaceControlSubscriber] Listening on ${this._topic}`);
  }

  _subscribe() {
    this.client.subscribe(this._topic, { qos: 1 }, (err) => {
      if (err) {
        this.log.error('[RaceControlSubscriber] Subscribe error:', err.message);
        this._subscribed = false;
      } else {
        this._subscribed = true;
        this.log.debug('[RaceControlSubscriber] Subscribed to:', this._topic);
      }
    });
  }

  _handleMessage(message) {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      this.log.warn('[RaceControlSubscriber] Invalid payload (not JSON):', err.message);
      return;
    }

    // Ignore messages that do NOT have the expected structure
    if (!payload || typeof payload.flag !== 'string') {
      this.log.warn('[RaceControlSubscriber] Payload missing "flag" field');
      return;
    }

    // Ignore messages with active === false (they are revocations, handled by
    // the RaceController itself when it sends GREEN)
    if (payload.active === false) {
      this.log.debug('[RaceControlSubscriber] Flag with active=false, ignored');
      return;
    }

    // Ignore messages with the same raceId (they are echo messages
    // published by this same simulator).
    // NOTE: for now we process them anyway to support the case of
    // an external controller publishing on the same topic.
    // A "source" field could be added in future to filter these out.

    this.log.info(`[RaceControlSubscriber] External flag received: ${payload.flag} (reason: ${payload.reason || 'n/a'})`);

    const result = this.raceController.forceFlag(payload.flag, {
      sector: payload.sector != null ? payload.sector : undefined,
      reason: payload.reason || `external-${payload.flag.toLowerCase()}`,
      nowS: undefined, // will be set by the next tick
      timestamp: payload.timestamp,
    });

    if (result.flagChanged) {
      this.log.info(`[RaceControlSubscriber] Flag applied: ${payload.flag}`);
    } else {
      this.log.debug(`[RaceControlSubscriber] Flag not applicable from current state`);
    }
  }

  get subscribed() {
    return this._subscribed;
  }
}

module.exports = RaceControlSubscriber;
