// Tire compound model.
//
// Pure definitions and helpers, without I/O and without input mutations.
// Consistent with the rest of `simulator/src/car/` (cfr. tire-fuel.js,
// physics.js).
//
// Three dry compounds following the F1 convention: softer compounds are
// faster but wear out sooner, harder ones last longer. Wear is modelled as a
// normalised accumulator in [0, 1] (0 = fresh, 1 = fully worn). `wearPerLap`
// is the nominal share of life consumed per lap, derived from `lifeLaps`
// (`wearPerLap = 1 / lifeLaps`): it is the per-compound degradation index,
// equal for every car running that compound. The per-car variance that
// staggers pit stops between cars on the same compound lives in the car
// orchestrator (see car.js), not here.
//
// Colours follow the official Pirelli code (soft = red, medium = yellow,
// hard = white) so the dashboard can render a color-coded badge.

const COMPOUND_DEFS = [
  { id: 'soft', color: 'red', lifeLaps: 2 },
  { id: 'medium', color: 'yellow', lifeLaps: 3 },
  { id: 'hard', color: 'white', lifeLaps: 4 },
];

// `lifeLaps` is the single source of truth; `wearPerLap` is derived so the two
// can never drift out of sync.
const COMPOUNDS = Object.freeze(
  COMPOUND_DEFS.reduce((acc, def) => {
    acc[def.id] = Object.freeze({ ...def, wearPerLap: 1 / def.lifeLaps });
    return acc;
  }, {}),
);

const COMPOUND_IDS = Object.freeze(COMPOUND_DEFS.map((def) => def.id));

function normaliseLifeLaps(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildCompounds(overrides = {}) {
  const config = overrides && typeof overrides === 'object' ? overrides : {};
  return Object.freeze(
    COMPOUND_DEFS.reduce((acc, def) => {
      const override = config[def.id] && typeof config[def.id] === 'object'
        ? config[def.id]
        : {};
      const lifeLaps = normaliseLifeLaps(override.lifeLaps, def.lifeLaps);
      const color = typeof override.color === 'string' && override.color
        ? override.color
        : def.color;
      acc[def.id] = Object.freeze({
        ...def,
        ...override,
        id: def.id,
        color,
        lifeLaps,
        wearPerLap: 1 / lifeLaps,
      });
      return acc;
    }, {}),
  );
}

function isCompound(id) {
  return Object.prototype.hasOwnProperty.call(COMPOUNDS, id);
}

// Maps an rng draw in [0, 1) to an index in [0, length). Tolerates a missing
// rng (falls back to Math.random) and out-of-range/NaN draws.
function pickIndex(rng, length) {
  const draw = typeof rng === 'function' ? rng() : Math.random();
  const safe = Number.isFinite(draw) ? draw : 0;
  const clamped = safe < 0 ? 0 : safe >= 1 ? 1 - 1e-9 : safe;
  return Math.floor(clamped * length);
}

// Random starting compound, uniform over the three dry compounds.
function randomCompound(rng) {
  return COMPOUND_IDS[pickIndex(rng, COMPOUND_IDS.length)];
}

// At a pit stop, mount one of the *other* two compounds (F1 rule: a stint must
// not reuse the compound just removed). If `current` is unknown, any compound
// is a valid candidate.
function pickDifferentCompound(current, rng) {
  const others = COMPOUND_IDS.filter((id) => id !== current);
  const pool = others.length > 0 ? others : COMPOUND_IDS;
  return pool[pickIndex(rng, pool.length)];
}

module.exports = {
  COMPOUNDS,
  COMPOUND_IDS,
  buildCompounds,
  isCompound,
  randomCompound,
  pickDifferentCompound,
};
