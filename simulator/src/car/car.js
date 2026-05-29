// Car class — orchestrates the internal state of a single car.
//
// Integrates physics.js, tire-fuel.js, fsm.js and conditions.js into a single
// `tick(dt, ctx)` method that updates state and produces outbound messages
// (telemetry, state, events). No direct I/O: messages are returned
// to the Orchestrator, which forwards them to the MqttPublisher.
//
// See docs/simulator-architecture.md §5 (Car model).

const {
  advance,
  updateSpeed,
  gearForSpeed,
  rpmForSpeed,
  MAX_BRAKE_MS2,
} = require('./physics');
const { initialTireTemp, updateTireTemp, consumeFuel, INITIAL_FUEL_KG } = require('./tire-fuel');
const { COMPOUNDS, buildCompounds, randomCompound, pickDifferentCompound } = require('./compounds');
const { createCarPrng } = require('../util/prng');

// Salt used to derive the per-car tire PRNG from the global seed, so that
// compound draws and wear variance remain reproducible without
// disturbing the main per-car stream that governs physics and faults.
const TIRE_RNG_SALT = 0x7152e;
const TIRE_RNG_CAR_MULTIPLIER = 0x9e3779b1;

function tirePrngCarKey(carId) {
  // The first draws of xorshift32 are correlated for nearby seeds. Mix
  // the car id before the salt to vary the starting compound on the grid.
  return Math.imul(carId | 0, TIRE_RNG_CAR_MULTIPLIER) ^ TIRE_RNG_SALT;
}

