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

test('zero speed: no progress', () => {
  const out = advance({ trackPos: 0.5, lap: 3 }, 0, 0.25);
  assert.equal(out.trackPos, 0.5);
  assert.equal(out.lap, 3);
  assert.equal(out.lapsCompleted, 0);
});

test('dt zero: no progress', () => {
  const out = advance({ trackPos: 0.2, lap: 1 }, 200, 0);
  assert.equal(out.trackPos, 0.2);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 0);
});

test('known advance: 60 m/s for 0.25 s = 15 m', () => {
  // 60 m/s = 216 km/h. dt = 0.25 s. distance = 15 m. delta = 15/5793.
  const out = advance({ trackPos: 0, lap: 0 }, 216, 0.25);
  const expected = 15 / LENGTH_M;
  assert.ok(Math.abs(out.trackPos - expected) < 1e-9, `trackPos=${out.trackPos}, expected≈${expected}`);
  assert.equal(out.lap, 0);
  assert.equal(out.lapsCompleted, 0);
});

test('wrap: trackPos>=1 wraps to [0,1) and increments lap', () => {
  // 360 km/h = 100 m/s. dt = 1 s -> 100 m. delta ≈ 0.01726.
  // 0.99 + 0.01726 = 1.00726 -> wraps to 0.00726, lap 0 -> 1.
  const out = advance({ trackPos: 0.99, lap: 0 }, 360, 1);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 1);
  assert.ok(out.trackPos >= 0 && out.trackPos < 0.02, `trackPos=${out.trackPos}`);
});

test('multiple wrap: huge dt completes multiple laps (defensive)', () => {
  // 360 km/h = 100 m/s. dt = 600 s -> 60 km. Monza ≈ 5.793 km/lap.
  // Expected full laps: 60000/5793 ≈ 10.36 -> 10 full laps.
  const out = advance({ trackPos: 0, lap: 0 }, 360, 600);
  assert.equal(out.lapsCompleted, 10);
  assert.equal(out.lap, 10);
  assert.ok(out.trackPos >= 0 && out.trackPos < 1);
});

