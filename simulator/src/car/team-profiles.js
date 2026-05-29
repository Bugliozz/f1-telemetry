// Team performance profiles — generated once per race.
//
// Each team gets a single speed multiplier shared by both of its cars
// (per-driver variance is layered on top in car.js). Factors are produced
// within ±spread around 1.0:
//   - with a fixed seed: deterministic from (seed, teamId), so the same seed
//     always reproduces the same grid — but a different seed reshuffles the
//     pecking order (no team is intrinsically faster).
//   - with seed = null: drawn from `rng` (Math.random by default), i.e. a
//     fresh random grid each race, consistent with the rest of the simulator.
//
// An optional `overrides` map pins specific teams to a fixed factor, bypassing
// generation for those teamIds only.
//
// See docs/simulator-architecture.md §5 and §10.1.

const { stableUnitForKey } = require('../util/hash');

const DEFAULT_SPREAD = 0.03;

function normaliseSpread(spread) {
  return Number.isFinite(spread) && spread >= 0 ? spread : DEFAULT_SPREAD;
}

function uniqueTeamIds(roster) {
  const seen = new Set();
  const ids = [];
  for (const entry of Array.isArray(roster) ? roster : []) {
    const teamId = entry && entry.teamId;
    if (typeof teamId !== 'string' || teamId === '' || seen.has(teamId)) continue;
    seen.add(teamId);
    ids.push(teamId);
  }
  return ids;
}

// Builds a frozen { teamId: factor } map covering every distinct team in the
// roster. `options`: { seed, spread, overrides, rng }.
function buildTeamProfiles(roster, options = {}) {
  const seed = options.seed == null ? null : options.seed;
  const spread = normaliseSpread(options.spread);
  const overrides = options.overrides && typeof options.overrides === 'object' ? options.overrides : {};
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;

  const profiles = {};
  for (const teamId of uniqueTeamIds(roster)) {
    const override = overrides[teamId];
    if (Number.isFinite(override)) {
      profiles[teamId] = override;
      continue;
    }
    const unit = seed == null ? rng() : stableUnitForKey(`${seed}:${teamId}`);
    profiles[teamId] = 1 + (unit * 2 - 1) * spread;
  }
  return Object.freeze(profiles);
}

module.exports = { buildTeamProfiles, DEFAULT_SPREAD };
