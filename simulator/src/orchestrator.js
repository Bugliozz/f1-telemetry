// Orchestrator — ciclo tick, lifecycle, fan-out alle Car.
//
// Un solo `setInterval(tickFn, TICK_MS)` gestisce tutte le auto.
// A ogni tick: calcola dt, valuta Race Control, aggiorna tutte le auto,
// pubblica i messaggi.
//
// Cfr. docs/simulator-architecture.md §4.

const Car = require('./car/car');
const { createCarPrng } = require('./util/prng');
const { createClock } = require('./util/clock');
const { STATES } = require('./car/fsm');
const RaceController = require('./race-control/race-controller');
const { FLAGS } = require('./race-control/flag-state');

class Orchestrator {
  constructor({ roster, config, publisher, logger }) {
    this.config = config;
    this.publisher = publisher;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.clock = createClock();

    this.raceId = config.raceId || 1;
    this.totalLaps = config.totalLaps || 15;
    this.tickMs = config.tickMs || 250;

    // PRNG globale per Race Control (separato dalle auto)
    const rcRng = createCarPrng(config.seed, 0);

    // Race Controller — motore centrale delle flag (Fase 4)
    this.raceController = new RaceController({
      raceId: this.raceId,
      triggerConfig: config.raceControlTriggers || {},
      logger: this.log,
      rng: rcRng,
    });

    // Crea le auto dal roster
    this.cars = roster.map((entry) => {
      const rng = createCarPrng(config.seed, entry.carId);
      return new Car({
        teamId: entry.teamId,
        carId: entry.carId,
        driver: entry.driver,
        pitStrategy: entry.pitStrategy,
        rng,
        config,
      });
    });

    this._intervalId = null;
    this._lastTickMs = null;
    this._tickCount = 0;
    this._raceStarted = false;
    this._raceFinished = false;
    this._checkeredSent = false;
    this._leaderLap = 0;
    this._simulatedTimeS = 0;

    // Stats
    this._totalPublished = 0;
    this._startTimeMs = null;
  }

  start() {
    this.log.info(`[Orchestrator] Avvio simulazione: ${this.cars.length} auto, ${this.totalLaps} giri, ${1000 / this.tickMs} Hz`);
    this._startTimeMs = this.clock.nowMs();
    this._lastTickMs = this._startTimeMs;

    // Pubblica la flag iniziale GREEN (retained, cosi' i subscriber la
    // ricevono immediatamente alla connessione)
    const greenPayload = {
      timestamp: this.clock.isoNow(),
      raceId: this.raceId,
      flag: FLAGS.GREEN,
      active: true,
      sector: null,
      reason: 'race-start',
    };
    this.publisher.publishFlag(greenPayload);
    this._totalPublished++;

    // Race start: transizione INIT → RUNNING per tutte le auto
    const timestamp = this.clock.isoNow();
    for (const car of this.cars) {
      const startMessages = car.startRace(this.raceId, timestamp);
      this.publisher.publishCarMessages(startMessages);
      this._countMessages(startMessages);
    }
    this._raceStarted = true;

    // Avvia il tick loop
    this._intervalId = setInterval(() => {
      this._tick();
    }, this.tickMs);

    this.log.info('[Orchestrator] Gara iniziata! 🏁');
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    const elapsed = ((this.clock.nowMs() - this._startTimeMs) / 1000).toFixed(1);
    const flagHistory = this.raceController.history;
    this.log.info(`[Orchestrator] Simulazione terminata dopo ${elapsed}s, ${this._tickCount} tick, ${this._totalPublished} messaggi pubblicati`);
    if (flagHistory.length > 0) {
      this.log.info(`[Orchestrator] Flag history (${flagHistory.length} cambi):`);
      for (const entry of flagHistory) {
        this.log.info(`  ${entry.from} → ${entry.to} [${entry.source}] ${entry.reason || ''}`);
      }
    }
  }

