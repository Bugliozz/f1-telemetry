// Orchestrator — ciclo tick, lifecycle, fan-out alle Car.
//
// Un solo `setInterval(tickFn, TICK_MS)` gestisce tutte le auto.
// A ogni tick: calcola dt, aggiorna tutte le auto, pubblica i messaggi.
//
// Cfr. docs/simulator-architecture.md §4.

const Car = require('./car/car');
const { createCarPrng } = require('./util/prng');
const { createClock } = require('./util/clock');
const { STATES } = require('./car/fsm');

class Orchestrator {
  constructor({ roster, config, publisher, logger }) {
    this.config = config;
    this.publisher = publisher;
    this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };
    this.clock = createClock();

    this.raceId = config.raceId || 1;
    this.totalLaps = config.totalLaps || 15;
    this.tickMs = config.tickMs || 250;

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

    // Stats
    this._totalPublished = 0;
    this._startTimeMs = null;
  }

  start() {
    this.log.info(`[Orchestrator] Avvio simulazione: ${this.cars.length} auto, ${this.totalLaps} giri, ${1000 / this.tickMs} Hz`);
    this._startTimeMs = this.clock.nowMs();
    this._lastTickMs = this._startTimeMs;

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
    this.log.info(`[Orchestrator] Simulazione terminata dopo ${elapsed}s, ${this._tickCount} tick, ${this._totalPublished} messaggi pubblicati`);
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

    // Controlla se il leader ha completato tutti i giri
    this._updateLeaderLap();

    // Contesto globale del tick
    const ctx = {
      raceId: this.raceId,
      timestamp,
      totalLaps: this.totalLaps,
      checkeredActive: this._checkeredSent,
      leaderLap: this._leaderLap,
    };

    // Attiva checkered flag quando il leader raggiunge totalLaps
    if (!this._checkeredSent && this._leaderLap >= this.totalLaps) {
      this._checkeredSent = true;
      ctx.checkeredActive = true;
      this.log.info(`[Orchestrator] 🏁 CHECKERED FLAG! Leader al giro ${this._leaderLap}`);
    }

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
    const carSummaries = this.cars.map((c) => {
      return `#${c.carId}[${c.fsm.state}:L${c.lap}]`;
    }).join(' ');
    this.log.info(`[Orchestrator] t=${elapsed}s tick=${this._tickCount} pub=${this._totalPublished} leader=L${this._leaderLap} | ${carSummaries}`);
  }
}

module.exports = Orchestrator;