function stableUnitForCarId(carId) {
  const text = String(carId == null ? '' : carId);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function driverPerformanceFactor(carId, variancePct) {
  const variance = Number.isFinite(variancePct) && variancePct > 0 ? variancePct : 0;
  if (variance === 0) return 1;
  return 1 + (stableUnitForCarId(carId) * 2 - 1) * variance;
}
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
  constructor({ teamId, carId, driver, rng, config }) {
    this.teamId = teamId;
    this.carId = carId;
    this.driver = driver || `Car ${carId}`;
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.config = config || {};

    // Internal state
    this.fsm = initialFsm();
    this.trackPos = 0;
    this.lap = 0;
    this.speed = 0;          // km/h
    this.tireTemp = initialTireTemp();
    this.condTracker = initialConditionsTracker();

    // Timing
    this.lapStartTimeS = null;
    this.sectorStartTimeS = null;
    this.currentSector = 1;
    this.simulatedTimeS = 0;

    // Per-car variability (computed once, fixed for the entire race)
    const jitterKmh = this.config.speedJitterKmh || 3;
    this._speedOffset = (this.rng() - 0.5) * 2 * jitterKmh;

    const fuelJitterKg = this.config.initialFuelJitterKg || 2;
    this.fuel = Math.max(0, INITIAL_FUEL_KG + (this.rng() - 0.5) * 2 * fuelJitterKg);
    this._teamFactor = (this.config.teamPerformanceFactor && this.config.teamPerformanceFactor[teamId]) || 1.0;
    this._driverFactor = driverPerformanceFactor(
      carId,
      this._numberConfig('driverPerformanceVariancePct', 0.006),
    );

    // Tire compound state: random starting compound, wear accumulator in [0, 1]
    // and a per-car wear multiplier that spreads pit stops across cars on the
    // same compound (see compounds.js §2.2). Drawn from a dedicated stream
    // to remain reproducible from the global seed without shifting the main
    // per-car stream used for physics and faults.
    this._tireRng = createCarPrng(this.config.seed, tirePrngCarKey(carId));
    this._compounds = buildCompounds(this.config.tireCompounds);
    this.compound = randomCompound(this._tireRng);
    this._tireWear = 0;
    const wearVariancePct = this._numberConfig('tireWearVariancePct', 0.15);
    this._wearVariance = 1 + (this._tireRng() - 0.5) * 2 * wearVariancePct;

    // Pit tire-service tracking
    this._pitServiced = false;
    this._tireServiceCompleted = false;
    this._pitEntryLap = null;
  }

  // --- Main tick ---

  tick(dt, ctx) {
    const messages = { telemetry: null, state: null, events: [] };
    const raceId = ctx.raceId || 1;
    const timestamp = ctx.timestamp || new Date().toISOString();

    this.simulatedTimeS += dt;

    // Car in terminal state: no further telemetry (§7.2)
    if (isTerminal(this.fsm.state)) {
      return messages;
    }

    // --- INIT: car stationary on the grid ---
    if (this.fsm.state === STATES.INIT) {
      messages.telemetry = this._buildTelemetry(raceId, timestamp);
      return messages;
    }

    // --- FAULT: decelerating to 0, reduced telemetry ---
    if (this.fsm.state === STATES.FAULT) {
      const prevSpeed = this.speed;
      this.speed = updateSpeed(this.speed, 0, dt);
      const controls = this._controlsForSpeedChange(prevSpeed, this.speed, 0, dt);
      if (this.speed > 0) {
        const posResult = advance({ trackPos: this.trackPos, lap: this.lap }, this.speed, dt);
        this.trackPos = posResult.trackPos;
        this.lap = posResult.lap;
      }

      // Evaluate condition → RETIRED
      const evalResult = evaluate(this.fsm.state, this._buildObservation(ctx), this.condTracker);
      this.condTracker = evalResult.tracker;
      if (evalResult.trigger) {
        this._applyTransition(evalResult.trigger, evalResult.reason, raceId, timestamp, messages);
      }

      messages.telemetry = this._buildTelemetry(raceId, timestamp, controls);
      return messages;
    }

    // --- PIT: speed limited, waiting for the stop timer ---
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

      // Tyre change only: modern F1 pit stops do not refuel.
      // The car rejoins with a *different* compound (F1 rule) and wear accumulator reset.
      // The compound is drawn from the dedicated stream to remain reproducible
      // without shifting the main physics/fault stream (see §2.2).
      if (!this._pitServiced && this._crossedTrackPos(prevPos, posResult, this.config.pitBoxPos || 0.985)) {
        this.tireTemp = initialTireTemp(this.config.tireResetTempC || 90);
        this.compound = pickDifferentCompound(this.compound, this._tireRng);
        this._tireWear = 0;
        this._pitServiced = true;
        this._tireServiceCompleted = true;
        this.speed = 0;
        this.condTracker = onEnterPit(this.condTracker, this.simulatedTimeS, this.condTracker.pitDurationS || 2.4);

        messages.events.push({
          timestamp, raceId, teamId: this.teamId, carId: this.carId,
          type: 'pit-stop',
          details: {
            duration: this.condTracker.pitDurationS || 2.4,
            service: 'tire-change',
            tyreCompound: this.compound,
            refuelling: false,
          },
        });
      }

      // Evaluate condition → pit-out / race end / engine failure
      const evalResult = evaluate(this.fsm.state, this._buildObservation(ctx), this.condTracker);
      this.condTracker = evalResult.tracker;
      if (evalResult.trigger) {
        this._applyTransition(evalResult.trigger, evalResult.reason, raceId, timestamp, messages);
      }

      messages.telemetry = this._buildTelemetry(raceId, timestamp, controls);
      return messages;
    }

    // --- RUNNING: the simulation core ---
    this._tickRunning(dt, ctx, raceId, timestamp, messages);
    return messages;
  }

  // --- RUNNING tick ---

  _tickRunning(dt, ctx, raceId, timestamp, messages) {
    // Target speed from the Monza profile with per-car variability
    const rawTarget = targetSpeed(this.trackPos);
    const adjustedTarget = rawTarget * this._teamFactor * this._driverFactor + this._speedOffset;

    // Instant jitter (micro-variations per tick)
    const instantJitter = (this.rng() - 0.5) * 1.5;
    const nominalTarget = Math.max(0, adjustedTarget + instantJitter);
    const maxRaceSpeed = this._numberConfig('maxRaceSpeedKmh', 350);
    const cappedTarget = Math.min(nominalTarget, maxRaceSpeed);
    const fuelAdjustedTarget = cappedTarget * this._fuelPerformanceMultiplier();
    const yellowLimited = this._isYellowActiveForCurrentSector(ctx);
    const finalTarget = this._applySafetyCarTarget(fuelAdjustedTarget, ctx, yellowLimited);

    const prevSpeed = this.speed;
    this.speed = updateSpeed(this.speed, finalTarget, dt);
    if (ctx.activeFlag === 'VSC') {
      this.speed = Math.min(this.speed, this._virtualSafetyCarSpeedLimit());
    }

    // Throttle and brake derived from physics, then refined with the
    // Monza pedal profile under racing conditions (green flag).
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

    // Controllo attraversamento settore
    this._checkSectorCrossing(posResult, raceId, timestamp, messages);

    // Giro completato
    if (posResult.lapsCompleted > 0) {
      this._onLapCompleted(posResult, raceId, timestamp, messages);
    }

    this.trackPos = posResult.trackPos;
    this.lap = posResult.lap;

    // Tyre wear: accumulates normalised wear in [0, 1] from the compound's
    // per-lap degradation index, scaled by per-car variance and the lap
    // fraction covered this tick. Softer compounds wear out first and reach
    // the pit threshold sooner (see compounds.js §2.3).
    const compound = this._compounds[this.compound] || this._compounds.medium || COMPOUNDS.medium;
    const lapFraction = Math.max(
      0,
      (this.lap + this.trackPos) - (prevPos.lap + prevPos.trackPos),
    );
    this._tireWear = Math.min(
      1,
      this._tireWear + compound.wearPerLap * this._wearVariance * lapFraction,
    );

    // Thermal coupling: a worn tyre heats up more. wearFactor grows from 1
    // (new) toward 1 + thermalGain (fully worn); the gain is small so a
    // normal stint stays in the operating range without triggering a FAULT
    // due to overheating (see tire-fuel.js wearFactor note).
    const thermalGain = this._numberConfig('tireWearThermalGain', 0.15);
    const wearFactor = 1 + this._tireWear * thermalGain;
    const tireTempJitter = this.config.tireTempJitterC || 1.5;

    this.tireTemp = updateTireTemp(this.tireTemp, {
      speedKmh: this.speed,
      throttle,
      brake,
      wearFactor,
    }, dt);

    // Left/right asymmetry (realistic: right-hand corners load the left side more)
    const lrBias = (this.rng() - 0.5) * tireTempJitter;
    this.tireTemp = {
      fl: this.tireTemp.fl + lrBias * 0.3,
      fr: this.tireTemp.fr - lrBias * 0.3,
      rl: this.tireTemp.rl + lrBias * 0.2,
      rr: this.tireTemp.rr - lrBias * 0.2,
    };

    // Fuel consumption with variability
    const fuelJitter = 1 + (this.rng() - 0.5) * 2 * (this.config.fuelRateJitterPct || 0.05);
    this.fuel = consumeFuel(this.fuel, {
      speedKmh: this.speed * fuelJitter,
      throttle,
    }, dt);

    if (this._isOutOfFuel()) {
      this._applyTransition(TRIGGERS.MANUAL_RETIRE, 'out-of-fuel', raceId, timestamp, messages);
      messages.telemetry = this._buildTelemetry(raceId, timestamp, {
        throttle: 0,
        brake: 1,
        drsAllowed: false,
      });
      return;
    }

    // Evaluate FSM transition conditions
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

  // --- Helper functions ---

  _fuelPerformanceMultiplier() {
    const fuel = Number.isFinite(this.fuel) ? this.fuel : INITIAL_FUEL_KG;
    const lowThreshold = Math.max(0, this._numberConfig('lowFuelWarningThresholdKg', 12));
    const criticalThreshold = Math.max(0, this._numberConfig('criticalFuelThresholdKg', 3));
    const lowMultiplier = Math.max(0, Math.min(1, this._numberConfig('lowFuelSpeedMultiplier', 0.97)));
    const criticalMultiplier = Math.max(0, Math.min(1, this._numberConfig('criticalFuelSpeedMultiplier', 0.85)));

    if (fuel <= criticalThreshold) return criticalMultiplier;
    if (fuel <= lowThreshold) return lowMultiplier;
    return 1;
  }

  _isOutOfFuel() {
    const fuel = Number.isFinite(this.fuel) ? this.fuel : INITIAL_FUEL_KG;
    const threshold = Math.max(0, this._numberConfig('outOfFuelThresholdKg', 0.1));
    return fuel <= threshold;
  }

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

    // Outside braking zones, avoid small brake corrections caused by
    // target jitter: in a real race the driver stays on the throttle.
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
      totalLaps: ctx.totalLaps || 5,
      checkeredActive: ctx.checkeredActive || false,
      nowS: this.simulatedTimeS,
      rng: this.rng,
      pitEntryPos: this.config.pitEntryPos,
      pitExitReached: ctx && ctx.activeFlag === 'RED' ? false : this._pitExitReached(),
      tireWear: this._tireWear,
      tireWearPitThreshold: this.config.tireWearPitThreshold,
      tireServiceCompleted: this._tireServiceCompleted === true,
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

    // DRS active only in RUNNING state on straights
    let drs = false;
    if (this.fsm.state === STATES.RUNNING && controls.drsAllowed !== false && Array.isArray(this.config.drsZones)) {
      for (const zone of this.config.drsZones) {
        if (this.trackPos >= zone.start && this.trackPos <= zone.end) {
          drs = true;
          break;
        }
      }
    }

    // Throttle/brake for telemetry
    const rawTarget = targetSpeed(this.trackPos);
    const diff = rawTarget * this._teamFactor * this._driverFactor - this.speed;
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
      compound: this.compound,
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
      // Wear per corner: FL/RL most loaded at Monza (right chicanes + braking zones).
      tireWear: {
        fl: Math.round(Math.min(1, this._tireWear * 1.04) * 1000) / 1000,
        fr: Math.round(Math.min(1, this._tireWear * 0.97) * 1000) / 1000,
        rl: Math.round(Math.min(1, this._tireWear * 1.00) * 1000) / 1000,
        rr: Math.round(Math.min(1, this._tireWear * 0.99) * 1000) / 1000,
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

    // Post-transition: initialise the timer
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
        details: { lap: this.lap },
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
        details: { lap: this.lap },
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
      { id: 1, start: 0, end: 0.330, label: 'Prima Variante / Roggia' },
      { id: 2, start: 0.330, end: 0.660, label: 'Lesmo / Serraglio' },
      { id: 3, start: 0.660, end: 1.000, label: 'Ascari / Parabolica' },
    ];

    const newSector = this._getSector(posResult.trackPos, sectors);
    if (newSector !== this.currentSector) {
      const sectorTime = this.sectorStartTimeS != null
        ? this.simulatedTimeS - this.sectorStartTimeS
        : 0;

      if (sectorTime > 0) {
        const completedSector = sectors.find((sector) => sector.id === this.currentSector);
        const details = {
          sector: this.currentSector,
          sectorTime: Math.round(sectorTime * 1000) / 1000,
        };
        if (completedSector && completedSector.label) {
          details.sectorName = completedSector.label;
        }

        messages.events.push({
          timestamp, raceId, teamId: this.teamId, carId: this.carId,
          type: 'sector-completed',
          details,
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
    return 3; // Fallback: end of lap
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

  // Race start trigger (called by the Orchestrator)
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