  _tick() {
    const nowMs = this.clock.nowMs();
    const rawDtMs = nowMs - this._lastTickMs;
    this._lastTickMs = nowMs;

    // Clamp dt a [tickMs*0.5, tickMs*2] per stabilita' (§4.1)
    const minDtMs = this.tickMs * 0.5;
    const maxDtMs = this.tickMs * 2;
    const dtMs = Math.max(minDtMs, Math.min(rawDtMs, maxDtMs));
    const dt = dtMs / 1000;

    const timestamp = this.clock.isoNow();
    this._tickCount++;
    this._simulatedTimeS += dt;

    // Controlla se il leader ha completato tutti i giri
    this._updateLeaderLap();

    // --- RACE CONTROL: valuta trigger automatici PRIMA delle auto ---
    const rcResult = this.raceController.tick(this.cars, {
      leaderLap: this._leaderLap,
      totalLaps: this.totalLaps,
      nowS: this._simulatedTimeS,
      timestamp,
    });

    // Se la flag e' cambiata, pubblica su MQTT
    if (rcResult.flagChanged && rcResult.flagPayload) {
      this.publisher.publishFlag(rcResult.flagPayload);
      this._totalPublished++;
    }

    // Aggiorna checkered dal RaceController (sostituisce la logica
    // hardcoded precedente)
    if (this.raceController.activeFlag === FLAGS.CHECKERED) {
      this._checkeredSent = true;
    }

    // Costruisci il contesto globale del tick con le info di Race Control
    const flagCtx = this.raceController.buildFlagContext();
    const ctx = {
      raceId: this.raceId,
      timestamp,
      totalLaps: this.totalLaps,
      checkeredActive: this._checkeredSent,
      leaderLap: this._leaderLap,
      // Contesto Race Control per le auto (Fase 4)
      activeFlag: flagCtx.flag,
      activeFlagSector: flagCtx.sector,
    };

    // Tick di tutte le auto
    let allTerminal = true;
    for (const car of this.cars) {
      try {
        const messages = car.tick(dt, ctx);
        this.publisher.publishCarMessages(messages);
        this._countMessages(messages);

        if (!car.fsm || !car.fsm.state || !(['RETIRED', 'FINISHED'].includes(car.fsm.state))) {
          allTerminal = false;
        }
      } catch (err) {
        this.log.error(`[Orchestrator] Errore in Car ${car.carId}:`, err.message);
        // FSM → FAULT con reason internal-error (§12.2)
        try {
          const { transition: fsmTransition, TRIGGERS } = require('./car/fsm');
          car.fsm = fsmTransition(car.fsm, TRIGGERS.INTERNAL_ERROR, `internal-error:${err.message}`);
        } catch (_) { /* ignora errori nel recovery */ }
      }
    }

    // Log periodico
    if (this._tickCount % (4 * 10) === 0) { // ogni ~10 secondi a 4 Hz
      this._logStatus();
    }

    // Fine gara: tutte le auto in stato terminale
    if (allTerminal && this._raceStarted && !this._raceFinished) {
      this._raceFinished = true;
      this.log.info('[Orchestrator] 🏆 Tutte le auto hanno terminato la gara!');
      this.stop();
    }
  }

  _updateLeaderLap() {
    let maxLap = 0;
    for (const car of this.cars) {
      if (car.fsm.state !== STATES.RETIRED && car.lap > maxLap) {
        maxLap = car.lap;
      }
    }
    this._leaderLap = maxLap;
  }

  _countMessages(messages) {
    if (!messages) return;
    if (messages.telemetry) this._totalPublished++;
    if (messages.state) this._totalPublished++;
    if (Array.isArray(messages.events)) {
      this._totalPublished += messages.events.length;
    }
  }

  _logStatus() {
    const elapsed = ((this.clock.nowMs() - this._startTimeMs) / 1000).toFixed(0);
    const flag = this.raceController.activeFlag;
    const carSummaries = this.cars.map((c) => {
      return `#${c.carId}[${c.fsm.state}:L${c.lap}]`;
    }).join(' ');
    this.log.info(`[Orchestrator] t=${elapsed}s tick=${this._tickCount} pub=${this._totalPublished} flag=${flag} leader=L${this._leaderLap} | ${carSummaries}`);
  }
}

module.exports = Orchestrator;
