// Encapsulated clock (for testing) — see docs/simulator-architecture.md §3.
//
// In production uses Date.now() for the current time.
// In tests a fake clock can be injected.

function createClock() {
  return {
    nowMs() {
      return Date.now();
    },
    nowS() {
      return Date.now() / 1000;
    },
    isoNow() {
      return new Date().toISOString();
    },
  };
}

module.exports = { createClock };
