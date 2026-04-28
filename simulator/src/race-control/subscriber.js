// Race Control Subscriber — sottoscrizione MQTT per flag esterne.
//
// Si sottoscrive a `f1/simulation/{raceId}/race-control/flags` con QoS 1
// (come definito in docs/mqtt-topics.md §2). Quando arriva un messaggio
// da una sorgente esterna (es. Node-RED, CLI), lo passa al RaceController
// come trigger manuale.
//
// Questo permette di controllare la gara anche dall'esterno del
// simulatore (modalita' "direzione gara manuale").
//
// Il subscriber gestisce anche la riconnessione: alla riconnessione
// si ri-sottoscrive automaticamente.
//
// Cfr. docs/simulator-architecture.md §8.1

class RaceControlSubscriber {
  /**
   * @param {object} opts
   * @param {object} opts.mqttClient   - client MQTT gia' connesso
   * @param {number} opts.raceId
   * @param {object} opts.raceController - istanza di RaceController
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
   * Avvia la sottoscrizione. Da chiamare dopo la connessione MQTT.
   */
  start() {
    if (this._started) {
      this.log.debug('[RaceControlSubscriber] start() ignorato: gia attivo');
      return;
    }

    if (!this.client) {
      this.log.warn('[RaceControlSubscriber] Nessun client MQTT configurato');
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
      this.log.info('[RaceControlSubscriber] Riconnessione, ri-sottoscrivo...');
      this._subscribe();
    });

    this.log.info(`[RaceControlSubscriber] In ascolto su ${this._topic}`);
  }

  _subscribe() {
    this.client.subscribe(this._topic, { qos: 1 }, (err) => {
      if (err) {
        this.log.error('[RaceControlSubscriber] Errore subscribe:', err.message);
        this._subscribed = false;
      } else {
        this._subscribed = true;
        this.log.debug('[RaceControlSubscriber] Sottoscritto a:', this._topic);
      }
    });
  }

  _handleMessage(message) {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (err) {
      this.log.warn('[RaceControlSubscriber] Payload non valido (non JSON):', err.message);
      return;
    }

    // Ignora messaggi che NON hanno la struttura attesa
    if (!payload || typeof payload.flag !== 'string') {
      this.log.warn('[RaceControlSubscriber] Payload senza campo "flag"');
      return;
    }

    // Ignora messaggi con active === false (sono revoche, gestite dal
    // RaceController stesso quando manda GREEN)
    if (payload.active === false) {
      this.log.debug('[RaceControlSubscriber] Flag con active=false, ignorata');
      return;
    }

    // Ignora messaggi con lo stesso raceId (sono messaggi di echo
    // pubblicati da questo stesso simulatore)
    // NOTA: per ora li processiamo comunque per supportare il caso
    // di un controller esterno che pubblica sullo stesso topic.
    // In futuro si puo' aggiungere un campo "source" per filtrare.

    this.log.info(`[RaceControlSubscriber] Flag esterna ricevuta: ${payload.flag} (reason: ${payload.reason || 'n/a'})`);

    const result = this.raceController.forceFlag(payload.flag, {
      sector: payload.sector != null ? payload.sector : undefined,
      reason: payload.reason || `external-${payload.flag.toLowerCase()}`,
      nowS: undefined, // verra' settato dal prossimo tick
      timestamp: payload.timestamp,
    });

    if (result.flagChanged) {
      this.log.info(`[RaceControlSubscriber] Flag applicata: ${payload.flag}`);
    } else {
      this.log.debug(`[RaceControlSubscriber] Flag non applicabile dallo stato corrente`);
    }
  }

  get subscribed() {
    return this._subscribed;
  }
}

module.exports = RaceControlSubscriber;
