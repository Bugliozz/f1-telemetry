const assert = require('node:assert/strict');
const {
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
} = require('../src/car/fsm');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('fsm.initialFsm');

test('stato iniziale e INIT, previousState null, reason null', () => {
  const f = initialFsm();
  assert.equal(f.state, 'INIT');
  assert.equal(f.previousState, null);
  assert.equal(f.reason, null);
});

test('initialFsm ritorna istanze indipendenti', () => {
  const a = initialFsm();
  const b = initialFsm();
  assert.notStrictEqual(a, b);
});

console.log('\nfsm.isValidState / isTerminal');

test('STATE_VALUES contiene tutti i 6 stati', () => {
  assert.deepEqual([...STATE_VALUES].sort(), ['FAULT', 'FINISHED', 'INIT', 'PIT', 'RETIRED', 'RUNNING']);
});

test('isValidState true per ogni stato dichiarato', () => {
  for (const s of STATE_VALUES) {
    assert.equal(isValidState(s), true, `${s} dovrebbe essere valido`);
  }
});

test('isValidState false per input non validi', () => {
  assert.equal(isValidState('UNKNOWN'), false);
  assert.equal(isValidState(''), false);
  assert.equal(isValidState(null), false);
  assert.equal(isValidState(undefined), false);
  assert.equal(isValidState(42), false);
});

test('isTerminal true solo per RETIRED e FINISHED', () => {
  assert.equal(isTerminal('RETIRED'), true);
  assert.equal(isTerminal('FINISHED'), true);
  assert.equal(isTerminal('INIT'), false);
  assert.equal(isTerminal('RUNNING'), false);
  assert.equal(isTerminal('PIT'), false);
  assert.equal(isTerminal('FAULT'), false);
});

test('TERMINAL_STATES contiene esattamente RETIRED e FINISHED', () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ['FINISHED', 'RETIRED']);
});

console.log('\nfsm.transition - matrice principale');

test('INIT -> RUNNING via race-start', () => {
  const out = transition(initialFsm(), 'race-start');
  assert.equal(out.state, 'RUNNING');
  assert.equal(out.previousState, 'INIT');
  assert.equal(out.reason, 'race-start');
  assert.equal(out.changed, true);
});

test('RUNNING -> PIT via low-fuel', () => {
  const out = transition({ state: 'RUNNING', previousState: 'INIT', reason: 'race-start' }, 'low-fuel');
  assert.equal(out.state, 'PIT');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.reason, 'low-fuel');
  assert.equal(out.changed, true);
});

test('RUNNING -> PIT via scheduled-pit', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'scheduled-pit');
  assert.equal(out.state, 'PIT');
  assert.equal(out.reason, 'scheduled-pit');
  assert.equal(out.changed, true);
});

test('PIT -> RUNNING via pit-out', () => {
  const out = transition({ state: 'PIT', previousState: 'RUNNING', reason: 'low-fuel' }, 'pit-out');
  assert.equal(out.state, 'RUNNING');
  assert.equal(out.previousState, 'PIT');
  assert.equal(out.reason, 'pit-out');
  assert.equal(out.changed, true);
});

test('RUNNING -> FAULT via tire-overheat', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'tire-overheat');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.reason, 'tire-overheat');
  assert.equal(out.changed, true);
});

test('RUNNING -> FAULT via engine-failure', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'engine-failure');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.changed, true);
});

test('PIT -> FAULT via engine-failure', () => {
  const out = transition({ state: 'PIT', previousState: 'RUNNING', reason: 'low-fuel' }, 'engine-failure');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'PIT');
  assert.equal(out.changed, true);
});

test('FAULT -> RETIRED via unrecoverable', () => {
  const out = transition({ state: 'FAULT', previousState: 'RUNNING', reason: 'tire-overheat' }, 'unrecoverable');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'FAULT');
  assert.equal(out.reason, 'unrecoverable');
  assert.equal(out.changed, true);
});

test('RUNNING -> FINISHED via race-end', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'race-end');
  assert.equal(out.state, 'FINISHED');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.changed, true);
});

