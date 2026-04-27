// Logger leggero con livelli configurabili — §3 dell'architettura.
//
// Livelli: debug < info < warn < error
// Impostato da env LOG_LEVEL (default: info).

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(level) {
  const threshold = LEVELS[level] != null ? LEVELS[level] : LEVELS.info;

  return {
    debug(...args) {
      if (threshold <= LEVELS.debug) console.log('[DEBUG]', ...args);
    },
    info(...args) {
      if (threshold <= LEVELS.info) console.log('[INFO]', ...args);
    },
    warn(...args) {
      if (threshold <= LEVELS.warn) console.warn('[WARN]', ...args);
    },
    error(...args) {
      if (threshold <= LEVELS.error) console.error('[ERROR]', ...args);
    },
  };
}

module.exports = { createLogger };
