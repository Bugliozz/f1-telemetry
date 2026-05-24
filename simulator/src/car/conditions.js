// Car FSM state transition conditions.
//
// Pure module, without I/O and without input mutations. Consistent with
// `fsm.js`, `physics.js`, `tire-fuel.js`: the orchestrator passes the current
// state plus a tick observation and receives an optional trigger to apply
// to the FSM.
//
// Source: docs/simulator-architecture.md §7.1 (transition table).
//
//   | From        | To       | Condition                                                     | reason            |
//   |-------------|----------|---------------------------------------------------------------|-------------------|
//   | RUNNING     | PIT      | tire wear >= pit threshold and pit-entry window               | tire-service      |
//   | PIT         | RUNNING  | pit timer elapsed (2.0-3.5 s sampled randomly)                | pit-out           |
//   | RUNNING     | FAULT    | max(tireTemp) > 180 C for 3 consecutive ticks                 | tire-overheat     |
//   | RUNNING/PIT | FAULT    | random engine failure (probability < 1e-4 per tick)           | engine-failure    |
//   | FAULT       | RETIRED  | diagnostic timer >= 5 s (every fault is unrecoverable)        | unrecoverable     |
//   | RUNNING/PIT | FINISHED | lap >= TOTAL_LAPS && CHECKERED flag received                  | race-end          |
//
// Externally generated triggers (`race-start` from GREEN flag,
// `manual-retire` from Race Control, `internal-error` from exception handler)
// are not evaluated here: they live in the orchestrator because they depend on
// external sources outside car state observation.
//
// API:
//
//   initialConditionsTracker()
//     returns the per-car tracker with all sticky counters reset.
//
//   evaluate(fsmState, observation, tracker)
//     returns { trigger, reason, tracker }.
//     - `trigger: null` if no condition is satisfied.
//     - `tracker` is ALWAYS returned (even when trigger is null), because
//        the tire-overheat counter must be updated every tick.
//     - Input is never mutated.
//     Evaluation order (highest → lowest priority):
//       1. race-end       (normal termination, dominant)
//       2. engine-failure (catastrophic, random)
//       3. tire-overheat  (catastrophic, latched after 3 ticks)
//       4. unrecoverable  (in FAULT, after diagnostic timer)
//       5. pit-out        (in PIT, after stop duration timer)
//       6. tire-service
//
//   onEnterPit(tracker, nowS, durationS)
//   onEnterFault(tracker, nowS)
//     to be called by the orchestrator immediately after the FSM transition to
//     PIT/FAULT, to initialise the tracker timers.
//
//   samplePitDurationS(rng)
//     returns a pit duration in [PIT_DURATION_MIN_S, PIT_DURATION_MAX_S]
//     using the PRNG passed in (xorshift32 or Math.random).
//
// Predicates are exposed individually (`isLowFuel`, `isTireOverheatLatched`,
// ...) for targeted unit tests and to document the transition table
// conditions declaratively.

const { STATES, TRIGGERS } = require('./fsm');

const FUEL_PIT_THRESHOLD_KG = 8;
// Normalised tire wear (0 fresh → 1 fully worn) at which a car pits. Below 1 so
// cars stop *before* the compound is spent; combined with the per-compound wear
// rate and per-car variance, softer tires reach it sooner and pits stagger.
const TIRE_WEAR_PIT_THRESHOLD = 0.6;
const TIRE_OVERHEAT_THRESHOLD_C = 180;
const TIRE_OVERHEAT_TICKS_REQUIRED = 3;
const ENGINE_FAILURE_PROB_PER_TICK = 1e-4;
const FAULT_GRACE_S = 0;
const FAULT_DIAGNOSE_S = 5;
const PIT_DURATION_MIN_S = 2.0;
const PIT_DURATION_MAX_S = 3.5;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function maxTireTemp(tireTemp) {
  if (!tireTemp || typeof tireTemp !== 'object') return 0;
  const fl = isFiniteNumber(tireTemp.fl) ? tireTemp.fl : 0;
  const fr = isFiniteNumber(tireTemp.fr) ? tireTemp.fr : 0;
  const rl = isFiniteNumber(tireTemp.rl) ? tireTemp.rl : 0;
  const rr = isFiniteNumber(tireTemp.rr) ? tireTemp.rr : 0;
  return Math.max(fl, fr, rl, rr);
}

function initialConditionsTracker() {
  return {
    tireOverheatTicks: 0,
    faultEnteredAtS: null,
    pitEnteredAtS: null,
    pitDurationS: null,
  };
}

function isLowFuel(fuelKg, threshold) {
  const thr = isFiniteNumber(threshold) ? threshold : FUEL_PIT_THRESHOLD_KG;
  return isFiniteNumber(fuelKg) && fuelKg < thr;
}

function tireOverheatNextTicks(tireTemp, prevTicks, threshold) {
  const thr = isFiniteNumber(threshold) ? threshold : TIRE_OVERHEAT_THRESHOLD_C;
  const prev = isFiniteNumber(prevTicks) && prevTicks >= 0 ? prevTicks : 0;
  return maxTireTemp(tireTemp) > thr ? prev + 1 : 0;
}

