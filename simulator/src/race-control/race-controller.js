// Race Controller — motore centrale di Race Control.
//
// Integra flag-state.js (macchina a stati delle flag), triggers.js
// (valutazione automatica delle condizioni) e la pubblicazione MQTT
// dei messaggi race-control/flags.
//
// Responsabilita':
//   - Mantiene lo stato corrente delle flag globali.
//   - A ogni tick, valuta i trigger automatici (evaluateTriggers).
//   - Consente trigger manuali via API (forceFlag).
//   - Pubblica il cambio di flag su MQTT (retained, QoS 1).
//   - Espone lo stato flag attiva per il contesto dell'Orchestrator.
//
// Il RaceController e' un modulo con stato ma senza logica di I/O
// diretta: delega la pubblicazione MQTT all'Orchestrator che chiama
// publishFlagChange(). Cosi' i test possono asserire sulle azioni
// senza mockare il broker.
//
// Cfr. docs/simulator-architecture.md §8, docs/race-control-design.md

const { FLAGS, initialFlagState, changeFlag, isTerminalFlag, isValidFlag } = require('./flag-state');
const { initialTriggerTracker, evaluateTriggers, DEFAULT_TRIGGER_CONFIG } = require('./triggers');

class RaceController {
  /**
   * @param {object} opts
   * @param {number} opts.raceId
   * @param {object} [opts.triggerConfig]   - override per DEFAULT_TRIGGER_CONFIG
   * @param {object} [opts.logger]
   * @param {function} [opts.rng]           - PRNG per trigger probabilistici
   */
  constructor({ raceId, triggerConfig, logger, rng }) {
    this.raceId = raceId || 1;
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.triggerConfig = { ...DEFAULT_TRIGGER_CONFIG, ...triggerConfig };

    this._flagState = initialFlagState();
    this._triggerTracker = initialTriggerTracker();
    this._history = []; // log di tutti i cambi flag
    this._lastNowS = 0;

    this.log.debug('[RaceController] Inizializzato, flag iniziale: GREEN');
  }

  // --- Stato corrente ---

  /** Restituisce la flag attualmente attiva. */
  get activeFlag() {
    return this._flagState.flag;
  }

  /** Restituisce il settore interessato (null = globale). */
  get activeSector() {
    return this._flagState.sector;
  }

  /** Restituisce la reason dell'ultima attivazione. */
  get activeReason() {
    return this._flagState.reason;
  }

  /** Restituisce lo snapshot completo dello stato flag. */
  get flagState() {
    return { ...this._flagState };
  }

  /** Restituisce la cronologia dei cambi flag. */
  get history() {
    return [...this._history];
  }

  // --- Contesto per l'Orchestrator ---

  /**
   * Costruisce l'oggetto di contesto flag da passare alle Car.tick().
   * Fornisce le informazioni necessarie per modulare il comportamento.
   *
   * @returns {{ flag: string, sector: number|null, reason: string|null }}
   */
  buildFlagContext() {
    return {
      flag: this._flagState.flag,
      sector: this._flagState.sector,
      reason: this._flagState.reason,
    };
  }

  // --- Tick automatico ---

  /**
   * Valuta i trigger automatici per il tick corrente.
   * Da chiamare a ogni tick dall'Orchestrator, PRIMA di aggiornare le auto.
   *
   * @param {Car[]} cars        - tutte le auto
   * @param {object} raceState  - { leaderLap, totalLaps, nowS }
   * @returns {{ flagChanged: boolean, flagPayload: object|null }}
   */
  tick(cars, raceState) {
    if (isTerminalFlag(this._flagState.flag)) {
      return { flagChanged: false, flagPayload: null };
    }

    if (raceState && typeof raceState.nowS === 'number' && Number.isFinite(raceState.nowS)) {
      this._lastNowS = raceState.nowS;
    }

    const { action, tracker } = evaluateTriggers(
      this._flagState,
      cars,
      { ...raceState, rng: this.rng },
      this._triggerTracker,
      this.triggerConfig,
    );

    this._triggerTracker = tracker;

    if (action) {
      return this._applyFlagChange(action.flag, {
        sector: action.sector,
        reason: action.reason,
        nowS: raceState.nowS,
        source: 'automatic',
        timestamp: raceState.timestamp,
      });
    }

    return { flagChanged: false, flagPayload: null };
  }

  // --- Trigger manuale ---

  /**
   * Forza un cambio di flag manuale (da comando esterno, Node-RED, ecc.).
   *
   * @param {string} newFlag
   * @param {object} opts - { sector, reason, nowS, timestamp }
   * @returns {{ flagChanged: boolean, flagPayload: object|null }}
   */
  forceFlag(newFlag, opts = {}) {
    if (!isValidFlag(newFlag)) {
      this.log.warn(`[RaceController] Flag non valida: ${newFlag}`);
      return { flagChanged: false, flagPayload: null };
    }

    const nowS = typeof opts.nowS === 'number' && Number.isFinite(opts.nowS)
      ? opts.nowS
      : this._lastNowS;

    return this._applyFlagChange(newFlag, {
      sector: opts.sector,
      reason: opts.reason || `manual-${newFlag.toLowerCase()}`,
      nowS,
      source: 'manual',
      timestamp: opts.timestamp,
    });
  }

  // --- Interno ---

  _applyFlagChange(newFlag, opts) {
    const result = changeFlag(this._flagState, newFlag, {
      sector: opts.sector,
      reason: opts.reason,
      nowS: opts.nowS,
    });

    if (!result.changed) {
      return { flagChanged: false, flagPayload: null };
    }

    // Aggiorna stato
    this._flagState = result;

    // Costruisci payload MQTT
    const payload = {
      timestamp: opts.timestamp || new Date().toISOString(),
      raceId: this.raceId,
      flag: result.flag,
      active: true,
      sector: result.sector,
      reason: result.reason,
    };

    // Log
    const sectorStr = result.sector != null ? ` (S${result.sector})` : '';
    const icon = this._flagIcon(result.flag);
    this.log.info(
      `[RaceController] ${icon} ${result.previousFlag} → ${result.flag}${sectorStr} ` +
      `[${opts.source}] ${result.reason || ''}`
    );

    // Cronologia
    this._history.push({
      from: result.previousFlag,
      to: result.flag,
      sector: result.sector,
      reason: result.reason,
      source: opts.source,
      atS: opts.nowS,
    });

    return { flagChanged: true, flagPayload: payload };
  }

  _flagIcon(flag) {
    switch (flag) {
      case FLAGS.GREEN:     return '🟩';
      case FLAGS.YELLOW:    return '🟨';
      case FLAGS.RED:       return '🟥';
      case FLAGS.CHECKERED: return '🏁';
      case FLAGS.SC:        return '🚗';
      case FLAGS.VSC:       return '🚦';
      default:              return '🏳️';
    }
  }
}

module.exports = RaceController;
