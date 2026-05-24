const assert = require('node:assert/strict');
const {
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
  onEnterPit,
  onEnterFault,
  samplePitDurationS,
  evaluate,
} = require('../src/car/conditions');

const { STATES, TRIGGERS, transition, initialFsm } = require('../src/car/fsm');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ----------------------------------------------------------------------------
console.log('conditions.constants');
// ----------------------------------------------------------------------------

test('costanti coerenti con docs/simulator-architecture.md §7.1', () => {
  assert.equal(FUEL_PIT_THRESHOLD_KG, 8);
  assert.equal(TIRE_OVERHEAT_THRESHOLD_C, 180);
  assert.equal(TIRE_OVERHEAT_TICKS_REQUIRED, 3);
  assert.equal(ENGINE_FAILURE_PROB_PER_TICK, 1e-4);
  assert.equal(FAULT_GRACE_S, 0);
  assert.equal(FAULT_DIAGNOSE_S, 5);
  assert.equal(PIT_DURATION_MIN_S, 2.0);
  assert.equal(PIT_DURATION_MAX_S, 3.5);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.initialConditionsTracker');
// ----------------------------------------------------------------------------

test('initial tracker: counters reset and timers null', () => {
  const t = initialConditionsTracker();
  assert.equal(t.tireOverheatTicks, 0);
  assert.equal(t.faultEnteredAtS, null);
  assert.equal(t.pitEnteredAtS, null);
  assert.equal(t.pitDurationS, null);
});

test('initialConditionsTracker ritorna istanze indipendenti', () => {
  const a = initialConditionsTracker();
  const b = initialConditionsTracker();
  assert.notStrictEqual(a, b);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.maxTireTemp');
// ----------------------------------------------------------------------------

test('max tra le 4 ruote', () => {
  assert.equal(maxTireTemp({ fl: 100, fr: 110, rl: 120, rr: 115 }), 120);
  assert.equal(maxTireTemp({ fl: 95, fr: 95, rl: 95, rr: 95 }), 95);
});

test('input nulli o non numerici ritornano 0', () => {
  assert.equal(maxTireTemp(null), 0);
  assert.equal(maxTireTemp(undefined), 0);
  assert.equal(maxTireTemp({}), 0);
  assert.equal(maxTireTemp({ fl: 'a', fr: NaN, rl: null, rr: undefined }), 0);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isLowFuel');
// ----------------------------------------------------------------------------

test('fuel < threshold (default 8 kg) -> true', () => {
  assert.equal(isLowFuel(7.99), true);
  assert.equal(isLowFuel(0), true);
});

test('fuel >= threshold -> false (strictly lower edge)', () => {
  assert.equal(isLowFuel(8), false);
  assert.equal(isLowFuel(8.01), false);
  assert.equal(isLowFuel(105), false);
});

test('custom threshold respected', () => {
  assert.equal(isLowFuel(9, 10), true);
  assert.equal(isLowFuel(10, 10), false);
});

test('input non numerico -> false', () => {
  assert.equal(isLowFuel(null), false);
  assert.equal(isLowFuel(undefined), false);
  assert.equal(isLowFuel(NaN), false);
  assert.equal(isLowFuel('5'), false);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.tireOverheatNextTicks / isTireOverheatLatched');
// ----------------------------------------------------------------------------

test('temperature > 180 increments the counter', () => {
  assert.equal(tireOverheatNextTicks({ fl: 181, fr: 100, rl: 100, rr: 100 }, 0), 1);
  assert.equal(tireOverheatNextTicks({ fl: 181, fr: 100, rl: 100, rr: 100 }, 2), 3);
});

test('temperature <= 180 resets the counter (no degradation)', () => {
  assert.equal(tireOverheatNextTicks({ fl: 180, fr: 180, rl: 180, rr: 180 }, 5), 0);
  assert.equal(tireOverheatNextTicks({ fl: 100, fr: 100, rl: 100, rr: 100 }, 5), 0);
});

test('isTireOverheatLatched true sse ticks >= 3', () => {
  assert.equal(isTireOverheatLatched(0), false);
  assert.equal(isTireOverheatLatched(2), false);
  assert.equal(isTireOverheatLatched(3), true);
  assert.equal(isTireOverheatLatched(10), true);
});

test('custom tick threshold', () => {
  assert.equal(isTireOverheatLatched(2, 5), false);
  assert.equal(isTireOverheatLatched(5, 5), true);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isEngineFailure');
// ----------------------------------------------------------------------------

test('rng < prob -> true', () => {
  assert.equal(isEngineFailure(() => 0, 1e-4), true);
  assert.equal(isEngineFailure(() => 5e-5, 1e-4), true);
});

test('rng >= prob -> false', () => {
  assert.equal(isEngineFailure(() => 1e-4, 1e-4), false);
  assert.equal(isEngineFailure(() => 0.5, 1e-4), false);
  assert.equal(isEngineFailure(() => 0.99999, 1e-4), false);
});

test('rng mancante o prob <= 0 -> false', () => {
  assert.equal(isEngineFailure(undefined), false);
  assert.equal(isEngineFailure(null), false);
  assert.equal(isEngineFailure(() => 0.0, 0), false);
  assert.equal(isEngineFailure(() => 0.0, -1), false);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isFaultGraceElapsed');
// ----------------------------------------------------------------------------

test('grace assente o zero -> fault abilitati subito', () => {
  assert.equal(isFaultGraceElapsed(0, 0), true);
  assert.equal(isFaultGraceElapsed(10, undefined), true);
});

test('positive grace protects until the threshold', () => {
  assert.equal(isFaultGraceElapsed(44.99, 45), false);
  assert.equal(isFaultGraceElapsed(45, 45), true);
  assert.equal(isFaultGraceElapsed(60, 45), true);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isPitTimeElapsed');
// ----------------------------------------------------------------------------

test('nowS - enteredAt >= duration -> true', () => {
  assert.equal(isPitTimeElapsed(10, 2.5, 12.5), true);
  assert.equal(isPitTimeElapsed(10, 2.5, 100), true);
});

test('nowS - enteredAt < duration -> false', () => {
  assert.equal(isPitTimeElapsed(10, 2.5, 12.49), false);
});

test('timer non inizializzato (null) -> false', () => {
  assert.equal(isPitTimeElapsed(null, 2.5, 100), false);
  assert.equal(isPitTimeElapsed(10, null, 100), false);
  assert.equal(isPitTimeElapsed(10, 2.5, null), false);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isFaultUnrecoverable');
// ----------------------------------------------------------------------------

test('FAULT >= 5 s -> true', () => {
  assert.equal(isFaultUnrecoverable(0, 5), true);
  assert.equal(isFaultUnrecoverable(10, 15.5), true);
});

test('FAULT < 5 s -> false', () => {
  assert.equal(isFaultUnrecoverable(10, 14.99), false);
});

test('timer non inizializzato (null) -> false', () => {
  assert.equal(isFaultUnrecoverable(null, 100), false);
  assert.equal(isFaultUnrecoverable(10, null), false);
});

test('custom diagnose threshold', () => {
  assert.equal(isFaultUnrecoverable(0, 3, 3), true);
  assert.equal(isFaultUnrecoverable(0, 2.99, 3), false);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.isRaceEnd');
// ----------------------------------------------------------------------------

test('lap >= totalLaps && CHECKERED -> true', () => {
  assert.equal(isRaceEnd(15, 15, true), true);
  assert.equal(isRaceEnd(20, 15, true), true);
});

test('lap >= totalLaps senza CHECKERED -> false', () => {
  assert.equal(isRaceEnd(15, 15, false), false);
  assert.equal(isRaceEnd(15, 15, undefined), false);
});

test('lap < totalLaps anche con CHECKERED -> false', () => {
  assert.equal(isRaceEnd(14, 15, true), false);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.onEnterPit / onEnterFault / samplePitDurationS');
// ----------------------------------------------------------------------------

test('onEnterPit imposta enteredAt e duration, non muta input', () => {
  const t0 = initialConditionsTracker();
  const t1 = onEnterPit(t0, 100, 2.5);
  assert.equal(t1.pitEnteredAtS, 100);
  assert.equal(t1.pitDurationS, 2.5);
  assert.equal(t0.pitEnteredAtS, null, 'input non mutato');
  assert.notStrictEqual(t0, t1);
});

test('onEnterFault imposta enteredAt e azzera ticks tire-overheat', () => {
  const t0 = { ...initialConditionsTracker(), tireOverheatTicks: 2 };
  const t1 = onEnterFault(t0, 50);
  assert.equal(t1.faultEnteredAtS, 50);
  assert.equal(t1.tireOverheatTicks, 0);
  assert.equal(t0.tireOverheatTicks, 2, 'input non mutato');
});

test('samplePitDurationS rispetta il range di default', () => {
  const out = samplePitDurationS(() => 0.5);
  assert.equal(out, (PIT_DURATION_MIN_S + PIT_DURATION_MAX_S) / 2);
});

test('samplePitDurationS estremi 0 e 1', () => {
  assert.equal(samplePitDurationS(() => 0), PIT_DURATION_MIN_S);
  assert.equal(samplePitDurationS(() => 1), PIT_DURATION_MAX_S);
});

test('samplePitDurationS senza rng -> midpoint', () => {
  assert.equal(samplePitDurationS(undefined), (PIT_DURATION_MIN_S + PIT_DURATION_MAX_S) / 2);
});

test('samplePitDurationS clampa rng fuori [0,1]', () => {
  assert.equal(samplePitDurationS(() => -0.5), PIT_DURATION_MIN_S);
  assert.equal(samplePitDurationS(() => 1.5), PIT_DURATION_MAX_S);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - RUNNING');
// ----------------------------------------------------------------------------

const baseRunningObs = {
  fuel: 50,
  tireTemp: { fl: 110, fr: 110, rl: 110, rr: 110 },
  lap: 1,
  trackPos: 0.50,
  pitEntryPos: 0.95,
  tireServiceLap: 2,
  tireServiceCompleted: false,
  totalLaps: 15,
  checkeredActive: false,
  nowS: 100,
  rng: () => 0.5, // no engine failure
};

test('RUNNING senza condizioni: trigger null, contatore tire-overheat aggiornato', () => {
  const t0 = initialConditionsTracker();
  const out = evaluate(STATES.RUNNING, baseRunningObs, t0);
  assert.equal(out.trigger, null);
  assert.equal(out.reason, null);
  assert.equal(out.tracker.tireOverheatTicks, 0);
});

test('RUNNING keeps low fuel as telemetry, not as an operational PIT trigger', () => {
  const obs = { ...baseRunningObs, fuel: 5 };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(isLowFuel(obs.fuel), true);
  assert.equal(out.trigger, null);
  assert.equal(out.reason, null);
});

test('RUNNING -> tire-service when service lap reaches pit-entry window', () => {
  const obs = {
    ...baseRunningObs,
    fuel: 30,
    lap: 2,
    trackPos: 0.96,
    tireServiceCompleted: false,
  };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(out.trigger, TRIGGERS.TIRE_SERVICE);
  assert.match(out.reason, /^tire-service:lap-2$/);
});

test('RUNNING -> tire-overheat only after 3 consecutive ticks above threshold', () => {
  const hot = { ...baseRunningObs, tireTemp: { fl: 185, fr: 100, rl: 100, rr: 100 } };
  let t = initialConditionsTracker();

  let out = evaluate(STATES.RUNNING, hot, t);
  assert.equal(out.trigger, null);
  assert.equal(out.tracker.tireOverheatTicks, 1);
  t = out.tracker;

  out = evaluate(STATES.RUNNING, hot, t);
  assert.equal(out.trigger, null);
  assert.equal(out.tracker.tireOverheatTicks, 2);
  t = out.tracker;

  out = evaluate(STATES.RUNNING, hot, t);
  assert.equal(out.trigger, TRIGGERS.TIRE_OVERHEAT);
  assert.match(out.reason, /^tire-overheat:max=185\.0C$/);
  // Counter resettato dopo l'emissione del trigger
  assert.equal(out.tracker.tireOverheatTicks, 0);
});

test('RUNNING -> tire-overheat: counter decays when temperature returns below threshold', () => {
  const hot = { ...baseRunningObs, tireTemp: { fl: 185, fr: 100, rl: 100, rr: 100 } };
  const cool = { ...baseRunningObs, tireTemp: { fl: 100, fr: 100, rl: 100, rr: 100 } };
  let t = initialConditionsTracker();

  t = evaluate(STATES.RUNNING, hot, t).tracker;  // 1
  t = evaluate(STATES.RUNNING, hot, t).tracker;  // 2
  t = evaluate(STATES.RUNNING, cool, t).tracker; // reset a 0
  assert.equal(t.tireOverheatTicks, 0);

  // Ora un solo tick caldo non basta
  const out = evaluate(STATES.RUNNING, hot, t);
  assert.equal(out.trigger, null);
  assert.equal(out.tracker.tireOverheatTicks, 1);
});

test('RUNNING -> engine-failure quando rng < prob', () => {
  const obs = { ...baseRunningObs, rng: () => 0.0, engineFailureProb: 1e-3 };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(out.trigger, TRIGGERS.ENGINE_FAILURE);
  assert.equal(out.reason, TRIGGERS.ENGINE_FAILURE);
});

test('RUNNING: faultGraceS blocca engine-failure e tire-overheat iniziali', () => {
  const t = { ...initialConditionsTracker(), tireOverheatTicks: 2 };
  const obs = {
    ...baseRunningObs,
    nowS: 30,
    faultGraceS: 45,
    rng: () => 0.0,
    engineFailureProb: 1e-3,
    tireTemp: { fl: 220, fr: 220, rl: 220, rr: 220 },
  };
  const out = evaluate(STATES.RUNNING, obs, t);
  assert.equal(out.trigger, null);
  assert.equal(out.tracker.tireOverheatTicks, 0);
});

test('RUNNING: faultGraceS scaduta riabilita engine-failure', () => {
  const obs = {
    ...baseRunningObs,
    nowS: 45,
    faultGraceS: 45,
    rng: () => 0.0,
    engineFailureProb: 1e-3,
  };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(out.trigger, TRIGGERS.ENGINE_FAILURE);
});

test('RUNNING -> race-end quando lap >= totalLaps && CHECKERED', () => {
  const obs = { ...baseRunningObs, lap: 15, totalLaps: 15, checkeredActive: true };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(out.trigger, TRIGGERS.RACE_END);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - priorita RUNNING');
// ----------------------------------------------------------------------------

test('priorita: race-end batte engine-failure', () => {
  // rng=0 would trigger engine-failure if evaluated; race-end takes priority
  const obs = {
    ...baseRunningObs,
    lap: 15,
    totalLaps: 15,
    checkeredActive: true,
    rng: () => 0.0,
    engineFailureProb: 1e-3,
  };
  const out = evaluate(STATES.RUNNING, obs, initialConditionsTracker());
  assert.equal(out.trigger, TRIGGERS.RACE_END);
});

test('priorita: engine-failure batte tire-overheat', () => {
  const t = { ...initialConditionsTracker(), tireOverheatTicks: 5 };
  const obs = {
    ...baseRunningObs,
    tireTemp: { fl: 200, fr: 200, rl: 200, rr: 200 },
    rng: () => 0.0,
    engineFailureProb: 1e-3,
  };
  const out = evaluate(STATES.RUNNING, obs, t);
  assert.equal(out.trigger, TRIGGERS.ENGINE_FAILURE);
});

test('priority: tire-overheat beats non-critical fuel telemetry', () => {
  const t = { ...initialConditionsTracker(), tireOverheatTicks: 2 };
  const obs = {
    ...baseRunningObs,
    fuel: 1,
    tireTemp: { fl: 200, fr: 200, rl: 200, rr: 200 },
  };
  const out = evaluate(STATES.RUNNING, obs, t);
  assert.equal(out.trigger, TRIGGERS.TIRE_OVERHEAT);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - PIT');
// ----------------------------------------------------------------------------

test('PIT without elapsed timer: no trigger', () => {
  let t = onEnterPit(initialConditionsTracker(), 100, 2.5);
  const obs = { ...baseRunningObs, nowS: 101 };
  const out = evaluate(STATES.PIT, obs, t);
  assert.equal(out.trigger, null);
});

test('PIT -> pit-out quando timer elapsed', () => {
  const t = onEnterPit(initialConditionsTracker(), 100, 2.5);
  const obs = { ...baseRunningObs, nowS: 102.5 };
  const out = evaluate(STATES.PIT, obs, t);
  assert.equal(out.trigger, TRIGGERS.PIT_OUT);
  assert.equal(out.reason, TRIGGERS.PIT_OUT);
  // Timer resettato dopo pit-out
  assert.equal(out.tracker.pitEnteredAtS, null);
  assert.equal(out.tracker.pitDurationS, null);
});

test('PIT -> engine-failure precede pit-out', () => {
  const t = onEnterPit(initialConditionsTracker(), 100, 2.5);
  const obs = {
    ...baseRunningObs,
    nowS: 110,
    rng: () => 0.0,
    engineFailureProb: 1e-3,
  };
  const out = evaluate(STATES.PIT, obs, t);
  assert.equal(out.trigger, TRIGGERS.ENGINE_FAILURE);
});

test('PIT -> race-end on the final lap (pit during CHECKERED lap)', () => {
  const t = onEnterPit(initialConditionsTracker(), 100, 2.5);
  const obs = {
    ...baseRunningObs,
    nowS: 101,
    lap: 15,
    totalLaps: 15,
    checkeredActive: true,
  };
  const out = evaluate(STATES.PIT, obs, t);
  assert.equal(out.trigger, TRIGGERS.RACE_END);
});

test('PIT: low fuel is not evaluated as a pit trigger (already in pit)', () => {
  const t = onEnterPit(initialConditionsTracker(), 100, 2.5);
  const obs = { ...baseRunningObs, nowS: 101, fuel: 1 };
  const out = evaluate(STATES.PIT, obs, t);
  assert.equal(out.trigger, null);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - FAULT');
// ----------------------------------------------------------------------------

test('FAULT without elapsed timer: no trigger', () => {
  const t = onEnterFault(initialConditionsTracker(), 100);
  const obs = { ...baseRunningObs, nowS: 102 };
  const out = evaluate(STATES.FAULT, obs, t);
  assert.equal(out.trigger, null);
});

test('FAULT -> unrecoverable quando timer >= 5s', () => {
  const t = onEnterFault(initialConditionsTracker(), 100);
  const obs = { ...baseRunningObs, nowS: 105 };
  const out = evaluate(STATES.FAULT, obs, t);
  assert.equal(out.trigger, TRIGGERS.UNRECOVERABLE);
  assert.equal(out.tracker.faultEnteredAtS, null);
});

test('FAULT: engine-failure is not evaluated (already in fault)', () => {
  const t = onEnterFault(initialConditionsTracker(), 100);
  const obs = {
    ...baseRunningObs,
    nowS: 102,
    rng: () => 0.0,
    engineFailureProb: 1e-3,
  };
  const out = evaluate(STATES.FAULT, obs, t);
  assert.equal(out.trigger, null);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - INIT / RETIRED / FINISHED');
// ----------------------------------------------------------------------------

test('INIT: no state condition (race-start is external)', () => {
  const obs = { ...baseRunningObs, fuel: 1, lap: 100, totalLaps: 15, checkeredActive: true };
  const out = evaluate(STATES.INIT, obs, initialConditionsTracker());
  assert.equal(out.trigger, null);
});

test('RETIRED: sempre no-op', () => {
  const out = evaluate(STATES.RETIRED, baseRunningObs, initialConditionsTracker());
  assert.equal(out.trigger, null);
});

test('FINISHED: sempre no-op', () => {
  const out = evaluate(STATES.FINISHED, baseRunningObs, initialConditionsTracker());
  assert.equal(out.trigger, null);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.evaluate - immutability and robustness');
// ----------------------------------------------------------------------------

test('input observation/tracker non mutati', () => {
  const obs = { ...baseRunningObs, fuel: 1 };
  const obsSnap = { ...obs };
  const t = initialConditionsTracker();
  const tSnap = { ...t };
  evaluate(STATES.RUNNING, obs, t);
  assert.deepEqual(obs, obsSnap);
  assert.deepEqual(t, tSnap);
});

test('null/undefined tracker: treated as initial', () => {
  const out = evaluate(STATES.RUNNING, baseRunningObs, null);
  assert.equal(out.trigger, null);
  assert.equal(out.tracker.tireOverheatTicks, 0);
});

test('observation null: nessuna eccezione, no trigger', () => {
  const out = evaluate(STATES.RUNNING, null, initialConditionsTracker());
  assert.equal(out.trigger, null);
});

test('fsmState sconosciuto: no trigger', () => {
  const out = evaluate('UNKNOWN', baseRunningObs, initialConditionsTracker());
  assert.equal(out.trigger, null);
});

// ----------------------------------------------------------------------------
console.log('\nconditions.integration - full lap with real FSM');
// ----------------------------------------------------------------------------

test('normal race flow: INIT -> RUNNING -> PIT through tire service -> RUNNING -> FINISHED', () => {
  let fsm = initialFsm();
  let t = initialConditionsTracker();

  // race-start (esterno)
  fsm = transition(fsm, TRIGGERS.RACE_START);
  assert.equal(fsm.state, STATES.RUNNING);

  // Scheduled tire service at the pit-entry window.
  let result = evaluate(fsm.state, {
    ...baseRunningObs,
    fuel: 30,
    lap: 2,
    trackPos: 0.96,
    tireServiceCompleted: false,
  }, t);
  assert.equal(result.trigger, TRIGGERS.TIRE_SERVICE);
  fsm = transition(fsm, result.trigger, result.reason);
  assert.equal(fsm.state, STATES.PIT);
  t = onEnterPit(result.tracker, 200, 2.5);

  // PIT timer non ancora scaduto
  result = evaluate(fsm.state, { ...baseRunningObs, nowS: 201 }, t);
  assert.equal(result.trigger, null);
  t = result.tracker;

  // PIT timer scaduto -> pit-out
  result = evaluate(fsm.state, { ...baseRunningObs, nowS: 203 }, t);
  assert.equal(result.trigger, TRIGGERS.PIT_OUT);
  fsm = transition(fsm, result.trigger);
  assert.equal(fsm.state, STATES.RUNNING);
  t = result.tracker;

  // CHECKERED al lap finale
  result = evaluate(fsm.state, {
    ...baseRunningObs,
    lap: 15,
    totalLaps: 15,
    checkeredActive: true,
  }, t);
  assert.equal(result.trigger, TRIGGERS.RACE_END);
  fsm = transition(fsm, result.trigger);
  assert.equal(fsm.state, STATES.FINISHED);
});

test('retirement flow: INIT -> RUNNING -> FAULT (tire-overheat 3 ticks) -> RETIRED', () => {
  let fsm = initialFsm();
  let t = initialConditionsTracker();

  fsm = transition(fsm, TRIGGERS.RACE_START);

  const hot = { ...baseRunningObs, tireTemp: { fl: 200, fr: 200, rl: 200, rr: 200 } };
  for (let i = 0; i < 2; i += 1) {
    const r = evaluate(fsm.state, hot, t);
    assert.equal(r.trigger, null);
    t = r.tracker;
  }
  const r3 = evaluate(fsm.state, hot, t);
  assert.equal(r3.trigger, TRIGGERS.TIRE_OVERHEAT);
  fsm = transition(fsm, r3.trigger, r3.reason);
  assert.equal(fsm.state, STATES.FAULT);
  t = onEnterFault(r3.tracker, 50);

  // Still inside the diagnose window
  let r = evaluate(fsm.state, { ...hot, nowS: 53 }, t);
  assert.equal(r.trigger, null);
  t = r.tracker;

  // Oltre 5 s -> unrecoverable
  r = evaluate(fsm.state, { ...hot, nowS: 56 }, t);
  assert.equal(r.trigger, TRIGGERS.UNRECOVERABLE);
  fsm = transition(fsm, r.trigger);
  assert.equal(fsm.state, STATES.RETIRED);
});

console.log(`\n${passed} tests passed`);