test('PIT -> FINISHED via race-end (pit-stop nel giro finale)', () => {
  const out = transition({ state: 'PIT', previousState: 'RUNNING', reason: 'scheduled-pit' }, 'race-end');
  assert.equal(out.state, 'FINISHED');
  assert.equal(out.previousState, 'PIT');
  assert.equal(out.changed, true);
});

console.log('\nfsm.transition - wildcard (manual-retire / internal-error)');

test('manual-retire da INIT (DNS) -> RETIRED', () => {
  const out = transition(initialFsm(), 'manual-retire');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'INIT');
  assert.equal(out.changed, true);
});

test('manual-retire da RUNNING -> RETIRED', () => {
  const out = transition({ state: 'RUNNING', previousState: 'INIT', reason: 'race-start' }, 'manual-retire');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.changed, true);
});

test('manual-retire da PIT -> RETIRED', () => {
  const out = transition({ state: 'PIT', previousState: 'RUNNING', reason: 'low-fuel' }, 'manual-retire');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'PIT');
  assert.equal(out.changed, true);
});

test('manual-retire da FAULT -> RETIRED', () => {
  const out = transition({ state: 'FAULT', previousState: 'RUNNING', reason: 'engine-failure' }, 'manual-retire');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'FAULT');
  assert.equal(out.changed, true);
});

test('internal-error da RUNNING -> FAULT', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'internal-error');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.reason, 'internal-error');
  assert.equal(out.changed, true);
});

test('internal-error da PIT -> FAULT', () => {
  const out = transition({ state: 'PIT', previousState: 'RUNNING', reason: 'scheduled-pit' }, 'internal-error');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'PIT');
  assert.equal(out.changed, true);
});

test('internal-error da INIT -> FAULT', () => {
  const out = transition(initialFsm(), 'internal-error');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'INIT');
  assert.equal(out.changed, true);
});

test('internal-error da FAULT: no-op (gia FAULT)', () => {
  const fsm = { state: 'FAULT', previousState: 'RUNNING', reason: 'tire-overheat' };
  const out = transition(fsm, 'internal-error');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.previousState, 'RUNNING');
  assert.equal(out.reason, 'tire-overheat');
  assert.equal(out.changed, false);
});

console.log('\nfsm.transition - stati assorbenti');

test('RETIRED non transita: manual-retire no-op', () => {
  const fsm = { state: 'RETIRED', previousState: 'FAULT', reason: 'unrecoverable' };
  const out = transition(fsm, 'manual-retire');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.previousState, 'FAULT');
  assert.equal(out.reason, 'unrecoverable');
  assert.equal(out.changed, false);
});

test('RETIRED non transita: internal-error no-op', () => {
  const fsm = { state: 'RETIRED', previousState: 'FAULT', reason: 'unrecoverable' };
  const out = transition(fsm, 'internal-error');
  assert.equal(out.state, 'RETIRED');
  assert.equal(out.changed, false);
});

test('FINISHED non transita: race-end no-op', () => {
  const fsm = { state: 'FINISHED', previousState: 'RUNNING', reason: 'race-end' };
  const out = transition(fsm, 'race-end');
  assert.equal(out.state, 'FINISHED');
  assert.equal(out.changed, false);
});

test('FINISHED non transita: nessun trigger lo smuove', () => {
  const fsm = { state: 'FINISHED', previousState: 'RUNNING', reason: 'race-end' };
  for (const trig of Object.values(TRIGGERS)) {
    const out = transition(fsm, trig);
    assert.equal(out.state, 'FINISHED', `trigger=${trig}`);
    assert.equal(out.changed, false, `trigger=${trig} non doveva cambiare`);
  }
});

console.log('\nfsm.transition - transizioni non ammesse');

test('INIT -> PIT non ammesso (low-fuel)', () => {
  const out = transition(initialFsm(), 'low-fuel');
  assert.equal(out.state, 'INIT');
  assert.equal(out.changed, false);
});

test('INIT -> FINISHED non ammesso (race-end)', () => {
  const out = transition(initialFsm(), 'race-end');
  assert.equal(out.state, 'INIT');
  assert.equal(out.changed, false);
});

