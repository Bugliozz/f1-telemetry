const assert = require('node:assert/strict');
const {
  COMPOUNDS,
  COMPOUND_IDS,
  buildCompounds,
  isCompound,
  randomCompound,
  pickDifferentCompound,
} = require('../src/car/compounds');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log('compounds.model');

test('declares the three dry compounds in order', () => {
  assert.deepEqual(COMPOUND_IDS, ['soft', 'medium', 'hard']);
  assert.equal(isCompound('soft'), true);
  assert.equal(isCompound('medium'), true);
  assert.equal(isCompound('hard'), true);
  assert.equal(isCompound('wet'), false);
});

test('derives wearPerLap from lifeLaps', () => {
  assert.equal(COMPOUNDS.soft.wearPerLap, 1 / COMPOUNDS.soft.lifeLaps);
  assert.equal(COMPOUNDS.medium.wearPerLap, 1 / COMPOUNDS.medium.lifeLaps);
  assert.equal(COMPOUNDS.hard.wearPerLap, 1 / COMPOUNDS.hard.lifeLaps);
  assert.ok(COMPOUNDS.soft.wearPerLap > COMPOUNDS.medium.wearPerLap);
  assert.ok(COMPOUNDS.medium.wearPerLap > COMPOUNDS.hard.wearPerLap);
});

test('buildCompounds applies configured lifeLaps safely', () => {
  const configured = buildCompounds({
    soft: { lifeLaps: 3.5 },
    medium: { lifeLaps: 5, color: 'yellow' },
    hard: { lifeLaps: 0 },
  });

  assert.equal(configured.soft.lifeLaps, 3.5);
  assert.equal(configured.soft.wearPerLap, 1 / 3.5);
  assert.equal(configured.medium.lifeLaps, 5);
  assert.equal(configured.medium.color, 'yellow');
  assert.equal(configured.hard.lifeLaps, COMPOUNDS.hard.lifeLaps);
});

test('randomCompound maps rng draws to valid starting compounds', () => {
  assert.equal(randomCompound(() => 0), 'soft');
  assert.equal(randomCompound(() => 0.34), 'medium');
  assert.equal(randomCompound(() => 0.99), 'hard');
  assert.equal(randomCompound(() => -1), 'soft');
  assert.equal(randomCompound(() => 1), 'hard');
});

test('pickDifferentCompound never returns the current compound', () => {
  for (const current of COMPOUND_IDS) {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.99]) {
      const next = pickDifferentCompound(current, () => draw);
      assert.equal(isCompound(next), true);
      assert.notEqual(next, current, `${current} -> ${next}`);
    }
  }
});

test('pickDifferentCompound tolerates an unknown current compound', () => {
  assert.equal(isCompound(pickDifferentCompound('unknown', () => 0.5)), true);
});

console.log(`\n${passed} tests passed`);
