// Deterministic string hashing — see docs/simulator-architecture.md §10.1.
//
// Pure functions of their input (no global state, no seed of their own),
// used to derive stable per-key values (driver/team performance factors)
// that stay reproducible across runs without consuming a PRNG stream.

// FNV-1a (32-bit) followed by an avalanche mix, returned as an unsigned int.
function hashString(key) {
  const text = String(key == null ? '' : key);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

// Maps an arbitrary key to a stable float in [0, 1).
function stableUnitForKey(key) {
  return hashString(key) / 4294967296;
}

module.exports = { hashString, stableUnitForKey };