test('integration over multiple ticks: 100 m/s for 58 s = 5800 m (1 lap + 7 m)', () => {
  // Numbers chosen to exactly avoid floating-point drift:
  // 360 km/h = 100 m/s. 58 ticks of 1 s = 5800 m. Monza = 5793 m.
  // Expected: 1 lap completed, trackPos = 7/5793.
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

test('immutability: input not modified', () => {
  const input = { trackPos: 0.42, lap: 2 };
  advance(input, 200, 0.25);
  assert.equal(input.trackPos, 0.42);
  assert.equal(input.lap, 2);
});

test('negative speed clamped to 0', () => {
  const out = advance({ trackPos: 0.3, lap: 1 }, -50, 0.25);
  assert.equal(out.trackPos, 0.3);
  assert.equal(out.lap, 1);
  assert.equal(out.lapsCompleted, 0);
});

test('consistency with architecture estimate: 60 m/s, dt=250 ms ≈ 0.00259', () => {
  // From docs/simulator-architecture.md §4.2.
  const out = advance({ trackPos: 0, lap: 0 }, 60 * 3.6, 0.25);
  assert.ok(Math.abs(out.trackPos - 0.00259) < 5e-5, `trackPos=${out.trackPos}`);
});

console.log('\nmonza.targetSpeed');

test('tabulated points return the exact table value', () => {
  for (const point of SPEED_PROFILE) {
    const v = targetSpeed(point.pos);
    assert.ok(Math.abs(v - point.kmh) < 1e-9, `pos=${point.pos} got=${v}`);
  }
});

test('linear interpolation at mid-segment', () => {
  // Midpoint of first Rettifilo braking phase: brake start (350) -> 0.096 (260).
  const start = BRAKING_ZONES[0].start;
  const v = targetSpeed(start + (0.096 - start) / 2);
  assert.ok(Math.abs(v - 305) < 1e-9, `got=${v}`);
});

test('linear interpolation at 25% of a segment', () => {
  // 25% into the Serraglio straight: 0.520 (195) -> 0.589 (315).
  const pos = 0.520 + 0.25 * (0.589 - 0.520);
  const v = targetSpeed(pos);
  assert.ok(Math.abs(v - 225) < 1e-9, `got=${v}`);
});

test('periodicity: targetSpeed(1) === targetSpeed(0)', () => {
  assert.equal(targetSpeed(1), targetSpeed(0));
});

test('wrap of trackPos > 1 (defensive)', () => {
  // 2.7 should be wrapped back to 0.7
  assert.ok(Math.abs(targetSpeed(2.7) - targetSpeed(0.7)) < 1e-9);
});

test('non-finite value: fallback to position 0', () => {
  assert.equal(targetSpeed(NaN), targetSpeed(0));
});

test('corners are slower than adjacent straights (sanity)', () => {
  // Rettifilo chicane must be the slowest point on the lap.
  const chicane = targetSpeed(BRAKING_ZONES[0].apex);
  const startFinish = targetSpeed(0.000);
  const curvaGrande = targetSpeed(0.205);
  assert.ok(chicane < startFinish, `chicane ${chicane} >= start ${startFinish}`);
  assert.ok(chicane < curvaGrande, `chicane ${chicane} >= grande ${curvaGrande}`);
  assert.ok(chicane >= 70 && chicane <= 80, `Prima Variante apex not realistic: ${chicane}`);
});

test('long straights stay at full speed before the braking zone', () => {
  const rettifiloLaunch = targetSpeed(0.070);
  const serraglio = targetSpeed(0.589);
  const backStraight = targetSpeed(0.800);
  const roggiaApproach = targetSpeed(0.270);
  assert.ok(rettifiloLaunch >= 345, `main straight brakes too early: ${rettifiloLaunch}`);
  assert.ok(serraglio >= 285, `serraglio target too low: ${serraglio}`);
  assert.ok(backStraight >= 330, `back straight target too low: ${backStraight}`);
  assert.ok(roggiaApproach >= 330, `roggia straight brakes too early: ${roggiaApproach}`);
});

test('braking zones concentrated before slow corners', () => {
  const firstVariant = BRAKING_ZONES.find(z => z.id === 'prima-variante');
  const roggia = BRAKING_ZONES.find(z => z.id === 'roggia');
  const ascari = BRAKING_ZONES.find(z => z.id === 'ascari');
  const parabolica = BRAKING_ZONES.find(z => z.id === 'parabolica');
  assert.ok(firstVariant.start * LENGTH_M >= 500, 'Prima Variante must not brake within metres of the start');
  assert.ok(targetSpeed(firstVariant.start - 0.002) >= 345, 'Main straight must stay flat before the 150m board');
  assert.ok(targetSpeed(roggia.start - 0.002) >= 325, 'Roggia must not brake before the 100m board');
  assert.ok(targetSpeed(roggia.start + 0.004) < targetSpeed(roggia.start), 'Roggia must brake inside the braking zone');
  assert.ok(targetSpeed(ascari.apex) < targetSpeed(ascari.start), 'Ascari must brake after the Serraglio');
  assert.ok(targetSpeed(parabolica.apex) < targetSpeed(parabolica.start), 'Parabolica must brake after the back straight');
});

console.log('\nmonza.racingControls');

test('Prima Variante: 100% brake at the 150m board and trail braking toward apex', () => {
  const zone = BRAKING_ZONES.find(z => z.id === 'prima-variante');
  const hard = racingControls(zone.start + 0.001);
  const trail = racingControls(zone.apex);
  assert.equal(hard.brake, 1);
  assert.equal(hard.throttle, 0);
  assert.ok(trail.brake > 0 && trail.brake < 0.25, `trail brake=${trail.brake}`);
});

test('Curva Grande stays flat out with no braking', () => {
  const controls = racingControls(0.205);
  assert.equal(controls.brake, 0);
  assert.equal(controls.throttle, 1);
});

test('Parabolica reopens throttle before the end of the corner', () => {
  const ramp = racingControls(0.855);
  const exit = racingControls(0.886);
  assert.equal(ramp.brake, 0);
  assert.ok(ramp.throttle > 0.25 && ramp.throttle < 1, `ramp throttle=${ramp.throttle}`);
  assert.equal(exit.brake, 0);
  assert.equal(exit.throttle, 1);
});

console.log('\nphysics.updateSpeed');

test('target equals current: no change', () => {
  assert.equal(updateSpeed(200, 200, 0.25), 200);
});

test('dt zero: no change even with different target', () => {
  assert.equal(updateSpeed(100, 300, 0), 100);
});

test('acceleration capped by MAX_ACCEL_MS2', () => {
  // dt = 1 s, MAX_ACCEL = 8 m/s^2 = 28.8 km/h/s.
  // From 100 toward 300, in 1 s can add at most 28.8 km/h.
  const v = updateSpeed(100, 300, 1);
  assert.ok(Math.abs(v - 128.8) < 1e-9, `got=${v}`);
});

test('braking capped by MAX_BRAKE_MS2', () => {
  // dt = 1 s, MAX_BRAKE = 44 m/s^2 = 158.4 km/h/s.
  // From 300 toward 100, in 1 s can shed at most 158.4 km/h.
  const v = updateSpeed(300, 100, 1);
  assert.ok(Math.abs(v - 141.6) < 1e-9, `got=${v}`);
});

test('braking is faster than acceleration (different caps)', () => {
  assert.ok(MAX_BRAKE_MS2 > MAX_ACCEL_MS2);
  const accel = updateSpeed(100, 300, 0.5) - 100;
  const brake = 300 - updateSpeed(300, 100, 0.5);
  assert.ok(brake > accel, `brake=${brake} accel=${accel}`);
});

test('target reached when delta is within the tick limit', () => {
  // dt = 0.25 s -> max accel = 28.8 * 0.25 = 7.2 km/h.
  // From 200 toward 205: delta 5 < 7.2 -> reaches 205.
  assert.equal(updateSpeed(200, 205, 0.25), 205);
});

test('target reached under braking when delta is within the tick limit', () => {
  // dt = 0.25 s -> max brake = 158.4 * 0.25 = 39.6 km/h.
  // From 200 toward 190: delta -10, |delta| < 39.6 -> reaches 190.
  assert.equal(updateSpeed(200, 190, 0.25), 190);
});

test('negative current speed clamped to 0 before accelerating', () => {
  // From -10 toward 50, dt = 1 s: starts at 0, max accel 28.8 -> 28.8.
  const v = updateSpeed(-10, 50, 1);
  assert.ok(Math.abs(v - 28.8) < 1e-9, `got=${v}`);
});

test('negative target treated as 0 (brakes to a stop)', () => {
  // From 50 toward -100, dt = 1 s: target 0, brake max 158.4 -> reaches 0.
  const v = updateSpeed(50, -100, 1);
  assert.equal(v, 0);
});

test('integration 0 -> ~340 km/h takes ~12 s at full throttle', () => {
  // 340 km/h / (8 m/s^2 * 3.6 km/h/s/m/s^2) = 340 / 28.8 ≈ 11.81 s.
  let v = 0;
  let t = 0;
  const dt = 0.25;
  while (v < 340 && t < 30) {
    v = updateSpeed(v, 340, dt);
    t += dt;
  }
  assert.ok(t >= 11.5 && t <= 12.25, `time to 340 km/h: ${t}`);
  assert.ok(Math.abs(v - 340) < 1e-9, `v finale=${v}`);
});

test('braking integration 340 -> 95 km/h takes ~1.6 s', () => {
  // (340 - 95) / (44 * 3.6) = 245 / 158.4 ~= 1.55 s.
  let v = 340;
  let t = 0;
  const dt = 0.25;
  while (v > 95 && t < 10) {
    v = updateSpeed(v, 95, dt);
    t += dt;
  }
  assert.ok(t >= 1.5 && t <= 1.75, `time to 95 km/h: ${t}`);
  assert.ok(Math.abs(v - 95) < 1e-9, `v finale=${v}`);
});

test('complete Monza lap within realistic lap-time window', () => {
  // Integrates speed (toward targetSpeed) and position tick by tick.
  // The profile includes hold points on straights and short braking zones,
  // so pure target-following does not anticipate braking over the full
  // straight.
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
  assert.ok(t >= 80 && t <= 105, `lap time outside realistic range: ${t}s`);
});

console.log('\nphysics.gearForSpeed');

test('zero speed -> minimum gear (1)', () => {
  assert.equal(gearForSpeed(0), GEAR_MIN);
});

test('very low speed -> gear 1 (lower clamp)', () => {
  assert.equal(gearForSpeed(20), GEAR_MIN);
  assert.equal(gearForSpeed(40), GEAR_MIN);
});

test('rounding at mid-interval', () => {
  assert.equal(gearForSpeed(75), 2);
  assert.equal(gearForSpeed(125), 3);
});

test('typical Monza speeds', () => {
  assert.equal(gearForSpeed(95), 2);
  assert.equal(gearForSpeed(200), 4);
  assert.equal(gearForSpeed(290), 6);
  assert.equal(gearForSpeed(340), 7);
});

test('speed above top scale -> clamp to GEAR_MAX', () => {
  assert.equal(gearForSpeed(400), GEAR_MAX);
  assert.equal(gearForSpeed(1000), GEAR_MAX);
});

test('non-finite or negative input -> 1', () => {
  assert.equal(gearForSpeed(-50), GEAR_MIN);
  assert.equal(gearForSpeed(NaN), GEAR_MIN);
  assert.equal(gearForSpeed(undefined), GEAR_MIN);
});

console.log('\nphysics.rpmForSpeed');

test('idle: speed 0 -> RPM_IDLE', () => {
  assert.equal(rpmForSpeed(0), RPM_IDLE);
});

test('linear formula: rpm = 7000 + speed * 22 (no jitter)', () => {
  assert.equal(rpmForSpeed(100), RPM_IDLE + 100 * RPM_PER_KMH);
  assert.equal(rpmForSpeed(200), RPM_IDLE + 200 * RPM_PER_KMH);
  assert.equal(rpmForSpeed(340), RPM_IDLE + 340 * RPM_PER_KMH);
});

test('additive jitter, integer output', () => {
  assert.equal(rpmForSpeed(200, 50), RPM_IDLE + 200 * RPM_PER_KMH + 50);
  assert.equal(rpmForSpeed(200, -50), RPM_IDLE + 200 * RPM_PER_KMH - 50);
});

test('output always integer even with fractional jitter', () => {
  const v = rpmForSpeed(150, 12.7);
  assert.ok(Number.isInteger(v), `rpm not an integer: ${v}`);
});

test('rpm clamped below RPM_MAX even with high jitter', () => {
  // 7000 + 400*22 = 15800; jitter +500 -> 16300, must be clamped
  assert.equal(rpmForSpeed(400, 500), RPM_MAX);
});

test('rpm monotonically correlated with speed', () => {
  const speeds = [0, 50, 100, 150, 200, 250, 300, 340];
  for (let i = 1; i < speeds.length; i += 1) {
    assert.ok(
      rpmForSpeed(speeds[i]) > rpmForSpeed(speeds[i - 1]),
      `rpm not increasing between ${speeds[i - 1]} and ${speeds[i]}`
    );
  }
});

test('rpm respects telemetry schema limits [0, 16000]', () => {
  for (const v of [0, 100, 200, 300, 340, 400]) {
    const r = rpmForSpeed(v);
    assert.ok(r >= 0 && r <= RPM_MAX, `rpm ${r} out of range at speed ${v}`);
  }
});

console.log(`\n${passed} tests passed`);