function isTireOverheatLatched(ticks, required) {
  const req = isFiniteNumber(required) && required > 0 ? required : TIRE_OVERHEAT_TICKS_REQUIRED;
  return isFiniteNumber(ticks) && ticks >= req;
}

function isEngineFailure(rng, prob) {
  if (typeof rng !== 'function') return false;
  const p = isFiniteNumber(prob) ? prob : ENGINE_FAILURE_PROB_PER_TICK;
  if (p <= 0) return false;
  const r = rng();
  return isFiniteNumber(r) && r < p;
}

function isFaultGraceElapsed(nowS, graceS) {
  const grace = isFiniteNumber(graceS) && graceS > 0 ? graceS : FAULT_GRACE_S;
  if (grace <= 0) return true;
  return isFiniteNumber(nowS) && nowS >= grace;
}

function isPitTimeElapsed(pitEnteredAtS, pitDurationS, nowS) {
  if (!isFiniteNumber(pitEnteredAtS) || !isFiniteNumber(pitDurationS)) return false;
  if (!isFiniteNumber(nowS)) return false;
  return (nowS - pitEnteredAtS) >= pitDurationS;
}

function isFaultUnrecoverable(faultEnteredAtS, nowS, diagnoseS) {
  if (!isFiniteNumber(faultEnteredAtS) || !isFiniteNumber(nowS)) return false;
  const d = isFiniteNumber(diagnoseS) && diagnoseS > 0 ? diagnoseS : FAULT_DIAGNOSE_S;
  return (nowS - faultEnteredAtS) >= d;
}

function isRaceEnd(currentLap, totalLaps, checkeredActive) {
  if (!isFiniteNumber(currentLap) || !isFiniteNumber(totalLaps)) return false;
  return checkeredActive === true && currentLap >= totalLaps;
}

function isPitEntryWindow(trackPos, pitEntryPos) {
  if (!isFiniteNumber(trackPos)) return true;
  const entry = isFiniteNumber(pitEntryPos) ? pitEntryPos : 0.95;
  return trackPos >= entry;
}

function isTireServiceDue(tireWear, threshold, completed) {
  if (completed === true) return false;
  const wear = isFiniteNumber(tireWear) ? tireWear : 0;
  const thr = isFiniteNumber(threshold) && threshold > 0 ? threshold : TIRE_WEAR_PIT_THRESHOLD;
  return wear >= thr;
}

function onEnterPit(tracker, nowS, durationS) {
  const t = tracker || initialConditionsTracker();
  return {
    ...t,
    pitEnteredAtS: isFiniteNumber(nowS) ? nowS : null,
    pitDurationS: isFiniteNumber(durationS) && durationS >= 0 ? durationS : null,
  };
}

function onEnterFault(tracker, nowS) {
  const t = tracker || initialConditionsTracker();
  return {
    ...t,
    faultEnteredAtS: isFiniteNumber(nowS) ? nowS : null,
    tireOverheatTicks: 0,
  };
}

