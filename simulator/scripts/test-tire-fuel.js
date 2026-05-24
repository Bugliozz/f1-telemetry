const assert = require('node:assert/strict');
const {
  INITIAL_TIRE_TEMP_C,
  INITIAL_FUEL_KG,
  AMBIENT_C,
  K_HEAT_SPEED,
  K_HEAT_THROTTLE,
  K_HEAT_BRAKE,
  K_COOL,
  K_FUEL_BASE,
  K_FUEL_LOAD,
  SPEED_REF_KMH,
  initialTireTemp,
  updateTireTemp,
  fuelRateKgPerS,
  consumeFuel,
} = require('../src/car/tire-fuel');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('tire-fuel.initialTireTemp');

test('default: 95 C su tutte e 4 le ruote', () => {
  const t = initialTireTemp();
  assert.equal(t.fl, INITIAL_TIRE_TEMP_C);
  assert.equal(t.fr, INITIAL_TIRE_TEMP_C);
  assert.equal(t.rl, INITIAL_TIRE_TEMP_C);
  assert.equal(t.rr, INITIAL_TIRE_TEMP_C);
});

test('valore custom applicato a tutte e 4 le ruote', () => {
  const t = initialTireTemp(80);
  assert.equal(t.fl, 80);
  assert.equal(t.fr, 80);
  assert.equal(t.rl, 80);
  assert.equal(t.rr, 80);
});

console.log('\ntire-fuel.updateTireTemp');

test('dt zero: no change', () => {
  const prev = initialTireTemp(110);
  const out = updateTireTemp(prev, { speedKmh: 250, throttle: 1 }, 0);
  assert.equal(out.fl, 110);
  assert.equal(out.fr, 110);
  assert.equal(out.rl, 110);
  assert.equal(out.rr, 110);
});

test('immutability: input not modified', () => {
  const prev = { fl: 100, fr: 100, rl: 100, rr: 100 };
  updateTireTemp(prev, { speedKmh: 250, throttle: 0.7, brake: 0 }, 1);
  assert.equal(prev.fl, 100);
  assert.equal(prev.fr, 100);
  assert.equal(prev.rl, 100);
  assert.equal(prev.rr, 100);
});

test('zero speed without pedals: cooling toward ambient', () => {
  const prev = initialTireTemp(150);
  const out = updateTireTemp(prev, { speedKmh: 0, throttle: 0, brake: 0 }, 1);
  // dT = -K_COOL * (T - ambient) * dt = -0.1 * 125 * 1 = -12.5
  const expected = 150 - K_COOL * (150 - AMBIENT_C) * 1;
  assert.ok(Math.abs(out.fl - expected) < 1e-9, `fl=${out.fl} expected=${expected}`);
  assert.ok(Math.abs(out.rr - expected) < 1e-9, `rr=${out.rr} expected=${expected}`);
});

test('high speed heats tires: T increases vs. previous tick', () => {
  const prev = initialTireTemp(95);
  const out = updateTireTemp(prev, { speedKmh: 300, throttle: 0.8, brake: 0 }, 0.25);
  // Heat rear = K_HEAT_SPEED + K_HEAT_THROTTLE * 0.8 = 12 + 2 = 14
  // Cool = K_COOL * (95 - 25) = 7
  // dT_rear/dt = 9.8; dt=0.25 -> +2.45
  assert.ok(out.rl > prev.rl, `rl=${out.rl} did not increase`);
  assert.ok(out.rr > prev.rr, `rr=${out.rr} did not increase`);
});

test('rear axle heats more than front at equal throttle, brake=0', () => {
  const prev = initialTireTemp(95);
  const out = updateTireTemp(prev, { speedKmh: 280, throttle: 1, brake: 0 }, 1);
  assert.ok(out.rl > out.fl, `rl=${out.rl} fl=${out.fl}`);
  assert.ok(out.rr > out.fr, `rr=${out.rr} fr=${out.fr}`);
});

test('front axle heats more than rear at equal brake, throttle=0', () => {
  const prev = initialTireTemp(95);
  const out = updateTireTemp(prev, { speedKmh: 100, throttle: 0, brake: 1 }, 1);
  assert.ok(out.fl > out.rl, `fl=${out.fl} rl=${out.rl}`);
  assert.ok(out.fr > out.rr, `fr=${out.fr} rr=${out.rr}`);
});

test('left/right symmetric per axle (no cornering direction modelled)', () => {
  const prev = initialTireTemp(95);
  const out = updateTireTemp(prev, { speedKmh: 200, throttle: 0.5, brake: 0.2 }, 1);
  assert.equal(out.fl, out.fr);
  assert.equal(out.rl, out.rr);
});