test('FAULT -> RUNNING non ammesso (no recupero, solo retirement)', () => {
  const fsm = { state: 'FAULT', previousState: 'RUNNING', reason: 'tire-overheat' };
  const out = transition(fsm, 'pit-out');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.changed, false);
});

test('FAULT -> FINISHED non ammesso (race-end)', () => {
  const fsm = { state: 'FAULT', previousState: 'RUNNING', reason: 'engine-failure' };
  const out = transition(fsm, 'race-end');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.changed, false);
});

test('PIT -> FAULT solo via engine-failure, non tire-overheat', () => {
  const fsm = { state: 'PIT', previousState: 'RUNNING', reason: 'low-fuel' };
  const out = transition(fsm, 'tire-overheat');
  assert.equal(out.state, 'PIT');
  assert.equal(out.changed, false);
});

test('trigger sconosciuto: no-op', () => {
  const out = transition({ state: 'RUNNING', previousState: 'INIT', reason: 'race-start' }, 'something-weird');
  assert.equal(out.state, 'RUNNING');
  assert.equal(out.changed, false);
});

test('trigger null/undefined: no-op', () => {
  const fsm = { state: 'RUNNING', previousState: null, reason: null };
  assert.equal(transition(fsm, null).changed, false);
  assert.equal(transition(fsm, undefined).changed, false);
  assert.equal(transition(fsm, '').changed, false);
});

console.log('\nfsm.transition - reason custom e robustezza');

test('customReason sostituisce il trigger come reason', () => {
  const out = transition({ state: 'RUNNING', previousState: null, reason: null }, 'tire-overheat', 'tire-overheat:fl=185');
  assert.equal(out.state, 'FAULT');
  assert.equal(out.reason, 'tire-overheat:fl=185');
});

test('customReason vuoto o non-stringa: usa il trigger', () => {
  const fsm = { state: 'INIT', previousState: null, reason: null };
  assert.equal(transition(fsm, 'race-start', '').reason, 'race-start');
  assert.equal(transition(fsm, 'race-start', null).reason, 'race-start');
  assert.equal(transition(fsm, 'race-start', 42).reason, 'race-start');
});

test('input null o malformato: trattato come stato iniziale', () => {
  assert.equal(transition(null, 'race-start').state, 'RUNNING');
  assert.equal(transition(undefined, 'race-start').state, 'RUNNING');
  assert.equal(transition({ state: 'NOT_A_STATE' }, 'race-start').state, 'RUNNING');
  assert.equal(transition({}, 'race-start').state, 'RUNNING');
});

test('immutabilita: input fsm non mutato', () => {
  const fsm = { state: 'RUNNING', previousState: 'INIT', reason: 'race-start' };
  const snapshot = { ...fsm };
  transition(fsm, 'low-fuel');
  assert.deepEqual(fsm, snapshot);
});

test('immutabilita: TRANSITIONS non mutabile', () => {
  assert.equal(Object.isFrozen(TRANSITIONS), true);
  assert.throws(() => { TRANSITIONS.push({ from: 'X', to: 'Y', trigger: 'z' }); });
});

test('immutabilita: STATES, TRIGGERS, TERMINAL_STATES, STATE_VALUES congelati', () => {
  assert.equal(Object.isFrozen(STATES), true);
  assert.equal(Object.isFrozen(TRIGGERS), true);
  assert.equal(Object.isFrozen(TERMINAL_STATES), true);
  assert.equal(Object.isFrozen(STATE_VALUES), true);
});

console.log('\nfsm.canTransition');

