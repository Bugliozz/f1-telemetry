// Classe Car — orchestratore dello stato interno di una singola auto.
//
// Integra physics.js, tire-fuel.js, fsm.js e conditions.js in un unico
// metodo `tick(dt, ctx)` che aggiorna lo stato e produce i messaggi
// pendenti (telemetry, state, events). Nessun I/O diretto: i messaggi
// vengono ritornati all'Orchestrator che li passa al MqttPublisher.
//
// Cfr. docs/simulator-architecture.md §5 (Modello dell'auto).

const { advance, updateSpeed, gearForSpeed, rpmForSpeed } = require('./physics');
const { initialTireTemp, updateTireTemp, consumeFuel, INITIAL_FUEL_KG } = require('./tire-fuel');
const { initialFsm, transition, STATES, TRIGGERS, isTerminal } = require('./fsm');
const {
  initialConditionsTracker,
  evaluate,
  onEnterPit,
  onEnterFault,
  samplePitDurationS,
} = require('./conditions');
const { targetSpeed } = require('../track/monza');

class Car {
  constructor({ teamId, carId, driver, pitStrategy, rng, config }) {
    this.teamId = teamId;
    this.carId = carId;
    this.driver = driver || `Car ${carId}`;
    this.pitStrategy = Array.isArray(pitStrategy) ? pitStrategy : [];
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.config = config || {};

    // Stato interno
    this.fsm = initialFsm();
    this.trackPos = 0;
    this.lap = 0;
    this.speed = 0;          // km/h
    this.tireTemp = initialTireTemp();
    this.fuel = INITIAL_FUEL_KG;
    this.condTracker = initialConditionsTracker();

    // Timing
    this.lapStartTimeS = null;
    this.sectorStartTimeS = null;
    this.currentSector = 1;
    this.simulatedTimeS = 0;

    // Variabilita' per-auto (calcolata una volta, fissa per tutta la gara)
    const jitterKmh = config.speedJitterKmh || 3;
    this._speedOffset = (this.rng() - 0.5) * 2 * jitterKmh;
    this._teamFactor = (config.teamPerformanceFactor && config.teamPerformanceFactor[teamId]) || 1.0;

    // Pit refuel/reset tracking
    this._pitRefueled = false;
  }

  // --- Tick principale ---

  tick(dt, ctx) {
    const messages = { telemetry: null, state: null, events: [] };
    const raceId = ctx.raceId || 1;
    const timestamp = ctx.timestamp || new Date().toISOString();

    this.simulatedTimeS += dt;

    // Auto in stato terminale: niente piu' telemetria (§7.2)
    if (isTerminal(this.fsm.state)) {
      return messages;
    }

    // --- INIT: auto ferma in griglia ---
    if (this.fsm.state === STATES.INIT) {
      messages.telemetry = this._buildTelemetry(raceId, timestamp);
      return messages;
    }

    // --- FAULT: decelera a 0, telemetria ridotta ---
    if (this.fsm.state === STATES.FAULT) {
      this.speed = updateSpeed(this.speed, 0, dt);
      if (this.speed > 0) {
        const posResult = advance({ trackPos: this.trackPos, lap: this.lap }, this.speed, dt);
        this.trackPos = posResult.trackPos;
        this.lap = posResult.lap;
      }

      // Valuta condizione → RETIRED
      const evalResult = evaluate(this.fsm.state, this._buildObservation(ctx), this.condTracker);
      this.condTracker = evalResult.tracker;
      if (evalResult.trigger) {
        this._applyTransition(evalResult.trigger, evalResult.reason, raceId, timestamp, messages);
      }

      messages.telemetry = this._buildTelemetry(raceId, timestamp);
      return messages;
    }

    // --- PIT: velocita' limitata, attende timer ---
    if (this.fsm.state === STATES.PIT) {
      const pitTarget = this.config.pitLaneSpeedKmh || 80;
      this.speed = updateSpeed(this.speed, pitTarget, dt);

      const posResult = advance({ trackPos: this.trackPos, lap: this.lap }, this.speed, dt);
      this._checkSectorCrossing(posResult, raceId, timestamp, messages);
      if (posResult.lapsCompleted > 0) {
        this._onLapCompleted(posResult, raceId, timestamp, messages);
      }
      this.trackPos = posResult.trackPos;
      this.lap = posResult.lap;

      // Refuel e reset gomme (una volta sola durante il pit)
      if (!this._pitRefueled) {
        this.fuel = Math.min(INITIAL_FUEL_KG, this.fuel + (this.config.fuelAddedOnPit || 50));
        this.tireTemp = initialTireTemp(this.config.tireResetTempC || 90);
        this._pitRefueled = true;

        messages.events.push({
          timestamp, raceId, teamId: this.teamId, carId: this.carId,
          type: 'pit-stop',
          details: {
            duration: this.condTracker.pitDurationS || 2.4,
            tyreCompound: 'medium',
            fuelAdded: this.config.fuelAddedOnPit || 50,
          },
        });
      }

      // Valuta condizione → pit-out / race-end / engine-failure
      const evalResult = evaluate(this.fsm.state, this._buildObservation(ctx), this.condTracker);
      this.condTracker = evalResult.tracker;
      if (evalResult.trigger) {
        this._applyTransition(evalResult.trigger, evalResult.reason, raceId, timestamp, messages);
      }

      messages.telemetry = this._buildTelemetry(raceId, timestamp);
      return messages;
    }

    // --- RUNNING: il cuore della simulazione ---
    this._tickRunning(dt, ctx, raceId, timestamp, messages);
    return messages;
  }

