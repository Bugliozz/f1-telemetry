// Trigger automatici di Race Control — condizioni che innescano le flag.
//
// Pure module. Receives the car snapshot and race state and
// ritorna un eventuale cambio di flag da applicare. L'Orchestrator
// invoca `evaluateTriggers()` a ogni tick *prima* di far avanzare le
// auto, cosi' che le flag influenzino il comportamento nello stesso tick.
//
// Trigger implementati:
//
//   1. RETIREMENT_SC
//      Un'auto si ritira (RETIRED) e il detrito/pericolo richiede Safety
//      Car. Configurable probability (default 40% per retirement).
//
//   2. MULTI_FAULT_VSC
//      Due o piu' auto in FAULT contemporaneamente → Virtual Safety Car
//      automatica per pericolo diffuso.
//
//   3. RED_FLAG_MASS_INCIDENT
//      3+ cars in RETIRED/FAULT within the same short time window
//      → Red Flag (incidente multiplo grave).
//
//   4. CHECKERED_FLAG
//      The leader completes totalLaps laps -> Checkered Flag.
//
//   5. SC/VSC_CLEARANCE
//      Dopo una durata minima sotto SC o VSC, se le condizioni si sono
//      normalized (no car in FAULT), Race Control returns
//      GREEN. Durata minima configurabile.
//
// Ogni trigger ritorna null (nessun cambio) oppure un oggetto
// { flag, sector, reason } che verra' passato a changeFlag().
//
// I trigger vengono valutati in ordine di priorita' (alta → bassa):
//   CHECKERED > RED_FLAG > SC > VSC > CLEARANCE > GREEN
//
// No trigger is evaluated if the active flag is CHECKERED (terminal)
// o RED (richiede clearance manuale per restart).

const { FLAGS, isTerminalFlag } = require('./flag-state');
const { STATES } = require('../car/fsm');

// --- Configurazione default trigger ---

const DEFAULT_TRIGGER_CONFIG = Object.freeze({
  // Probability that a retirement causes SC (0-1)
  retirementScProbability: 0,
  // Numero minimo di auto in FAULT per attivare VSC
  multiFaultVscThreshold: 1,
  // Numero di auto RETIRED+FAULT per RED FLAG
  massIncidentThreshold: 3,
  // Durata minima SC in secondi prima di poter tornare a GREEN
  scMinDurationS: 30,
  // Durata minima VSC in secondi prima di poter tornare a GREEN
  vscMinDurationS: 20,
  // Durata minima YELLOW in secondi prima di poter tornare a GREEN
  yellowMinDurationS: 10,
});

/**
 * Tracker state for automatic triggers.
 * Tiene traccia di conteggi e timing per le decisioni.
 */
function initialTriggerTracker() {
  return {
    // ID delle auto gia' processate per il trigger retirement-SC
    // (evita di riattivare SC se la stessa auto l'ha gia' causata)
    processedRetirements: [],
    // Contatore di auto in FAULT al tick precedente
    prevFaultCount: 0,
    // Timestamp of the last processed retirement event
    lastRetirementCheckS: null,
  };
}

/**
 * Counts cars in a given state.
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
 * Restituisce le auto appena ritirate (RETIRED) non ancora processate.
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
 * Valuta tutti i trigger automatici e restituisce un eventuale
 * cambio di flag.
 *
 * @param {object} flagState     - current flag state (from flag-state.js)
 * @param {Car[]}  cars          - array di tutte le auto
 * @param {object} raceState     - { leaderLap, totalLaps, nowS, rng }
 * @param {object} tracker       - tracker state
 * @param {object} triggerConfig - configurazione (default: DEFAULT_TRIGGER_CONFIG)
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

  // --- 1. CHECKERED FLAG (massima priorita') ---
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

  // Conta auto in stati di interesse
  const faultCount = countCarsInState(cars, STATES.FAULT);
  const retiredCount = countCarsInState(cars, STATES.RETIRED);
  const incidentCount = countCarsInStates(cars, [STATES.FAULT, STATES.RETIRED]);
  const newRetirements = findNewRetirements(cars, t.processedRetirements);

  // Aggiorna tracker con i nuovi ritiri processati
  let nextTracker = {
    ...t,
    processedRetirements: [...t.processedRetirements, ...newRetirements],
    prevFaultCount: faultCount,
  };

  // --- 2. RED FLAG — incidente multiplo grave ---
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

  // --- 3. SAFETY CAR - triggered by retirement with debris ---
  if (flagState.flag === FLAGS.GREEN || flagState.flag === FLAGS.YELLOW) {
    if (newRetirements.length > 0) {
      // Each new retirement has a probability of causing SC
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

  // --- 4. VSC — car stopped or faulty on track ---
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

  // --- 5. YELLOW FLAG - local caution fallback when VSC threshold is configured above 1
  if (flagState.flag === FLAGS.GREEN) {
    if (faultCount === 1) {
      // Trova il settore dell'auto in FAULT per yellow locale
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

  // --- 6. CLEARANCE — ritorno a GREEN dopo SC/VSC/YELLOW ---
  if (flagState.flag === FLAGS.SC || flagState.flag === FLAGS.VSC || flagState.flag === FLAGS.YELLOW) {
    const activatedAtS = flagState.activatedAtS || 0;
    const elapsed = nowS - activatedAtS;

    let minDuration;
    if (flagState.flag === FLAGS.SC) minDuration = cfg.scMinDurationS;
    else if (flagState.flag === FLAGS.VSC) minDuration = cfg.vscMinDurationS;
    else minDuration = cfg.yellowMinDurationS;

    // Clearance possibile solo se:
    // 1. E' passata la durata minima
    // 2. Nessuna auto in FAULT (pericolo rimosso)
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

  // Nessun trigger
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
