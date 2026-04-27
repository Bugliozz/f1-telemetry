// Clock incapsulato (per test) — cfr. docs/simulator-architecture.md §3.
//
// In produzione usa Date.now() e process.hrtime.bigint() per high-resolution.
// Nei test si puo' iniettare un clock fittizio.

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
