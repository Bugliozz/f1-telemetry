const assert = require('node:assert/strict');
const {
  advance,
  updateSpeed,
  gearForSpeed,
  rpmForSpeed,
  MAX_ACCEL_MS2,
  MAX_BRAKE_MS2,
  GEAR_MIN,
  GEAR_MAX,
  RPM_IDLE,
  RPM_PER_KMH,
  RPM_MAX,
} = require('../src/car/physics');
const { LENGTH_M, SPEED_PROFILE, BRAKING_ZONES, targetSpeed, racingControls } = require('../src/track/monza');

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
  // Meta della prima fase di staccata Rettifilo: brake start (350) -> 0.044 (250).
  const start = BRAKING_ZONES[0].start;
  const v = targetSpeed(start + (0.044 - start) / 2);
  assert.ok(Math.abs(v - 300) < 1e-9, `got=${v}`);
});

test('interpolazione lineare al 25% di un segmento', () => {
  // 25% dell'allungo Serraglio: 0.520 (195) -> 0.589 (315).
  const pos = 0.520 + 0.25 * (0.589 - 0.520);
  const v = targetSpeed(pos);
  assert.ok(Math.abs(v - 225) < 1e-9, `got=${v}`);
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
  const curvaGrande = targetSpeed(0.205);
  assert.ok(chicane < startFinish, `chicane ${chicane} >= start ${startFinish}`);
  assert.ok(chicane < curvaGrande, `chicane ${chicane} >= grande ${curvaGrande}`);
  assert.ok(chicane >= 70 && chicane <= 80, `Prima Variante apex non realistico: ${chicane}`);
});

test('rettilinei lunghi restano in accelerazione prima della braking zone', () => {
  const serraglio = targetSpeed(0.589);
  const backStraight = targetSpeed(0.800);
  const roggiaApproach = targetSpeed(0.270);
  assert.ok(serraglio >= 285, `serraglio target troppo basso: ${serraglio}`);
  assert.ok(backStraight >= 330, `back straight target troppo basso: ${backStraight}`);
  assert.ok(roggiaApproach >= 330, `rettilineo Roggia frena troppo presto: ${roggiaApproach}`);
});

test('braking zone concentrate prima dei punti lenti', () => {
  const roggia = BRAKING_ZONES.find(z => z.id === 'roggia');
  const ascari = BRAKING_ZONES.find(z => z.id === 'ascari');
  const parabolica = BRAKING_ZONES.find(z => z.id === 'parabolica');
  assert.ok(targetSpeed(roggia.start - 0.002) >= 325, 'Roggia non deve frenare prima del cartello dei 100m');
  assert.ok(targetSpeed(roggia.start + 0.004) < targetSpeed(roggia.start), 'Roggia deve frenare dentro la braking zone');
  assert.ok(targetSpeed(ascari.apex) < targetSpeed(ascari.start), 'Ascari deve frenare dopo il Serraglio');
  assert.ok(targetSpeed(parabolica.apex) < targetSpeed(parabolica.start), 'Parabolica deve frenare dopo il back straight');
});

console.log('\nmonza.racingControls');

test('Prima Variante: freno 100% al cartello 150m e trail braking verso apice', () => {
  const zone = BRAKING_ZONES.find(z => z.id === 'prima-variante');
  const hard = racingControls(zone.start + 0.001);
  const trail = racingControls(zone.apex);
  assert.equal(hard.brake, 1);
  assert.equal(hard.throttle, 0);
  assert.ok(trail.brake > 0 && trail.brake < 0.25, `trail brake=${trail.brake}`);
});

test('Curva Grande resta pieno gas senza frenata', () => {
  const controls = racingControls(0.205);
  assert.equal(controls.brake, 0);
  assert.equal(controls.throttle, 1);
});

test('Parabolica riapre il gas prima della fine curva', () => {
  const ramp = racingControls(0.855);
  const exit = racingControls(0.886);
  assert.equal(ramp.brake, 0);
  assert.ok(ramp.throttle > 0.25 && ramp.throttle < 1, `ramp throttle=${ramp.throttle}`);
  assert.equal(exit.brake, 0);
  assert.equal(exit.throttle, 1);
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
  // dt = 1 s, MAX_BRAKE = 44 m/s^2 = 158.4 km/h/s.
  // Da 300 verso 100, in 1 s puo togliere al massimo 158.4 km/h.
  const v = updateSpeed(300, 100, 1);
  assert.ok(Math.abs(v - 141.6) < 1e-9, `got=${v}`);
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
  // dt = 0.25 s -> max brake = 158.4 * 0.25 = 39.6 km/h.
  // Da 200 verso 190: delta -10, |delta| < 39.6 -> raggiunge 190.
  assert.equal(updateSpeed(200, 190, 0.25), 190);
});