test('integrazione lunga a regime: converge verso equilibrio finito', () => {
  // Speed 250, throttle 0.7, brake 0 costanti -> equilibrio analitico:
  // heat_rear = 12*(250/300)^2 + 2.5*0.7 = 8.333 + 1.75 = 10.083
  // T_eq_rear = ambient + heat/K_COOL = 25 + 100.83 = 125.83
  let temps = initialTireTemp(95);
  const dt = 0.25;
  for (let i = 0; i < 600; i += 1) {
    temps = updateTireTemp(temps, { speedKmh: 250, throttle: 0.7, brake: 0 }, dt);
  }
  const heatRear = K_HEAT_SPEED * (250 / SPEED_REF_KMH) ** 2 + K_HEAT_THROTTLE * 0.7;
  const eqRear = AMBIENT_C + heatRear / K_COOL;
  assert.ok(Math.abs(temps.rl - eqRear) < 0.5, `rl=${temps.rl} expected=${eqRear}`);
});

test('wearFactor amplifica il riscaldamento', () => {
  const prev = initialTireTemp(95);
  const baseline = updateTireTemp(prev, { speedKmh: 250, throttle: 0.5, brake: 0 }, 1);
  const worn = updateTireTemp(prev, {
    speedKmh: 250,
    throttle: 0.5,
    brake: 0,
    wearFactor: 2,
  }, 1);
  assert.ok(worn.rl > baseline.rl, `worn.rl=${worn.rl} baseline.rl=${baseline.rl}`);
  assert.ok(worn.fl > baseline.fl, `worn.fl=${worn.fl} baseline.fl=${baseline.fl}`);
});

test('wearFactor=0 disables the speed term (pedals and cooling only)', () => {
  const prev = initialTireTemp(120);
  const out = updateTireTemp(prev, {
    speedKmh: 300,
    throttle: 0,
    brake: 0,
    wearFactor: 0,
  }, 1);
  // Solo cooling: dT = -K_COOL * (120 - 25) = -9.5
  const expected = 120 - K_COOL * (120 - AMBIENT_C);
  assert.ok(Math.abs(out.rl - expected) < 1e-9);
});

test('input invalidi: speed/throttle/brake non finiti vengono trattati come 0', () => {
  const prev = initialTireTemp(120);
  const out = updateTireTemp(prev, {
    speedKmh: NaN,
    throttle: undefined,
    brake: null,
  }, 1);
  // Solo cooling: dT = -K_COOL * (120 - 25) = -9.5
  const expected = 120 - K_COOL * (120 - AMBIENT_C);
  assert.ok(Math.abs(out.rl - expected) < 1e-9, `rl=${out.rl} expected=${expected}`);
});

test('throttle/brake clampati a [0,1]', () => {
  const prev = initialTireTemp(95);
  const a = updateTireTemp(prev, { speedKmh: 200, throttle: 5, brake: 0 }, 1);
  const b = updateTireTemp(prev, { speedKmh: 200, throttle: 1, brake: 0 }, 1);
  assert.equal(a.rl, b.rl);
});

console.log('\ntire-fuel.fuelRateKgPerS');

test('idle: speed 0 throttle 0 -> rate base', () => {
  assert.ok(Math.abs(fuelRateKgPerS(0, 0) - K_FUEL_BASE) < 1e-12);
});

test('throttle 0 at any speed: base consumption only', () => {
  assert.ok(Math.abs(fuelRateKgPerS(300, 0) - K_FUEL_BASE) < 1e-12);
});

test('maximum rate at reference speed and full throttle', () => {
  const r = fuelRateKgPerS(SPEED_REF_KMH, 1);
  assert.ok(Math.abs(r - (K_FUEL_BASE + K_FUEL_LOAD)) < 1e-12);
});

test('monotonicity: rate increases with speed at full throttle', () => {
  const speeds = [50, 100, 150, 200, 250, 300];
  for (let i = 1; i < speeds.length; i += 1) {
    assert.ok(fuelRateKgPerS(speeds[i], 1) > fuelRateKgPerS(speeds[i - 1], 1));
  }
});

console.log('\ntire-fuel.consumeFuel');

test('dt zero: no consumption', () => {
  assert.equal(consumeFuel(105, { speedKmh: 300, throttle: 1 }, 0), 105);
});

