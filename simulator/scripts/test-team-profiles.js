const assert = require('node:assert/strict');
const { buildTeamProfiles, DEFAULT_SPREAD } = require('../src/car/team-profiles');
const { stableUnitForKey } = require('../src/util/hash');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const ROSTER = [
  { teamId: 'ferrari', carId: 16 },
  { teamId: 'ferrari', carId: 44 },
  { teamId: 'mercedes', carId: 63 },
  { teamId: 'redbull', carId: 3 },
];

console.log('team-profiles');

test('stableUnitForKey is deterministic and in [0, 1)', () => {
  for (const key of ['ferrari', '16', '7:redbull', '']) {
    const value = stableUnitForKey(key);
    assert.ok(value >= 0 && value < 1, `${key} -> ${value}`);
    assert.equal(value, stableUnitForKey(key));
  }
  assert.notEqual(stableUnitForKey('ferrari'), stableUnitForKey('redbull'));
});

test('returns one frozen factor per distinct team', () => {
  const profiles = buildTeamProfiles(ROSTER, { seed: 42 });
  assert.deepEqual(Object.keys(profiles).sort(), ['ferrari', 'mercedes', 'redbull']);
  assert.equal(Object.isFrozen(profiles), true);
});

test('a fixed seed reproduces the same factors', () => {
  const a = buildTeamProfiles(ROSTER, { seed: 7 });
  const b = buildTeamProfiles(ROSTER, { seed: 7 });
  assert.deepEqual(a, b);
});

test('different seeds reshuffle the grid (no intrinsic order)', () => {
  const a = buildTeamProfiles(ROSTER, { seed: 1 });
  const b = buildTeamProfiles(ROSTER, { seed: 2 });
  const changed = Object.keys(a).some((team) => a[team] !== b[team]);
  assert.ok(changed, 'expected at least one team factor to differ between seeds');
});

test('factors stay within 1 ± spread', () => {
  const spread = 0.05;
  const profiles = buildTeamProfiles(ROSTER, { seed: 99, spread });
  for (const [team, factor] of Object.entries(profiles)) {
    assert.ok(factor >= 1 - spread - 1e-9 && factor <= 1 + spread + 1e-9, `${team}=${factor}`);
  }
});

test('spread of 0 yields a neutral 1.0 for every team', () => {
  const profiles = buildTeamProfiles(ROSTER, { seed: 5, spread: 0 });
  for (const factor of Object.values(profiles)) assert.equal(factor, 1);
});

test('invalid spread falls back to the default band', () => {
  const profiles = buildTeamProfiles(ROSTER, { seed: 5, spread: -1 });
  for (const factor of Object.values(profiles)) {
    assert.ok(factor >= 1 - DEFAULT_SPREAD - 1e-9 && factor <= 1 + DEFAULT_SPREAD + 1e-9);
  }
});

test('overrides pin specific teams and leave the rest generated', () => {
  const profiles = buildTeamProfiles(ROSTER, {
    seed: 7,
    overrides: { ferrari: 1.5 },
  });
  assert.equal(profiles.ferrari, 1.5);
  assert.equal(profiles.mercedes, buildTeamProfiles(ROSTER, { seed: 7 }).mercedes);
});

test('seed = null draws from the provided rng', () => {
  let calls = 0;
  const rng = () => { calls += 1; return 0.5; };
  const profiles = buildTeamProfiles(ROSTER, { seed: null, spread: 0.04, rng });
  assert.equal(calls, 3); // one draw per distinct team
  for (const factor of Object.values(profiles)) assert.equal(factor, 1); // 0.5 -> midpoint
});

test('ignores malformed roster entries', () => {
  const profiles = buildTeamProfiles(
    [{ teamId: 'alpine', carId: 10 }, { carId: 11 }, null, { teamId: '' }],
    { seed: 3 },
  );
  assert.deepEqual(Object.keys(profiles), ['alpine']);
});

console.log(`\n${passed} tests passed`);
