// Macchina a stati finiti (FSM) di un'auto.
//
// Modulo puro, senza I/O e senza mutazioni. Riceve uno stato corrente e
// un trigger, ritorna un nuovo record di stato. Coerente con il resto di
// `simulator/src/car/` (cfr. physics.js, tire-fuel.js).
//
// Stati (vedi docs/simulator-architecture.md §7 e schemas/state.schema.json):
//
//   INIT       prima del via, auto ferma in griglia.
//   RUNNING    in gara, segue il profilo di Monza.
//   PIT        in pit-lane (entrata, sosta, uscita).
//   FAULT      avaria recuperabile o in diagnosi (decelera a 0).
//   RETIRED    ritiro definitivo (assorbente).
//   FINISHED   gara terminata regolarmente (assorbente).
//
// Trigger (cause di transizione, mappate 1:1 al `reason` del payload state):
//
//   race-start, low-fuel, pit-out, tire-overheat,
//   engine-failure, unrecoverable, race-end, manual-retire, internal-error
//
// La matrice e' definita in TRANSITIONS. La fase successiva del piano
// (riga 54) cabla le CONDIZIONI che decidono quale trigger inviare a ogni
// tick (es. tireTemp > 180 per 3 tick → 'tire-overheat'). Qui si modella
// solo la struttura della macchina: stati ammessi, transizioni ammesse,
// stati assorbenti.
//
// API:
//
//   initialFsm()
//     ritorna { state: 'INIT', previousState: null, reason: null }.
//
//   transition(currentFsm, trigger, customReason?)
//     ritorna { state, previousState, reason, changed }.
//     - `changed: false` se il trigger non e' applicabile dallo stato
//        corrente, se lo stato e' assorbente (RETIRED/FINISHED), o se la
//        transizione porterebbe allo stesso stato.
//     - `reason` di default coincide col trigger; passare `customReason`
//        per arricchire (es. 'tire-overheat:fl=185').
//     - L'input non viene mai mutato.
//
//   canTransition(state, trigger)
//     true sse esiste una transizione applicabile.
//
//   isTerminal(state), isValidState(state)
//     predicati di servizio.
//
// Nota di design: il trigger 'manual-retire' e' ammesso da qualunque stato
// non assorbente (lifecycle Race Control / comando esterno → DNS o ritiro
// in qualunque fase). 'internal-error' forza FAULT da qualunque stato non
// assorbente (vedi §12.2 dell'architettura: eccezione in Car.tick() →
// FAULT, gara prosegue). Su FAULT stesso e' un no-op.

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
  LOW_FUEL: 'low-fuel',
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
  { from: STATES.RUNNING, to: STATES.PIT,      trigger: TRIGGERS.LOW_FUEL },
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
