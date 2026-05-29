// Seedable PRNG (xorshift32) — see docs/simulator-architecture.md §10.1.
//
// If `seed` is an integer, produces a deterministic sequence.
// If `seed` is null/undefined, falls back to `Math.random`.
//
// Each car receives its own instance seeded with `seed ^ carId`, so that
// the entire race is reproducible from a single seed.

function xorshift32(initialSeed) {
  let state = (initialSeed | 0) || 1; // avoid state 0 (fixed point)
  return function next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    // Convert to [0,1) — unsigned shift to avoid negatives
    return (state >>> 0) / 4294967296;
  };
}

function createPrng(seed) {
  if (seed == null) return Math.random;
  const safeSeed = typeof seed === 'number' && Number.isFinite(seed) ? (seed | 0) : 1;
  return xorshift32(safeSeed);
}

function createCarPrng(globalSeed, carId) {
  if (globalSeed == null) return Math.random;
  return createPrng(globalSeed ^ (carId | 0));
}

module.exports = { createPrng, createCarPrng };