  // --- RUNNING tick ---

  _tickRunning(dt, ctx, raceId, timestamp, messages) {
    // Target speed dal profilo Monza con variabilita'
    const rawTarget = targetSpeed(this.trackPos);
    const adjustedTarget = rawTarget * this._teamFactor + this._speedOffset;

    // Jitter istantaneo (micro-variazioni per tick)
    const instantJitter = (this.rng() - 0.5) * 1.5;
    const finalTarget = Math.max(0, adjustedTarget + instantJitter);

    this.speed = updateSpeed(this.speed, finalTarget, dt);

    // Throttle e brake derivati (§5.1)
    const speedDiff = finalTarget - this.speed;
    let throttle, brake;
    if (speedDiff >= 0) {
      throttle = Math.min(1, 0.3 + speedDiff / 50);
      brake = 0;
    } else {
      throttle = 0;
      brake = Math.min(1, Math.abs(speedDiff) / 80);
    }

    // Avanzamento posizione
    const posResult = advance({ trackPos: this.trackPos, lap: this.lap }, this.speed, dt);

    // Controllo settori
    this._checkSectorCrossing(posResult, raceId, timestamp, messages);

    // Lap completed
    if (posResult.lapsCompleted > 0) {
      this._onLapCompleted(posResult, raceId, timestamp, messages);
    }

    this.trackPos = posResult.trackPos;
    this.lap = posResult.lap;

    // Degrado gomme con variabilita'
    const wearPerLap = this.config.wearPerLap || 0.03;
    const wearFactor = 1 + this.lap * wearPerLap;
    const tireTempJitter = this.config.tireTempJitterC || 1.5;

    this.tireTemp = updateTireTemp(this.tireTemp, {
      speedKmh: this.speed,
      throttle,
      brake,
      wearFactor,
    }, dt);

    // Asimmetria left/right (realistica: curva a destra carica piu' il lato sinistro)
    const lrBias = (this.rng() - 0.5) * tireTempJitter;
    this.tireTemp = {
      fl: this.tireTemp.fl + lrBias * 0.3,
      fr: this.tireTemp.fr - lrBias * 0.3,
      rl: this.tireTemp.rl + lrBias * 0.2,
      rr: this.tireTemp.rr - lrBias * 0.2,
    };

    // Consumo carburante con variabilita'
    const fuelJitter = 1 + (this.rng() - 0.5) * 2 * (this.config.fuelRateJitterPct || 0.05);
    this.fuel = consumeFuel(this.fuel, {
      speedKmh: this.speed * fuelJitter,
      throttle,
    }, dt);

    // Valuta condizioni di transizione FSM
    const evalResult = evaluate(this.fsm.state, this._buildObservation(ctx), this.condTracker);
    this.condTracker = evalResult.tracker;
    if (evalResult.trigger) {
      this._applyTransition(evalResult.trigger, evalResult.reason, raceId, timestamp, messages);
    }

    messages.telemetry = this._buildTelemetry(raceId, timestamp);
  }

  // --- Helpers ---

  _buildObservation(ctx) {
    return {
      fuel: this.fuel,
      tireTemp: this.tireTemp,
      lap: this.lap,
      totalLaps: ctx.totalLaps || 15,
      checkeredActive: ctx.checkeredActive || false,
      nowS: this.simulatedTimeS,
      rng: this.rng,
      scheduledPitLaps: this.pitStrategy,
      fuelPitThreshold: this.config.fuelPitThresholdKg,
      tireOverheatThreshold: this.config.tireOverheatThresholdC,
      tireOverheatTicksRequired: this.config.tireOverheatTicksRequired,
      engineFailureProb: this.config.engineFailureProbPerTick,
      faultDiagnoseS: this.config.faultDiagnoseS,
    };
  }

