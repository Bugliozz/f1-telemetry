// Car FSM state transition conditions.
//
// Modulo puro, senza I/O e senza mutazione degli input. Coerente con
// `fsm.js`, `physics.js`, `tire-fuel.js`: the orchestrator passes the state
// corrente piu' un'osservazione del tick e riceve un eventuale trigger da
// applicare alla FSM.
//
// Source: docs/simulator-architecture.md §7.1 (transition table).
//
//   | Da          | A        | Condizione                                                    | reason            |
//   |-------------|----------|---------------------------------------------------------------|-------------------|
//   | RUNNING     | PIT      | fuel < FUEL_PIT_THRESHOLD_KG (default 8 kg)                   | low-fuel          |
//   | PIT         | RUNNING  | timer pit elapsed (2.0-3.5 s sorteggiati)                     | pit-out           |
//   | RUNNING     | FAULT    | max(tireTemp) > 180 C per 3 tick consecutivi                  | tire-overheat     |
//   | RUNNING/PIT | FAULT    | random engine failure (probabilita' < 1e-4 per tick)          | engine-failure    |
//   | FAULT       | RETIRED  | timer diagnostico >= 5 s (in F3 ogni fault e' non riparabile) | unrecoverable     |
//   | RUNNING/PIT | FINISHED | lap >= TOTAL_LAPS && flag CHECKERED ricevuta                  | race-end          |
//
// I trigger generati esternamente alla FSM (`race-start` da flag GREEN,
// `manual-retire` da Race Control, `internal-error` da exception handler)
// non sono valutati qui: vivono nell'orchestrator perche' dipendono da
// external sources outside car state observation.
//
// API:
//
//   initialConditionsTracker()
//     ritorna il tracker per-auto con i contatori sticky azzerati.
//
//   evaluate(fsmState, observation, tracker)
//     ritorna { trigger, reason, tracker }.
//     - `trigger: null` se nessuna condizione e' soddisfatta.
//     - `tracker` e' SEMPRE ritornato (anche quando trigger e' null), perche'
//        il contatore tire-overheat va aggiornato a ogni tick.
//     - L'input non viene mai mutato.
//     L'ordine di valutazione (priorita' alta -> bassa) e':
//       1. race-end       (terminazione regolare, dominante)
//       2. engine-failure (catastrofico, casuale)
//       3. tire-overheat  (catastrofico, latched a 3 tick)
//       4. unrecoverable  (in FAULT, dopo timer diagnose)
//       5. pit-out        (in PIT, dopo timer durata)
//       6. low-fuel
//
//   onEnterPit(tracker, nowS, durationS)
//   onEnterFault(tracker, nowS)
//     to be called by the orchestrator immediately after the FSM transition to
//     PIT/FAULT, per inizializzare i timer del tracker.
//
//   samplePitDurationS(rng)
//     ritorna una durata pit in [PIT_DURATION_MIN_S, PIT_DURATION_MAX_S]
//     usando il PRNG passato (xorshift32 o Math.random).
//
// Predicates are exposed individually (`isLowFuel`, `isTireOverheatLatched`,
// ...) per consentire test unitari mirati e per documentare in modo
// dichiarativo le condizioni della tabella sopra.

const { STATES, TRIGGERS } = require('./fsm');

const FUEL_PIT_THRESHOLD_KG = 8;
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

  // Aggiorna il contatore tire-overheat solo quando i fault sono abilitati:
  // la grace window protegge anche dal latch immediato appena scade.
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
    if (canEnterPit && isLowFuel(safe.fuel, safe.fuelPitThreshold)) {
      const fuelStr = isFiniteNumber(safe.fuel) ? safe.fuel.toFixed(2) : '0.00';
      return {
        trigger: TRIGGERS.LOW_FUEL,
        reason: `low-fuel:${fuelStr}kg`,
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
  // (race-start, manual-retire, internal-error sono trigger esterni).
  return noTrigger(nextTracker);
}

module.exports = {
  FUEL_PIT_THRESHOLD_KG,
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
  onEnterPit,
  onEnterFault,
  samplePitDurationS,
  evaluate,
};