test('velocita corrente negativa clamp-ata a 0 prima di accelerare', () => {
  // Da -10 verso 50, dt = 1 s: parte da 0, max accel 28.8 -> 28.8.
  const v = updateSpeed(-10, 50, 1);
  assert.ok(Math.abs(v - 28.8) < 1e-9, `got=${v}`);
});

test('target negativo trattato come 0 (frena verso fermo)', () => {
  // Da 50 verso -100, dt = 1 s: target 0, brake max 158.4 -> raggiunge 0.
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

test('integrazione frenata 340 -> 95 km/h impiega ~1.6 s', () => {
  // (340 - 95) / (44 * 3.6) = 245 / 158.4 ~= 1.55 s.
  let v = 340;
  let t = 0;
  const dt = 0.25;
  while (v > 95 && t < 10) {
    v = updateSpeed(v, 95, dt);
    t += dt;
  }
  assert.ok(t >= 1.5 && t <= 1.75, `tempo a 95 km/h: ${t}`);
  assert.ok(Math.abs(v - 95) < 1e-9, `v finale=${v}`);
});

test('giro completo a Monza in finestra di lap-time realistico', () => {
  // Integra speed (verso targetSpeed) e posizione tick per tick.
  // Il profilo include punti di hold sui rettilinei e braking zone corte,
  // quindi il pure target-following non anticipa la frenata su tutto il
  // rettilineo.
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
  assert.ok(t >= 80 && t <= 105, `lap time fuori range realistico: ${t}s`);
});

console.log('\nphysics.gearForSpeed');

test('velocita zero -> marcia minima (1)', () => {
  assert.equal(gearForSpeed(0), GEAR_MIN);
});

test('velocita molto bassa -> marcia 1 (clamp inferiore)', () => {
  assert.equal(gearForSpeed(20), GEAR_MIN);
  assert.equal(gearForSpeed(40), GEAR_MIN);
});

test('arrotondamento a meta intervallo', () => {
  assert.equal(gearForSpeed(75), 2);
  assert.equal(gearForSpeed(125), 3);
});

test('velocita tipiche di Monza', () => {
  assert.equal(gearForSpeed(95), 2);
  assert.equal(gearForSpeed(200), 4);
  assert.equal(gearForSpeed(290), 6);
  assert.equal(gearForSpeed(340), 7);
});

test('velocita oltre il top di scala -> clamp a GEAR_MAX', () => {
  assert.equal(gearForSpeed(400), GEAR_MAX);
  assert.equal(gearForSpeed(1000), GEAR_MAX);
});

test('input non finito o negativo -> 1', () => {
  assert.equal(gearForSpeed(-50), GEAR_MIN);
  assert.equal(gearForSpeed(NaN), GEAR_MIN);
  assert.equal(gearForSpeed(undefined), GEAR_MIN);
});

console.log('\nphysics.rpmForSpeed');

test('idle: speed 0 -> RPM_IDLE', () => {
  assert.equal(rpmForSpeed(0), RPM_IDLE);
});

test('formula lineare: rpm = 7000 + speed * 22 (senza jitter)', () => {
  assert.equal(rpmForSpeed(100), RPM_IDLE + 100 * RPM_PER_KMH);
  assert.equal(rpmForSpeed(200), RPM_IDLE + 200 * RPM_PER_KMH);
  assert.equal(rpmForSpeed(340), RPM_IDLE + 340 * RPM_PER_KMH);
});

test('jitter additivo, intero in uscita', () => {
  assert.equal(rpmForSpeed(200, 50), RPM_IDLE + 200 * RPM_PER_KMH + 50);
  assert.equal(rpmForSpeed(200, -50), RPM_IDLE + 200 * RPM_PER_KMH - 50);
});

test('output sempre intero anche con jitter frazionario', () => {
  const v = rpmForSpeed(150, 12.7);
  assert.ok(Number.isInteger(v), `rpm non intero: ${v}`);
});

test('rpm clampato sotto RPM_MAX anche con jitter alto', () => {
  // 7000 + 400*22 = 15800; jitter +500 -> 16300, deve essere clampato
  assert.equal(rpmForSpeed(400, 500), RPM_MAX);
});

test('rpm correlato monotonicamente alla velocita', () => {
  const speeds = [0, 50, 100, 150, 200, 250, 300, 340];
  for (let i = 1; i < speeds.length; i += 1) {
    assert.ok(
      rpmForSpeed(speeds[i]) > rpmForSpeed(speeds[i - 1]),
      `rpm non crescente fra ${speeds[i - 1]} e ${speeds[i]}`
    );
  }
});

test('rpm rispetta i limiti dello schema telemetry [0, 16000]', () => {
  for (const v of [0, 100, 200, 300, 340, 400]) {
    const r = rpmForSpeed(v);
    assert.ok(r >= 0 && r <= RPM_MAX, `rpm ${r} fuori range a speed ${v}`);
  }
});

console.log(`\n${passed} test passati`);