  _buildTelemetry(raceId, timestamp) {
    const rpmJitter = (this.rng() - 0.5) * 2 * (this.config.rpmJitterRange || 200);
    const gear = this.fsm.state === STATES.INIT ? 0 : gearForSpeed(this.speed);
    const rpm = this.fsm.state === STATES.INIT ? 0 : rpmForSpeed(this.speed, rpmJitter);

    // DRS attivo solo in RUNNING sui rettilinei lunghi
    let drs = false;
    if (this.fsm.state === STATES.RUNNING && Array.isArray(this.config.drsZones)) {
      for (const zone of this.config.drsZones) {
        if (this.trackPos >= zone.start && this.trackPos <= zone.end) {
          drs = true;
          break;
        }
      }
    }

    // Throttle/brake per telemetria
    const rawTarget = targetSpeed(this.trackPos);
    const diff = rawTarget * this._teamFactor - this.speed;
    let throttle, brake;
    if (this.fsm.state === STATES.INIT || this.fsm.state === STATES.FAULT) {
      throttle = 0;
      brake = this.fsm.state === STATES.FAULT ? 0.8 : 0;
    } else if (diff >= 0) {
      throttle = Math.min(1, 0.3 + diff / 50);
      brake = 0;
    } else {
      throttle = 0;
      brake = Math.min(1, Math.abs(diff) / 80);
    }

    return {
      timestamp,
      raceId,
      teamId: this.teamId,
      carId: this.carId,
      lap: this.lap,
      trackPos: Math.round(this.trackPos * 10000) / 10000,
      speed: Math.round(this.speed * 10) / 10,
      rpm,
      gear,
      throttle: Math.round(throttle * 100) / 100,
      brake: Math.round(brake * 100) / 100,
      drs,
      tireTemp: {
        fl: Math.round(this.tireTemp.fl * 10) / 10,
        fr: Math.round(this.tireTemp.fr * 10) / 10,
        rl: Math.round(this.tireTemp.rl * 10) / 10,
        rr: Math.round(this.tireTemp.rr * 10) / 10,
      },
      fuel: Math.round(this.fuel * 10) / 10,
      state: this.fsm.state,
    };
  }

  _applyTransition(trigger, reason, raceId, timestamp, messages) {
    const fsmResult = transition(this.fsm, trigger, reason);
    if (!fsmResult.changed) return;

    this.fsm = fsmResult;

    // State message (retained)
    messages.state = {
      timestamp,
      raceId,
      teamId: this.teamId,
      carId: this.carId,
      state: fsmResult.state,
      previousState: fsmResult.previousState,
      reason: fsmResult.reason,
    };

    // State-change event
    messages.events.push({
      timestamp, raceId, teamId: this.teamId, carId: this.carId,
      type: 'state-change',
      details: {
        from: fsmResult.previousState,
        to: fsmResult.state,
        reason: fsmResult.reason,
      },
    });

    // Post-transizione: inizializza timer
    if (fsmResult.state === STATES.PIT) {
      const pitDuration = samplePitDurationS(this.rng,
        this.config.pitDurationMinS, this.config.pitDurationMaxS);
      this.condTracker = onEnterPit(this.condTracker, this.simulatedTimeS, pitDuration);
      this._pitRefueled = false;

      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'pit-entry',
        details: {},
      });
    }

    if (fsmResult.state === STATES.FAULT) {
      this.condTracker = onEnterFault(this.condTracker, this.simulatedTimeS);

      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'fault',
        details: { reason: fsmResult.reason },
      });
    }

    if (fsmResult.state === STATES.RETIRED) {
      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'retirement',
        details: { reason: fsmResult.reason },
      });
    }

    if (fsmResult.previousState === STATES.PIT && fsmResult.state === STATES.RUNNING) {
      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'pit-exit',
        details: {},
      });
    }
  }

  _checkSectorCrossing(posResult, raceId, timestamp, messages) {
    const sectors = this.config.sectors || [
      { id: 1, start: 0, end: 0.330 },
      { id: 2, start: 0.330, end: 0.660 },
      { id: 3, start: 0.660, end: 1.000 },
    ];

    const newSector = this._getSector(posResult.trackPos, sectors);
    if (newSector !== this.currentSector) {
      const sectorTime = this.sectorStartTimeS != null
        ? this.simulatedTimeS - this.sectorStartTimeS
        : 0;

      if (sectorTime > 0) {
        messages.events.push({
          timestamp, raceId, teamId: this.teamId, carId: this.carId,
          type: 'sector-completed',
          details: {
            sector: this.currentSector,
            sectorTime: Math.round(sectorTime * 1000) / 1000,
          },
        });
      }

      this.currentSector = newSector;
      this.sectorStartTimeS = this.simulatedTimeS;
    }
  }

  _getSector(trackPos, sectors) {
    for (const s of sectors) {
      if (trackPos >= s.start && trackPos < s.end) return s.id;
    }
    return 3; // Fallback: fine giro
  }

  _onLapCompleted(posResult, raceId, timestamp, messages) {
    const lapTime = this.lapStartTimeS != null
      ? this.simulatedTimeS - this.lapStartTimeS
      : 0;

    if (lapTime > 0 && this.lap > 0) {
      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'lap-completed',
        details: {
          lap: this.lap,
          lapTime: Math.round(lapTime * 1000) / 1000,
        },
      });
    }

    this.lapStartTimeS = this.simulatedTimeS;
    this.sectorStartTimeS = this.simulatedTimeS;
    this.currentSector = 1;
  }

  // Race start trigger (chiamato dall'Orchestrator)
  startRace(raceId, timestamp) {
    const messages = { telemetry: null, state: null, events: [] };
    this._applyTransition(TRIGGERS.RACE_START, 'race-start', raceId, timestamp, messages);
    this.lapStartTimeS = this.simulatedTimeS;
    this.sectorStartTimeS = this.simulatedTimeS;
    return messages;
  }
}

module.exports = Car;
