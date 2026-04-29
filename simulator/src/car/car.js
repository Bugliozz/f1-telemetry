// Classe Car — orchestratore dello stato interno di una singola auto.
//
// Integra physics.js, tire-fuel.js, fsm.js e conditions.js in un unico
// metodo `tick(dt, ctx)` che aggiorna lo stato e produce i messaggi
// pendenti (telemetry, state, events). Nessun I/O diretto: i messaggi
// vengono ritornati all'Orchestrator che li passa al MqttPublisher.
//
// Cfr. docs/simulator-architecture.md §5 (Modello dell'auto).

const {
  advance,
  updateSpeed,
  gearForSpeed,
  rpmForSpeed,
  MAX_BRAKE_MS2,
} = require('./physics');
const { initialTireTemp, updateTireTemp, consumeFuel, INITIAL_FUEL_KG } = require('./tire-fuel');
const { initialFsm, transition, STATES, TRIGGERS, isTerminal } = require('./fsm');
const {
  initialConditionsTracker,
  evaluate,
  onEnterPit,
  onEnterFault,
  samplePitDurationS,
} = require('./conditions');
const { LENGTH_M, targetSpeed, racingControls } = require('../track/monza');

const MS2_TO_KMH_PER_S = 3.6;

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
    const jitterKmh = this.config.speedJitterKmh || 3;
    this._speedOffset = (this.rng() - 0.5) * 2 * jitterKmh;
    this._teamFactor = (this.config.teamPerformanceFactor && this.config.teamPerformanceFactor[teamId]) || 1.0;

    // Pit refuel/reset tracking
    this._pitServiced = false;
    this._pitEntryLap = null;
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
      const prevSpeed = this.speed;
      this.speed = updateSpeed(this.speed, 0, dt);
      const controls = this._controlsForSpeedChange(prevSpeed, this.speed, 0, dt);
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

      messages.telemetry = this._buildTelemetry(raceId, timestamp, controls);
      return messages;
    }

    // --- PIT: velocita' limitata, attende timer ---
    if (this.fsm.state === STATES.PIT) {
      const pitTarget = this.config.pitLaneSpeedKmh || 80;
      const pitStopElapsed = this._pitServiced && this.condTracker.pitEnteredAtS != null
        && (this.simulatedTimeS - this.condTracker.pitEnteredAtS) >= (this.condTracker.pitDurationS || 0);
      const redSuspended = ctx && ctx.activeFlag === 'RED';
      const target = redSuspended ? 0 : (this._pitServiced && !pitStopElapsed ? 0 : pitTarget);
      const prevSpeed = this.speed;
      this.speed = updateSpeed(this.speed, target, dt);
      const controls = this._controlsForSpeedChange(prevSpeed, this.speed, target, dt);
      if (!redSuspended && target === pitTarget && this.speed > pitTarget) this.speed = pitTarget;

      const prevPos = { trackPos: this.trackPos, lap: this.lap };
      const posResult = advance(prevPos, this.speed, dt);
      this._checkSectorCrossing(posResult, raceId, timestamp, messages);
      if (posResult.lapsCompleted > 0) {
        this._onLapCompleted(posResult, raceId, timestamp, messages);
      }
      this.trackPos = posResult.trackPos;
      this.lap = posResult.lap;

      // Refuel e reset gomme solo quando viene raggiunta la box position.
      if (!this._pitServiced && this._crossedTrackPos(prevPos, posResult, this.config.pitBoxPos || 0.985)) {
        this.fuel = Math.min(INITIAL_FUEL_KG, this.fuel + (this.config.fuelAddedOnPit || 50));
        this.tireTemp = initialTireTemp(this.config.tireResetTempC || 90);
        this._pitServiced = true;
        this.speed = 0;
        this.condTracker = onEnterPit(this.condTracker, this.simulatedTimeS, this.condTracker.pitDurationS || 2.4);

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

      messages.telemetry = this._buildTelemetry(raceId, timestamp, controls);
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
    const nominalTarget = Math.max(0, adjustedTarget + instantJitter);
    const maxRaceSpeed = this._numberConfig('maxRaceSpeedKmh', 350);
    const cappedTarget = Math.min(nominalTarget, maxRaceSpeed);
    const yellowLimited = this._isYellowActiveForCurrentSector(ctx);
    const finalTarget = this._applySafetyCarTarget(cappedTarget, ctx, yellowLimited);

    const prevSpeed = this.speed;
    this.speed = updateSpeed(this.speed, finalTarget, dt);
    if (ctx.activeFlag === 'VSC') {
      this.speed = Math.min(this.speed, this._virtualSafetyCarSpeedLimit());
    }

    // Throttle e brake derivati dalla fisica, poi rifiniti con il profilo
    // pedali di Monza in condizioni di gara verde.
    let { throttle, brake } = this._controlsForSpeedChange(prevSpeed, this.speed, finalTarget, dt);
    ({ throttle, brake } = this._applyRacingControls({ throttle, brake }, ctx, yellowLimited));

    // Avanzamento posizione
    const prevPos = { trackPos: this.trackPos, lap: this.lap };
    let posResult = advance(prevPos, this.speed, dt);
    const vscClamp = this._clampVirtualSafetyCarOvertake(prevPos, posResult, ctx, dt);
    posResult = vscClamp.position;
    if (vscClamp.speedKmh != null) {
      this.speed = vscClamp.speedKmh;
      ({ throttle, brake } = this._controlsForSpeedChange(prevSpeed, this.speed, finalTarget, dt));
    }

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

    messages.telemetry = this._buildTelemetry(raceId, timestamp, {
      throttle,
      brake,
      drsAllowed: ctx.activeFlag !== 'SC' && ctx.activeFlag !== 'VSC' &&
        ctx.activeFlag !== 'RED' && !yellowLimited,
    });
  }

  // --- Helpers ---

  _applySafetyCarTarget(targetKmh, ctx, yellowLimited = false) {
    if (ctx && ctx.activeFlag === 'RED') {
      return 0;
    }

    if (yellowLimited) {
      const multiplier = Math.max(0, Math.min(1, this._numberConfig('yellowSpeedMultiplier', 0.6)));
      return targetKmh * multiplier;
    }

    if (ctx && ctx.activeFlag === 'VSC') {
      return Math.min(targetKmh, this._virtualSafetyCarSpeedLimit());
    }

    if (!ctx || ctx.activeFlag !== 'SC') {
      return targetKmh;
    }

    const limit = Math.max(0, this._numberConfig('safetyCarSpeedKmh', 140));
    const catchupMax = Math.max(limit, this._numberConfig('safetyCarCatchupSpeedKmh', 180));
    const targetGapS = Math.max(0, this._numberConfig('safetyCarTargetGapS', 0.5));
    const gainKmhPerS = Math.max(0, this._numberConfig('safetyCarGapGainKmhPerS', 12));
    const slowdownKmhPerS = Math.max(0, this._numberConfig('safetyCarCloseGapSlowdownKmhPerS', 60));
    const minSpeed = Math.max(0, this._numberConfig('safetyCarMinSpeedKmh', 60));

    const baseTarget = Math.min(targetKmh, limit);
    const sc = ctx.safetyCar || {};
    if (sc.isLeader || !Number.isFinite(sc.gapToCarAheadS)) {
      return baseTarget;
    }

    const gapErrorS = sc.gapToCarAheadS - targetGapS;
    if (gapErrorS > 0) {
      const boost = Math.min(catchupMax - limit, gapErrorS * gainKmhPerS);
      return Math.min(targetKmh, limit + boost);
    }

    if (gapErrorS < 0) {
      const floor = Math.min(baseTarget, minSpeed);
      const drop = Math.min(baseTarget - floor, Math.abs(gapErrorS) * slowdownKmhPerS);
      return Math.max(floor, baseTarget - drop);
    }

    return baseTarget;
  }

  _virtualSafetyCarSpeedLimit() {
    return Math.max(0, this._numberConfig('virtualSafetyCarSpeedKmh', 120));
  }

  _isYellowActiveForCurrentSector(ctx) {
    if (!ctx || ctx.activeFlag !== 'YELLOW') return false;
    if (ctx.activeFlagSector == null) return true;
    return Number(ctx.activeFlagSector) === this.currentSector;
  }

  _clampVirtualSafetyCarOvertake(prevPos, posResult, ctx, dt) {
    const unchanged = { position: posResult, speedKmh: null };
    if (!ctx || ctx.activeFlag !== 'VSC') return unchanged;

    const vsc = ctx.virtualSafetyCar || {};
    if (vsc.isLeader || !Number.isFinite(vsc.maxProgress)) return unchanged;

    const prevProgress = prevPos.lap + prevPos.trackPos;
    const nextProgress = posResult.lap + posResult.trackPos;
    const allowedProgress = Math.max(prevProgress, vsc.maxProgress);
    if (nextProgress <= allowedProgress) return unchanged;

    const lap = Math.max(0, Math.floor(allowedProgress));
    const trackPos = allowedProgress - lap;
    const lapsCompleted = Math.max(0, lap - prevPos.lap);
    const distanceM = Math.max(0, (allowedProgress - prevProgress) * LENGTH_M);
    const speedKmh = dt > 0 ? (distanceM / dt) * 3.6 : 0;

    return {
      position: { trackPos, lap, lapsCompleted },
      speedKmh: Math.min(speedKmh, this._virtualSafetyCarSpeedLimit()),
    };
  }

  _numberConfig(name, fallback) {
    const value = this.config ? this.config[name] : undefined;
    return Number.isFinite(value) ? value : fallback;
  }

  _applyRacingControls(baseControls, ctx, yellowLimited) {
    const baseThrottle = Math.max(0, Math.min(1, baseControls && baseControls.throttle || 0));
    const baseBrake = Math.max(0, Math.min(1, baseControls && baseControls.brake || 0));

    const activeFlag = ctx && ctx.activeFlag;
    const greenTrack = !activeFlag || activeFlag === 'GREEN' || activeFlag === 'CHECKERED';
    if (!greenTrack || yellowLimited) {
      return { throttle: baseThrottle, brake: baseBrake };
    }

    const racing = racingControls(this.trackPos);
    const racingBrake = Math.max(0, Math.min(1, racing.brake || 0));
    if (racingBrake > 0) {
      return {
        throttle: 0,
        brake: Math.max(baseBrake, racingBrake),
      };
    }

    // Fuori dalle braking zone evitiamo piccole correzioni di freno prodotte
    // dal jitter del target: in gara reale il pilota resta sul gas.
    if (baseBrake > 0.25) {
      return { throttle: 0, brake: baseBrake };
    }

    const racingThrottle = Math.max(0, Math.min(1, racing.throttle || 0));
    return {
      throttle: racing.phase === 'throttle-ramp'
        ? racingThrottle
        : Math.max(baseThrottle, racingThrottle),
      brake: 0,
    };
  }

  _controlsForSpeedChange(previousSpeedKmh, nextSpeedKmh, targetSpeedKmh, dt) {
    const previous = Math.max(0, Number.isFinite(previousSpeedKmh) ? previousSpeedKmh : 0);
    const next = Math.max(0, Number.isFinite(nextSpeedKmh) ? nextSpeedKmh : previous);
    const target = Math.max(0, Number.isFinite(targetSpeedKmh) ? targetSpeedKmh : next);
    const safeDt = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const brakeCap = MAX_BRAKE_MS2 * MS2_TO_KMH_PER_S * safeDt;
    const actualDelta = next - previous;
    const targetDelta = target - previous;
    const epsilon = 0.25;

    if (actualDelta < -epsilon || targetDelta < -epsilon) {
      const brakeDemand = Math.max(previous - next, previous - target, 0);
      const scaledBrake = brakeCap > 0 ? brakeDemand / brakeCap : brakeDemand / 80;
      return {
        throttle: 0,
        brake: Math.max(0, Math.min(1, scaledBrake)),
      };
    }

    if (actualDelta > epsilon || targetDelta > epsilon) {
      const throttleDemand = Math.max(actualDelta, targetDelta, 0);
      return {
        throttle: Math.max(0, Math.min(1, 0.3 + throttleDemand / 50)),
        brake: 0,
      };
    }

    return {
      throttle: previous > 0 ? 0.3 : 0,
      brake: 0,
    };
  }

  _buildObservation(ctx) {
    return {
      fuel: this.fuel,
      tireTemp: this.tireTemp,
      lap: this.lap,
      trackPos: this.trackPos,
      totalLaps: ctx.totalLaps || 15,
      checkeredActive: ctx.checkeredActive || false,
      nowS: this.simulatedTimeS,
      rng: this.rng,
      scheduledPitLaps: this.pitStrategy,
      pitEntryPos: this.config.pitEntryPos,
      pitExitReached: ctx && ctx.activeFlag === 'RED' ? false : this._pitExitReached(),
      fuelPitThreshold: this.config.fuelPitThresholdKg,
      tireOverheatThreshold: this.config.tireOverheatThresholdC,
      tireOverheatTicksRequired: this.config.tireOverheatTicksRequired,
      engineFailureProb: this.config.engineFailureProbPerTick,
      faultGraceS: this.config.faultGraceS,
      faultDiagnoseS: this.config.faultDiagnoseS,
    };
  }

  _buildTelemetry(raceId, timestamp, controls = {}) {
    const rpmJitter = (this.rng() - 0.5) * 2 * (this.config.rpmJitterRange || 200);
    const gear = this.fsm.state === STATES.INIT ? 0 : gearForSpeed(this.speed);
    const rpm = this.fsm.state === STATES.INIT ? 0 : rpmForSpeed(this.speed, rpmJitter);

    // DRS attivo solo in RUNNING sui rettilinei lunghi
    let drs = false;
    if (this.fsm.state === STATES.RUNNING && controls.drsAllowed !== false && Array.isArray(this.config.drsZones)) {
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
    if (Number.isFinite(controls.throttle) && Number.isFinite(controls.brake)) {
      throttle = Math.max(0, Math.min(1, controls.throttle));
      brake = Math.max(0, Math.min(1, controls.brake));
    } else if (this.fsm.state === STATES.INIT || this.fsm.state === STATES.FAULT) {
      throttle = 0;
      brake = this.fsm.state === STATES.FAULT ? 0.8 : 0;
    } else if (diff >= 0) {
      throttle = Math.min(1, 0.3 + diff / 50);
      brake = 0;
    } else {
      throttle = 0;
      brake = Math.min(1, Math.abs(diff) / 80);
    }

    if (brake > 0.05) {
      drs = false;
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
      this.condTracker = {
        ...this.condTracker,
        pitEnteredAtS: null,
        pitDurationS: pitDuration,
      };
      this._pitServiced = false;
      this._pitEntryLap = this.lap;

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
      this._pitEntryLap = null;
      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'pit-exit',
        details: {},
      });
    }
  }

  _crossedTrackPos(prev, next, targetPos) {
    const target = Number.isFinite(targetPos) ? targetPos : 0;
    if (!prev || !next) return false;
    if (next.lap > prev.lap) {
      return prev.trackPos <= target || next.trackPos >= target;
    }
    return prev.trackPos <= target && next.trackPos >= target;
  }

  _pitExitReached() {
    if (this._pitEntryLap == null) return true;
    const pitExitPos = this.config.pitExitPos || 0.04;
    return this._pitServiced && this.lap > this._pitEntryLap && this.trackPos >= pitExitPos;
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

    const completedLap = posResult.lap;

    if (lapTime > 0 && completedLap > 0) {
      messages.events.push({
        timestamp, raceId, teamId: this.teamId, carId: this.carId,
        type: 'lap-completed',
        details: {
          lap: completedLap,
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

  forceFault(raceId, timestamp, reason) {
    const messages = { telemetry: null, state: null, events: [] };
    this._applyTransition(TRIGGERS.INTERNAL_ERROR, reason || 'scenario-fault', raceId, timestamp, messages);
    return messages;
  }
}

module.exports = Car;
