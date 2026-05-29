// Automatic Race Control triggers — conditions that fire flags.
//
// Pure module. Receives the car snapshot and race state and
// returns an optional flag change to apply. The Orchestrator
// calls `evaluateTriggers()` every tick *before* advancing the
// cars, so that flags influence behaviour in the same tick.
//
// Implemented triggers:
//
//   1. RETIREMENT_SC
//      A car retires (RETIRED) and the debris/hazard requires a Safety
//      Car. Configurable probability (default 40% per retirement).
//
//   2. MULTI_FAULT_VSC
//      Two or more cars simultaneously in FAULT → automatic Virtual Safety
//      Car for widespread hazard.
//
//   3. RED_FLAG_MASS_INCIDENT
//      3+ cars in RETIRED/FAULT within the same short time window
//      → Red Flag (serious multiple incident).
//
//   4. CHECKERED_FLAG
//      The leader completes totalLaps laps → Chequered flag.
//
//   5. SC/VSC_CLEARANCE
//      After a minimum duration under SC or VSC, if conditions have
//      normalised (no car in FAULT), Race Control returns to
//      GREEN. Minimum duration is configurable.
//
// Each trigger returns null (no change) or an object
// { flag, sector, reason } that will be passed to changeFlag().
//
// Triggers are evaluated in priority order (high → low):
//   CHECKERED > RED_FLAG > SC > VSC > CLEARANCE > GREEN
//
// No trigger is evaluated if the active flag is CHECKERED (terminal)
// or RED (requires manual clearance for restart).

const { FLAGS, isTerminalFlag } = require('./flag-state');
const { STATES } = require('../car/fsm');

// --- Configurazione default trigger ---

const DEFAULT_TRIGGER_CONFIG = Object.freeze({
  // Probability that a retirement triggers SC (0-1)
  retirementScProbability: 0,
  // Minimum number of cars in FAULT to activate VSC
  multiFaultVscThreshold: 1,
  // Number of RETIRED+FAULT cars for RED FLAG
  massIncidentThreshold: 3,
  // Minimum SC duration in seconds before returning to GREEN
  scMinDurationS: 30,
  // Minimum VSC duration in seconds before returning to GREEN
  vscMinDurationS: 20,
  // Minimum YELLOW duration in seconds before returning to GREEN
  yellowMinDurationS: 10,
});

/**
 * Tracker state for automatic triggers.
 * Keeps track of counts and timing for decisions.
 */
function initialTriggerTracker() {
  return {
    // IDs of cars already processed for the retirement-SC trigger
    // (avoids re-triggering SC if the same car already caused it)
    processedRetirements: [],
    // Count of cars in FAULT at the previous tick
    prevFaultCount: 0,
    // Timestamp of the last processed retirement event
    lastRetirementCheckS: null,
  };
}

/**
 * Conta le auto in un dato stato.
 */
function countCarsInState(cars, state) {
  let count = 0;
  for (const car of cars) {
    if (car.fsm && car.fsm.state === state) count++;
  }
  return count;
}

/**
 * Conta le auto in stati multipli.
 */
function countCarsInStates(cars, states) {
  let count = 0;
  for (const car of cars) {
    if (car.fsm && states.includes(car.fsm.state)) count++;
  }
  return count;
}

/**
 * Returns newly retired (RETIRED) cars not yet processed.
 */
function findNewRetirements(cars, processedRetirements) {
  const newRetirements = [];
  for (const car of cars) {
    if (car.fsm && car.fsm.state === STATES.RETIRED) {
      if (!processedRetirements.includes(car.carId)) {
        newRetirements.push(car.carId);
      }
    }
  }
  return newRetirements;
}

/**
 * Evaluates all automatic triggers and returns an optional flag change.
 *
 * @param {object} flagState     - current flag state (from flag-state.js)
 * @param {Car[]}  cars          - array of all cars
 * @param {object} raceState     - { leaderLap, totalLaps, nowS, rng }
 * @param {object} tracker       - tracker state
 * @param {object} triggerConfig - configuration (default: DEFAULT_TRIGGER_CONFIG)
 *
 * @returns {{ action: { flag, sector, reason }|null, tracker: object }}
 */
