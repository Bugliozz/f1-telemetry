// Lightweight logger with configurable levels — §3 of the architecture.
//
// Levels: debug < info < warn < error
// Set by the LOG_LEVEL environment variable (default: info).

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
