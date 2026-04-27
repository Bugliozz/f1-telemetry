const assert = require('node:assert/strict');
const {
  advance,
  updateSpeed,
  MAX_ACCEL_MS2,
  MAX_BRAKE_MS2,
} = require('../src/car/physics');
const { LENGTH_M, SPEED_PROFILE, targetSpeed } = require('../src/track/monza');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('physics.advance');

test('velocita zero: nessun avanzamento', () => {
  const out = advance({ trackPos: 0.5, lap: 3 }, 0, 0.25);
  assert.equal(out.trackPos, 0.5);
  assert.equal(out.lap, 3);
  assert.equal(out.lapsCompleted, 0);
});

test('dt zero: nessun avanzamento', () => {
  const out = advance({ trackPos: 0.2, lap: 1 }, 200, 0);
  assert.equal(out.trackPos, 0.2);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 0);
});

test('avanzamento noto: 60 m/s per 0.25 s = 15 m', () => {
  // 60 m/s = 216 km/h. dt = 0.25 s. distanza = 15 m. delta = 15/5793.
  const out = advance({ trackPos: 0, lap: 0 }, 216, 0.25);
  const expected = 15 / LENGTH_M;
  assert.ok(Math.abs(out.trackPos - expected) < 1e-9, `trackPos=${out.trackPos}, expected≈${expected}`);
  assert.equal(out.lap, 0);
  assert.equal(out.lapsCompleted, 0);
});

test('wrap: trackPos>=1 riporta a [0,1) e incrementa lap', () => {
  // 360 km/h = 100 m/s. dt = 1 s -> 100 m. delta ≈ 0.01726.
  // 0.99 + 0.01726 = 1.00726 -> wrap a 0.00726, lap 0 -> 1.
  const out = advance({ trackPos: 0.99, lap: 0 }, 360, 1);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 1);
  assert.ok(out.trackPos >= 0 && out.trackPos < 0.02, `trackPos=${out.trackPos}`);
});

test('wrap multiplo: dt enorme completa piu giri (difensivo)', () => {
  // 360 km/h = 100 m/s. dt = 600 s -> 60 km. Monza ≈ 5.793 km/giro.
  // Giri completi attesi: 60000/5793 ≈ 10.36 -> 10 giri completi.
  const out = advance({ trackPos: 0, lap: 0 }, 360, 600);
  assert.equal(out.lapsCompleted, 10);
  assert.equal(out.lap, 10);
  assert.ok(out.trackPos >= 0 && out.trackPos < 1);
});

test('integrazione su piu tick: 100 m/s per 58 s = 5800 m (1 giro + 7 m)', () => {
  // Numeri scelti esatti per evitare drift di floating point:
  // 360 km/h = 100 m/s. 58 tick da 1 s = 5800 m. Monza = 5793 m.
  // Atteso: 1 giro completato, trackPos = 7/5793.
  let state = { trackPos: 0, lap: 0 };
  let totalCompleted = 0;
  for (let i = 0; i < 58; i += 1) {
    const out = advance(state, 360, 1);
    totalCompleted += out.lapsCompleted;
    state = { trackPos: out.trackPos, lap: out.lap };
  }
  assert.equal(totalCompleted, 1);
  assert.equal(state.lap, 1);
  const residual = 7 / LENGTH_M;
  assert.ok(Math.abs(state.trackPos - residual) < 1e-9, `trackPos=${state.trackPos} expected≈${residual}`);
});

test('immutabilita: input non modificato', () => {
  const input = { trackPos: 0.42, lap: 2 };
  advance(input, 200, 0.25);
  assert.equal(input.trackPos, 0.42);
  assert.equal(input.lap, 2);
});

test('velocita negativa clampata a 0', () => {
  const out = advance({ trackPos: 0.3, lap: 1 }, -50, 0.25);
  assert.equal(out.trackPos, 0.3);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 0);
});

test('coerenza con stima architettura: 60 m/s, dt=250 ms ≈ 0.00259', () => {
  // Da docs/simulator-architecture.md §4.2.
  const out = advance({ trackPos: 0, lap: 0 }, 60 * 3.6, 0.25);
  assert.ok(Math.abs(out.trackPos - 0.00259) < 5e-5, `trackPos=${out.trackPos}`);
});

console.log('\nmonza.targetSpeed');

test('punti tabellati restituiscono il valore esatto della tabella', () => {
  for (const point of SPEED_PROFILE) {
    const v = targetSpeed(point.pos);
    assert.ok(Math.abs(v - point.kmh) < 1e-9, `pos=${point.pos} got=${v}`);
  }
});

test('interpolazione lineare a meta segmento', () => {
  // Meta tra 0.000 (340) e 0.060 (95): atteso (340+95)/2 = 217.5
  const v = targetSpeed(0.030);
  assert.ok(Math.abs(v - 217.5) < 1e-9, `got=${v}`);
});

test('interpolazione lineare al 25% di un segmento', () => {
  // 25% da 0.420 (200) verso 0.480 (215): 200 + 0.25*15 = 203.75
  const pos = 0.420 + 0.25 * (0.480 - 0.420);
  const v = targetSpeed(pos);
  assert.ok(Math.abs(v - 203.75) < 1e-9, `got=${v}`);
});

test('periodicita: targetSpeed(1) === targetSpeed(0)', () => {
  assert.equal(targetSpeed(1), targetSpeed(0));
});

test('wrap di trackPos > 1 (difensivo)', () => {
  // 2.7 deve essere ricondotto a 0.7
  assert.ok(Math.abs(targetSpeed(2.7) - targetSpeed(0.7)) < 1e-9);
});

