// PRNG seedabile (xorshift32) — cfr. docs/simulator-architecture.md §10.1.
//
// Se `seed` e' un intero, produce una sequenza deterministica.
// Se `seed` e' null/undefined, wrappa `Math.random`.
//
// Ogni auto riceve la propria istanza seedata con `seed ^ carId`, in modo
// che la gara intera sia riproducibile da un singolo seed.

function xorshift32(initialSeed) {
  let state = (initialSeed | 0) || 1; // evita stato 0 (punto fisso)
  return function next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    // Converti a [0,1) — unsigned shift per evitare negativi
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