function samplePitDurationS(rng, minS, maxS) {
  const lo = isFiniteNumber(minS) && minS >= 0 ? minS : PIT_DURATION_MIN_S;
  const hi = isFiniteNumber(maxS) && maxS >= lo ? maxS : PIT_DURATION_MAX_S;
  if (typeof rng !== 'function') return (lo + hi) / 2;
  const r = rng();
  const u = isFiniteNumber(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return lo + (hi - lo) * u;
}

function readObservation(obs) {
  const o = obs || {};
  return {
    fuel: o.fuel,
    tireTemp: o.tireTemp,
    lap: o.lap,
    trackPos: o.trackPos,
    totalLaps: o.totalLaps,
    checkeredActive: o.checkeredActive === true,
    nowS: o.nowS,
    rng: o.rng,
    pitEntryPos: isFiniteNumber(o.pitEntryPos) ? o.pitEntryPos : 0.95,
    pitExitReached: o.pitExitReached !== false,
    fuelPitThreshold: isFiniteNumber(o.fuelPitThreshold) ? o.fuelPitThreshold : FUEL_PIT_THRESHOLD_KG,
    tireWear: isFiniteNumber(o.tireWear) ? o.tireWear : 0,
    tireWearPitThreshold: isFiniteNumber(o.tireWearPitThreshold) ? o.tireWearPitThreshold : TIRE_WEAR_PIT_THRESHOLD,
    tireServiceCompleted: o.tireServiceCompleted === true,
    tireOverheatThreshold: isFiniteNumber(o.tireOverheatThreshold) ? o.tireOverheatThreshold : TIRE_OVERHEAT_THRESHOLD_C,
    tireOverheatTicksRequired: isFiniteNumber(o.tireOverheatTicksRequired) ? o.tireOverheatTicksRequired : TIRE_OVERHEAT_TICKS_REQUIRED,
    engineFailureProb: isFiniteNumber(o.engineFailureProb) ? o.engineFailureProb : ENGINE_FAILURE_PROB_PER_TICK,
    faultGraceS: isFiniteNumber(o.faultGraceS) ? o.faultGraceS : FAULT_GRACE_S,
    faultDiagnoseS: isFiniteNumber(o.faultDiagnoseS) ? o.faultDiagnoseS : FAULT_DIAGNOSE_S,
  };
}

function noTrigger(tracker) {
  return { trigger: null, reason: null, tracker };
}

function evaluate(fsmState, observation, tracker) {
  const baseTracker = tracker && typeof tracker === 'object' ? tracker : initialConditionsTracker();
  const safe = readObservation(observation);
  const faultsAllowed = isFaultGraceElapsed(safe.nowS, safe.faultGraceS);

  // Update the tire-overheat counter only when faults are enabled:
  // the grace window also protects against an immediate latch as soon as it expires.
  const nextTireOverheatTicks = faultsAllowed
    ? tireOverheatNextTicks(
      safe.tireTemp,
      baseTracker.tireOverheatTicks,
      safe.tireOverheatThreshold,
    )
    : 0;
  const nextTracker = { ...baseTracker, tireOverheatTicks: nextTireOverheatTicks };

  if (fsmState === STATES.RUNNING) {
    if (isRaceEnd(safe.lap, safe.totalLaps, safe.checkeredActive)) {
      return { trigger: TRIGGERS.RACE_END, reason: TRIGGERS.RACE_END, tracker: nextTracker };
    }
    if (faultsAllowed && isEngineFailure(safe.rng, safe.engineFailureProb)) {
      return { trigger: TRIGGERS.ENGINE_FAILURE, reason: TRIGGERS.ENGINE_FAILURE, tracker: nextTracker };
    }
    if (faultsAllowed && isTireOverheatLatched(nextTracker.tireOverheatTicks, safe.tireOverheatTicksRequired)) {
      const maxC = maxTireTemp(safe.tireTemp).toFixed(1);
      return {
        trigger: TRIGGERS.TIRE_OVERHEAT,
        reason: `tire-overheat:max=${maxC}C`,
        tracker: { ...nextTracker, tireOverheatTicks: 0 },
      };
    }
    const canEnterPit = isPitEntryWindow(safe.trackPos, safe.pitEntryPos);
    if (canEnterPit && isTireServiceDue(safe.tireWear, safe.tireWearPitThreshold, safe.tireServiceCompleted)) {
      return {
        trigger: TRIGGERS.TIRE_SERVICE,
        reason: `tire-service:wear-${Math.round(safe.tireWear * 100)}%`,
        tracker: nextTracker,
      };
    }
    return noTrigger(nextTracker);
  }

  if (fsmState === STATES.PIT) {
    if (isRaceEnd(safe.lap, safe.totalLaps, safe.checkeredActive)) {
      return { trigger: TRIGGERS.RACE_END, reason: TRIGGERS.RACE_END, tracker: nextTracker };
    }
    if (faultsAllowed && isEngineFailure(safe.rng, safe.engineFailureProb)) {
      return { trigger: TRIGGERS.ENGINE_FAILURE, reason: TRIGGERS.ENGINE_FAILURE, tracker: nextTracker };
    }
    if (safe.pitExitReached && isPitTimeElapsed(nextTracker.pitEnteredAtS, nextTracker.pitDurationS, safe.nowS)) {
      return {
        trigger: TRIGGERS.PIT_OUT,
        reason: TRIGGERS.PIT_OUT,
        tracker: { ...nextTracker, pitEnteredAtS: null, pitDurationS: null },
      };
    }
    return noTrigger(nextTracker);
  }

  if (fsmState === STATES.FAULT) {
    if (isFaultUnrecoverable(nextTracker.faultEnteredAtS, safe.nowS, safe.faultDiagnoseS)) {
      return {
        trigger: TRIGGERS.UNRECOVERABLE,
        reason: TRIGGERS.UNRECOVERABLE,
        tracker: { ...nextTracker, faultEnteredAtS: null },
      };
    }
    return noTrigger(nextTracker);
  }

  // INIT, RETIRED, FINISHED: no observed-state condition here
  // (race-start, manual-retire, internal-error are external triggers).
  return noTrigger(nextTracker);
}

module.exports = {
  FUEL_PIT_THRESHOLD_KG,
  TIRE_WEAR_PIT_THRESHOLD,
  TIRE_OVERHEAT_THRESHOLD_C,
  TIRE_OVERHEAT_TICKS_REQUIRED,
  ENGINE_FAILURE_PROB_PER_TICK,
  FAULT_GRACE_S,
  FAULT_DIAGNOSE_S,
  PIT_DURATION_MIN_S,
  PIT_DURATION_MAX_S,
  initialConditionsTracker,
  maxTireTemp,
  isLowFuel,
  tireOverheatNextTicks,
  isTireOverheatLatched,
  isEngineFailure,
  isFaultGraceElapsed,
  isPitTimeElapsed,
  isFaultUnrecoverable,
  isRaceEnd,
  isPitEntryWindow,
  isTireServiceDue,
  onEnterPit,
  onEnterFault,
  samplePitDurationS,
  evaluate,
};