test('valore non finito: fallback a posizione 0', () => {
  assert.equal(targetSpeed(NaN), targetSpeed(0));
});

test('curve sono piu lente dei rettilinei adiacenti (sanity)', () => {
  // Variante del Rettifilo (chicane) deve essere il punto piu lento del giro.
  const chicane = targetSpeed(0.060);
  const startFinish = targetSpeed(0.000);
  const curvaGrande = targetSpeed(0.180);
  assert.ok(chicane < startFinish, `chicane ${chicane} >= start ${startFinish}`);
  assert.ok(chicane < curvaGrande, `chicane ${chicane} >= grande ${curvaGrande}`);
});

console.log('\nphysics.updateSpeed');

test('target uguale a corrente: nessun cambio', () => {
  assert.equal(updateSpeed(200, 200, 0.25), 200);
});

test('dt zero: nessun cambio anche con target diverso', () => {
  assert.equal(updateSpeed(100, 300, 0), 100);
});

test('accelerazione limitata da MAX_ACCEL_MS2', () => {
  // dt = 1 s, MAX_ACCEL = 8 m/s^2 = 28.8 km/h/s.
  // Da 100 verso 300, in 1 s puo aggiungere al massimo 28.8 km/h.
  const v = updateSpeed(100, 300, 1);
  assert.ok(Math.abs(v - 128.8) < 1e-9, `got=${v}`);
});

test('frenata limitata da MAX_BRAKE_MS2', () => {
  // dt = 1 s, MAX_BRAKE = 25 m/s^2 = 90 km/h/s.
  // Da 300 verso 100, in 1 s puo togliere al massimo 90 km/h.
  const v = updateSpeed(300, 100, 1);
  assert.ok(Math.abs(v - 210) < 1e-9, `got=${v}`);
});

test('frenata e piu rapida dell accelerazione (cap diversi)', () => {
  assert.ok(MAX_BRAKE_MS2 > MAX_ACCEL_MS2);
  const accel = updateSpeed(100, 300, 0.5) - 100;
  const brake = 300 - updateSpeed(300, 100, 0.5);
  assert.ok(brake > accel, `brake=${brake} accel=${accel}`);
});

test('target raggiunto se delta entro il limite del tick', () => {
  // dt = 0.25 s -> max accel = 28.8 * 0.25 = 7.2 km/h.
  // Da 200 verso 205: delta 5 < 7.2 -> raggiunge 205.
  assert.equal(updateSpeed(200, 205, 0.25), 205);
});

test('target raggiunto in frenata se delta entro il limite del tick', () => {
  // dt = 0.25 s -> max brake = 90 * 0.25 = 22.5 km/h.
  // Da 200 verso 190: delta -10, |delta| < 22.5 -> raggiunge 190.
  assert.equal(updateSpeed(200, 190, 0.25), 190);
});

test('velocita corrente negativa clamp-ata a 0 prima di accelerare', () => {
  // Da -10 verso 50, dt = 1 s: parte da 0, max accel 28.8 -> 28.8.
  const v = updateSpeed(-10, 50, 1);
  assert.ok(Math.abs(v - 28.8) < 1e-9, `got=${v}`);
});

test('target negativo trattato come 0 (frena verso fermo)', () => {
  // Da 50 verso -100, dt = 1 s: target 0, brake max 90 -> raggiunge 0.
  const v = updateSpeed(50, -100, 1);
  assert.equal(v, 0);
});

test('integrazione 0 -> ~340 km/h impiega ~12 s di pieno gas', () => {
  // 340 km/h / (8 m/s^2 * 3.6 km/h/s/m/s^2) = 340 / 28.8 ≈ 11.81 s.
  let v = 0;
  let t = 0;
  const dt = 0.25;
  while (v < 340 && t < 30) {
    v = updateSpeed(v, 340, dt);
    t += dt;
  }
  assert.ok(t >= 11.5 && t <= 12.25, `tempo a 340 km/h: ${t}`);
  assert.ok(Math.abs(v - 340) < 1e-9, `v finale=${v}`);
});

test('integrazione frenata 340 -> 95 km/h impiega ~2.7 s', () => {
  // (340 - 95) / (25 * 3.6) = 245 / 90 ≈ 2.722 s.
  let v = 340;
  let t = 0;
  const dt = 0.25;
  while (v > 95 && t < 10) {
    v = updateSpeed(v, 95, dt);
    t += dt;
  }
  assert.ok(t >= 2.5 && t <= 3.0, `tempo a 95 km/h: ${t}`);
  assert.ok(Math.abs(v - 95) < 1e-9, `v finale=${v}`);
});

test('giro completo a Monza in finestra di lap-time realistico', () => {
  // Integra speed (verso targetSpeed) e posizione tick per tick.
  // Il modello base "pure target-following" segue il profilo lineare di
  // monza.targetSpeed e quindi frena gia' a meta' del rettilineo invece
  // che all'ingresso curva. Risultato: lap time piu lento della stima
  // ottimistica 80-95 s di §6.1 (che presume tardo-frenata). Qui si
  // verifica solo l'ordine di grandezza realistico (1:35-2:10), che e'
  // il risultato atteso dei sistemi base senza degrado/lookahead.
  let pos = 0;
  let lap = 0;
  let speed = targetSpeed(0);
  let t = 0;
  const dt = 0.05;
  while (lap < 1 && t < 200) {
    speed = updateSpeed(speed, targetSpeed(pos), dt);
    const out = advance({ trackPos: pos, lap }, speed, dt);
    pos = out.trackPos;
    lap = out.lap;
    t += dt;
  }
  assert.ok(t >= 95 && t <= 130, `lap time fuori range realistico: ${t}s`);
});

console.log(`\n${passed} test passati`);