test('canTransition coerente con transition().changed', () => {
  const cases = [
    { state: 'INIT',    trigger: 'race-start',     expected: true },
    { state: 'INIT',    trigger: 'low-fuel',       expected: false },
    { state: 'RUNNING', trigger: 'low-fuel',       expected: true },
    { state: 'RUNNING', trigger: 'tire-overheat',  expected: true },
    { state: 'RUNNING', trigger: 'pit-out',        expected: false },
    { state: 'PIT',     trigger: 'pit-out',        expected: true },
    { state: 'PIT',     trigger: 'tire-overheat',  expected: false },
    { state: 'FAULT',   trigger: 'unrecoverable',  expected: true },
    { state: 'FAULT',   trigger: 'pit-out',        expected: false },
    { state: 'RETIRED', trigger: 'manual-retire',  expected: false },
    { state: 'FINISHED',trigger: 'race-end',       expected: false },
    { state: 'RUNNING', trigger: 'manual-retire',  expected: true },
    { state: 'RUNNING', trigger: 'internal-error', expected: true },
    { state: 'FAULT',   trigger: 'internal-error', expected: false },
  ];
  for (const c of cases) {
    assert.equal(canTransition(c.state, c.trigger), c.expected, `${c.state}/${c.trigger}`);
    const out = transition({ state: c.state, previousState: null, reason: null }, c.trigger);
    assert.equal(out.changed, c.expected, `transition(${c.state}/${c.trigger}).changed`);
  }
});

test('canTransition false per stati non validi', () => {
  assert.equal(canTransition('FOO', 'race-start'), false);
  assert.equal(canTransition(null, 'race-start'), false);
});

console.log('\nfsm.transition - scenari di gara end-to-end');

test('flusso normale: INIT -> RUNNING -> PIT -> RUNNING -> FINISHED', () => {
  let f = initialFsm();
  f = transition(f, 'race-start'); assert.equal(f.state, 'RUNNING');
  f = transition(f, 'scheduled-pit'); assert.equal(f.state, 'PIT');
  f = transition(f, 'pit-out'); assert.equal(f.state, 'RUNNING');
  f = transition(f, 'race-end'); assert.equal(f.state, 'FINISHED');
});

test('flusso ritiro: INIT -> RUNNING -> FAULT -> RETIRED', () => {
  let f = initialFsm();
  f = transition(f, 'race-start'); assert.equal(f.state, 'RUNNING');
  f = transition(f, 'tire-overheat'); assert.equal(f.state, 'FAULT');
  f = transition(f, 'unrecoverable'); assert.equal(f.state, 'RETIRED');
  // Ulteriori tick sono no-op.
  f = transition(f, 'race-end'); assert.equal(f.state, 'RETIRED');
  assert.equal(f.changed, false);
});

test('flusso DNS: INIT -> RETIRED via manual-retire', () => {
  let f = initialFsm();
  f = transition(f, 'manual-retire');
  assert.equal(f.state, 'RETIRED');
  assert.equal(f.previousState, 'INIT');
});

test('flusso eccezione: any -> FAULT via internal-error, poi RETIRED', () => {
  let f = { state: 'RUNNING', previousState: 'INIT', reason: 'race-start' };
  f = transition(f, 'internal-error'); assert.equal(f.state, 'FAULT');
  f = transition(f, 'unrecoverable'); assert.equal(f.state, 'RETIRED');
});

console.log('\nfsm - sanity matrice TRANSITIONS');

test('ogni transizione referenzia stati validi', () => {
  for (const t of TRANSITIONS) {
    assert.ok(t.from === '*' || isValidState(t.from), `from non valido: ${t.from}`);
    assert.ok(isValidState(t.to), `to non valido: ${t.to}`);
    assert.ok(typeof t.trigger === 'string' && t.trigger.length > 0, `trigger vuoto`);
  }
});

test('ogni trigger dichiarato in TRIGGERS appare nella matrice', () => {
  const usedTriggers = new Set(TRANSITIONS.map((t) => t.trigger));
  for (const trig of Object.values(TRIGGERS)) {
    assert.ok(usedTriggers.has(trig), `trigger ${trig} non usato in TRANSITIONS`);
  }
});

test('nessun stato terminale ha transizioni uscenti specifiche', () => {
  for (const t of TRANSITIONS) {
    if (t.from !== '*') {
      assert.ok(!TERMINAL_STATES.includes(t.from), `transizione uscente da stato terminale: ${t.from}`);
    }
  }
});

console.log(`\n${passed} test passati`);