function evaluateTriggers(flagState, cars, raceState, tracker, triggerConfig) {
  const cfg = { ...DEFAULT_TRIGGER_CONFIG, ...triggerConfig };
  const t = tracker || initialTriggerTracker();
  const nowS = raceState.nowS || 0;
  const rng = typeof raceState.rng === 'function' ? raceState.rng : Math.random;

  // Terminal flag: no evaluation
  if (isTerminalFlag(flagState.flag)) {
    return { action: null, tracker: t };
  }

  // --- 1. CHECKERED FLAG (highest priority) ---
  if (flagState.flag !== FLAGS.CHECKERED) {
    const leaderLap = raceState.leaderLap || 0;
    const totalLaps = raceState.totalLaps || 5;
    if (leaderLap >= totalLaps) {
      return {
        action: { flag: FLAGS.CHECKERED, sector: null, reason: 'leader-finished' },
        tracker: t,
      };
    }
  }

  // Count cars in states of interest
  const faultCount = countCarsInState(cars, STATES.FAULT);
  const retiredCount = countCarsInState(cars, STATES.RETIRED);
  const incidentCount = countCarsInStates(cars, [STATES.FAULT, STATES.RETIRED]);
  const newRetirements = findNewRetirements(cars, t.processedRetirements);

  // Update tracker with newly processed retirements
  let nextTracker = {
    ...t,
    processedRetirements: [...t.processedRetirements, ...newRetirements],
    prevFaultCount: faultCount,
  };

  // --- 2. RED FLAG — serious multiple incident ---
  if (flagState.flag !== FLAGS.RED && flagState.flag !== FLAGS.CHECKERED) {
    if (incidentCount >= cfg.massIncidentThreshold) {
      return {
        action: {
          flag: FLAGS.RED,
          sector: null,
          reason: `mass-incident:${incidentCount}-cars-involved`,
        },
        tracker: nextTracker,
      };
    }
  }

  // --- 3. SAFETY CAR — triggered by a retirement with debris ---
  if (flagState.flag === FLAGS.GREEN || flagState.flag === FLAGS.YELLOW) {
    if (newRetirements.length > 0) {
      // Each new retirement has a probability of triggering the SC
      for (const carId of newRetirements) {
        if (rng() < cfg.retirementScProbability) {
          return {
            action: {
              flag: FLAGS.SC,
              sector: null,
              reason: `debris-retirement:car-${carId}`,
            },
            tracker: nextTracker,
          };
        }
      }
    }
  }

  // --- 4. VSC — car stopped or in fault on track ---
  if (flagState.flag === FLAGS.GREEN || flagState.flag === FLAGS.YELLOW) {
    if (faultCount >= cfg.multiFaultVscThreshold) {
      return {
        action: {
          flag: FLAGS.VSC,
          sector: null,
          reason: faultCount === 1
            ? 'fault-on-track'
            : `multi-fault:${faultCount}-cars-in-fault`,
        },
        tracker: nextTracker,
      };
    }
  }

  // --- 5. YELLOW FLAG — local caution fallback when the VSC threshold is set above 1
  if (flagState.flag === FLAGS.GREEN) {
    if (faultCount === 1) {
      // Find the sector of the FAULT car for a local yellow
      let faultSector = null;
      for (const car of cars) {
        if (car.fsm && car.fsm.state === STATES.FAULT) {
          faultSector = car.currentSector || null;
          break;
        }
      }
      return {
        action: {
          flag: FLAGS.YELLOW,
          sector: faultSector,
          reason: `car-fault-on-track`,
        },
        tracker: nextTracker,
      };
    }
  }

  // --- 6. CLEARANCE — return to GREEN after SC/VSC/YELLOW ---
  if (flagState.flag === FLAGS.SC || flagState.flag === FLAGS.VSC || flagState.flag === FLAGS.YELLOW) {
    const activatedAtS = flagState.activatedAtS || 0;
    const elapsed = nowS - activatedAtS;

    let minDuration;
    if (flagState.flag === FLAGS.SC) minDuration = cfg.scMinDurationS;
    else if (flagState.flag === FLAGS.VSC) minDuration = cfg.vscMinDurationS;
    else minDuration = cfg.yellowMinDurationS;

    // Clearance possible only if:
    // 1. Minimum duration has elapsed
    // 2. No car in FAULT (hazard removed)
    if (elapsed >= minDuration && faultCount === 0) {
      return {
        action: {
          flag: FLAGS.GREEN,
          sector: null,
          reason: `clearance-after-${flagState.flag.toLowerCase()}`,
        },
        tracker: nextTracker,
      };
    }
  }

  // No trigger
  return { action: null, tracker: nextTracker };
}

module.exports = {
  DEFAULT_TRIGGER_CONFIG,
  initialTriggerTracker,
  countCarsInState,
  countCarsInStates,
  findNewRetirements,
  evaluateTriggers,
};