test('monotone consumption', () => {
  let fuel = INITIAL_FUEL_KG;
  for (let i = 0; i < 100; i += 1) {
    const next = consumeFuel(fuel, { speedKmh: 250, throttle: 0.7 }, 1);
    assert.ok(next < fuel, `tick ${i}: ${next} >= ${fuel}`);
    fuel = next;
  }
});

test('mai sotto zero (clamp)', () => {
  // rate massimo = K_FUEL_BASE + K_FUEL_LOAD = 0.13 kg/s.
  // 1 kg di fuel residuo, dt=100 s -> consumo nominale 13 kg.
  const out = consumeFuel(1, { speedKmh: 300, throttle: 1 }, 100);
  assert.equal(out, 0);
});

test('negative or non-finite input treated as 0', () => {
  assert.equal(consumeFuel(-5, { speedKmh: 100, throttle: 0.5 }, 1), 0);
  assert.equal(consumeFuel(NaN, { speedKmh: 100, throttle: 0.5 }, 0), INITIAL_FUEL_KG);
});

test('immutability: no side effect on prevFuel', () => {
  // prevFuel is a primitive (number) — the real test is that inputs are not mutated.
  const inputs = { speedKmh: 250, throttle: 0.7 };
  consumeFuel(105, inputs, 1);
  assert.equal(inputs.speedKmh, 250);
  assert.equal(inputs.throttle, 0.7);
});

test('Monza lap ~110 s at average pace: ~5 kg/lap', () => {
  // Coarse profile: alternates straight and corner to approximate a lap.
  // Average speed ~220, average throttle ~0.6.
  let fuel = INITIAL_FUEL_KG;
  const dt = 0.25;
  const lapTimeS = 110;
  const ticks = lapTimeS / dt;
  for (let i = 0; i < ticks; i += 1) {
    fuel = consumeFuel(fuel, { speedKmh: 220, throttle: 0.6 }, dt);
  }
  const consumed = INITIAL_FUEL_KG - fuel;
  // Generous range: 3-7 kg/lap, target ~5.
  assert.ok(consumed > 3 && consumed < 7, `consumption per lap: ${consumed}`);
});

test('3-lap sprint: fuel remains positive with the no-refuelling race load', () => {
  let fuel = INITIAL_FUEL_KG;
  const dt = 0.25;
  const lapTimeS = 110;
  const ticks = (lapTimeS / dt) * 3;
  for (let i = 0; i < ticks; i += 1) {
    fuel = consumeFuel(fuel, { speedKmh: 220, throttle: 0.6 }, dt);
  }
  assert.ok(fuel > 0 && fuel < INITIAL_FUEL_KG, `fuel after 3 laps: ${fuel}`);
  assert.ok(fuel > 8, `expected fuel to stay above 8 kg after 3 laps (race load check): ${fuel}`);
});

test('stays within telemetry schema limits [0, 110]', () => {
  let fuel = INITIAL_FUEL_KG;
  const dt = 0.25;
  for (let i = 0; i < 10000; i += 1) {
    fuel = consumeFuel(fuel, { speedKmh: 300, throttle: 1 }, dt);
    assert.ok(fuel >= 0 && fuel <= 110, `fuel out of range: ${fuel}`);
  }
});

console.log('\ntire-fuel.consumeFuel — modello sprint');

test('initial fuel jitter still covers a 5-lap no-refuelling sprint', () => {
  const jitterKg = 2; // current delivery calibration: 36-40 kg range
  const finalFuels = [];

  for (let carIdx = 0; carIdx < 10; carIdx += 1) {
    const jitterFraction = (carIdx / 9) * 2 - 1;
    const initialFuel = INITIAL_FUEL_KG + jitterFraction * jitterKg;
    let fuel = initialFuel;
    const dt = 0.25;
    const lapTimeS = 110;

    for (let lap = 1; lap <= 5; lap += 1) {
      const ticks = lapTimeS / dt;
      for (let i = 0; i < ticks; i += 1) {
        fuel = consumeFuel(fuel, { speedKmh: 220, throttle: 0.6 }, dt);
      }
    }

    assert.ok(fuel > 0, `car ${carIdx} depleted fuel: ${fuel}`);
    assert.ok(fuel < initialFuel, `car ${carIdx} did not consume fuel: ${fuel}`);
    finalFuels.push(fuel);
  }

  const spread = Math.max(...finalFuels) - Math.min(...finalFuels);
  assert.ok(spread > 3.5 && spread < 4.5, `unexpected final fuel spread: ${spread}`);
});

console.log(`\n${passed} tests passed`);
