// Race Controller — central Race Control engine.
//
// Integrates flag-state.js (flag state machine), triggers.js
// (automatic condition evaluation) and MQTT publishing of
// race-control/flags messages.
//
// Responsibilities:
//   - Maintains the current global flag state.
//   - Each tick, evaluates automatic triggers (evaluateTriggers).
//   - Allows manual triggers via API (forceFlag).
//   - Publishes flag changes to MQTT (retained, QoS 1).
//   - Exposes the active flag state for the Orchestrator context.
//
// RaceController is a stateful module with no direct I/O logic:
// it delegates MQTT publishing to the Orchestrator via publishFlagChange().
// This way tests can assert on actions without mocking the broker.
//
// See docs/simulator-architecture.md §8, docs/race-control-design.md

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
    this._history = []; // log of all flag changes
    this._lastNowS = 0;

    this.log.debug('[RaceController] Initialized, initial flag: GREEN');
  }

  // --- Current state ---

  /** Returns the currently active flag. */
  get activeFlag() {
    return this._flagState.flag;
  }

  /** Returns the affected sector (null = global). */
  get activeSector() {
    return this._flagState.sector;
  }

  /** Returns the reason for the last activation. */
  get activeReason() {
    return this._flagState.reason;
  }

  /** Returns the full flag state snapshot. */
  get flagState() {
    return { ...this._flagState };
  }

  /** Returns the flag change history. */
  get history() {
    return [...this._history];
  }

  // --- Orchestrator context ---

  /**
   * Builds the flag context object to pass to Car.tick().
   * Provides the information needed to modulate behaviour.
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

  // --- Automatic tick ---

  /**
   * Evaluates automatic triggers for the current tick.
   * To be called every tick by the Orchestrator, BEFORE updating cars.
   *
   * @param {Car[]} cars        - all cars
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

  // --- Manual trigger ---

  /**
   * Forces a manual flag change (from an external command, Node-RED, etc.).
   *
   * @param {string} newFlag
   * @param {object} opts - { sector, reason, nowS, timestamp }
   * @returns {{ flagChanged: boolean, flagPayload: object|null }}
   */
  forceFlag(newFlag, opts = {}) {
    if (!isValidFlag(newFlag)) {
      this.log.warn(`[RaceController] Invalid flag: ${newFlag}`);
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

  // --- Internal ---

  _applyFlagChange(newFlag, opts) {
    const result = changeFlag(this._flagState, newFlag, {
      sector: opts.sector,
      reason: opts.reason,
      nowS: opts.nowS,
    });

    if (!result.changed) {
      return { flagChanged: false, flagPayload: null };
    }

    // Update state
    this._flagState = result;

    // Build MQTT payload
    const payload = {
      timestamp: opts.timestamp || new Date().toISOString(),
      raceId: this.raceId,
      flag: result.flag,
      active: true,
      sector: result.sector,
      reason: result.reason,
    };

    // Log flag change
    const sectorStr = result.sector != null ? ` (S${result.sector})` : '';
    const icon = this._flagIcon(result.flag);
    this.log.info(
      `[RaceController] ${icon} ${result.previousFlag} → ${result.flag}${sectorStr} ` +
      `[${opts.source}] ${result.reason || ''}`
    );

    // History
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
