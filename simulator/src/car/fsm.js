// Finite state machine (FSM) for a single car.
//
// Pure module, no I/O and no mutations. Receives a current state and
// a trigger, returns a new state record. Consistent with the rest of
// `simulator/src/car/` (see physics.js, tire-fuel.js).
//
// States (see docs/simulator-architecture.md §7 and schemas/state.schema.json):
//
//   INIT       before race start, car stationary on the grid.
//   RUNNING    in race, following the Monza profile.
//   PIT        in pit-lane (entry, stop, exit).
//   FAULT      recoverable failure or under diagnosis (decelerating to 0).
//   RETIRED    permanent retirement (absorbing).
//   FINISHED   race completed normally (absorbing).
//
// Triggers (transition causes, mapped 1:1 to the `reason` field of the payload):
//
//   race-start, tire-service, pit-out, tire-overheat,
//   engine-failure, unrecoverable, race-end, manual-retire, internal-error
//
// The transition table is defined in TRANSITIONS. The conditions that decide
// which trigger to send each tick (e.g. tireTemp > 180 for 3 consecutive ticks
// → 'tire-overheat') live in conditions.js. This module models only the
// machine structure: allowed states, allowed transitions, absorbing states.
//
// API:
//
//   initialFsm()
//     returns { state: 'INIT', previousState: null, reason: null }.
//
//   transition(currentFsm, trigger, customReason?)
//     returns { state, previousState, reason, changed }.
//     - `changed: false` if the trigger is not applicable from the current
//        state, if the state is absorbing (RETIRED/FINISHED), or if the
//        transition would lead to the same state.
//     - `reason` defaults to the trigger value; pass `customReason`
//        to enrich it (e.g. 'tire-overheat:fl=185').
//     - Input is never mutated.
//
//   canTransition(state, trigger)
//     true if and only if an applicable transition exists.
//
//   isTerminal(state), isValidState(state)
//     utility predicates.
//
// Design note: the 'manual-retire' trigger is allowed from any non-absorbing
// state (Race Control lifecycle / external command → DNS or retirement at any
// phase). 'internal-error' forces FAULT from any non-absorbing state
// (see §12.2 of the architecture: exception in Car.tick() → FAULT).
// On FAULT itself it is a no-op.

const STATES = Object.freeze({
  INIT: 'INIT',
  RUNNING: 'RUNNING',
  PIT: 'PIT',
  FAULT: 'FAULT',
  RETIRED: 'RETIRED',
  FINISHED: 'FINISHED',
});

const STATE_VALUES = Object.freeze([
  STATES.INIT,
  STATES.RUNNING,
  STATES.PIT,
  STATES.FAULT,
  STATES.RETIRED,
  STATES.FINISHED,
]);

const TERMINAL_STATES = Object.freeze([STATES.RETIRED, STATES.FINISHED]);

const TRIGGERS = Object.freeze({
  RACE_START: 'race-start',
  TIRE_SERVICE: 'tire-service',
  PIT_OUT: 'pit-out',
  TIRE_OVERHEAT: 'tire-overheat',
  ENGINE_FAILURE: 'engine-failure',
  UNRECOVERABLE: 'unrecoverable',
  RACE_END: 'race-end',
  MANUAL_RETIRE: 'manual-retire',
  INTERNAL_ERROR: 'internal-error',
});

const WILDCARD = '*';

const TRANSITIONS = Object.freeze([
  { from: STATES.INIT,    to: STATES.RUNNING,  trigger: TRIGGERS.RACE_START },
  { from: STATES.RUNNING, to: STATES.PIT,      trigger: TRIGGERS.TIRE_SERVICE },
  { from: STATES.PIT,     to: STATES.RUNNING,  trigger: TRIGGERS.PIT_OUT },
  { from: STATES.RUNNING, to: STATES.FAULT,    trigger: TRIGGERS.TIRE_OVERHEAT },
  { from: STATES.RUNNING, to: STATES.FAULT,    trigger: TRIGGERS.ENGINE_FAILURE },
  { from: STATES.PIT,     to: STATES.FAULT,    trigger: TRIGGERS.ENGINE_FAILURE },
  { from: STATES.FAULT,   to: STATES.RETIRED,  trigger: TRIGGERS.UNRECOVERABLE },
  { from: STATES.RUNNING, to: STATES.FINISHED, trigger: TRIGGERS.RACE_END },
  { from: STATES.PIT,     to: STATES.FINISHED, trigger: TRIGGERS.RACE_END },
  { from: WILDCARD,       to: STATES.RETIRED,  trigger: TRIGGERS.MANUAL_RETIRE },
  { from: WILDCARD,       to: STATES.FAULT,    trigger: TRIGGERS.INTERNAL_ERROR },
]);

function isValidState(state) {
  return typeof state === 'string' && STATE_VALUES.includes(state);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function findTransition(fromState, trigger) {
  return TRANSITIONS.find((t) => t.trigger === trigger && (t.from === fromState || t.from === WILDCARD));
}

function canTransition(state, trigger) {
  if (!isValidState(state)) return false;
  if (isTerminal(state)) return false;
  const t = findTransition(state, trigger);
  if (!t) return false;
  return t.to !== state;
}

function initialFsm() {
  return { state: STATES.INIT, previousState: null, reason: null };
}

function transition(currentFsm, trigger, customReason) {
  const cur = currentFsm && isValidState(currentFsm.state) ? currentFsm : initialFsm();
  const fromState = cur.state;
  const noChange = {
    state: fromState,
    previousState: cur.previousState === undefined ? null : cur.previousState,
    reason: cur.reason === undefined ? null : cur.reason,
    changed: false,
  };

  if (isTerminal(fromState)) return noChange;

  const t = findTransition(fromState, trigger);
  if (!t) return noChange;
  if (t.to === fromState) return noChange;

  const reason = typeof customReason === 'string' && customReason.length > 0 ? customReason : trigger;
  return {
    state: t.to,
    previousState: fromState,
    reason,
    changed: true,
  };
}

module.exports = {
  STATES,
  STATE_VALUES,
  TERMINAL_STATES,
  TRIGGERS,
  TRANSITIONS,
  initialFsm,
  transition,
  canTransition,
  isTerminal,
  isValidState,
};
