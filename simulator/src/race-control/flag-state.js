// Flag State - state machine for race flags.
//
// Pure module, without I/O and without mutations. Manages transitions
// allowed between global flags and maintains the current Race
// Control (flag attiva, settore interessato, timestamp di attivazione).
//
// Flag supportate (da schemas/flag.schema.json):
//   GREEN, YELLOW, RED, CHECKERED, SC, VSC
//
// Transition rules (model F1 reality):
//
//   GREEN  → YELLOW, SC, VSC, RED, CHECKERED
//   YELLOW → GREEN, SC, VSC, RED
//   SC     → GREEN, RED
//   VSC    → GREEN, RED
//   RED    → GREEN  (restart)
//   CHECKERED -> (absorbing, no transition)
//
// La YELLOW e' l'unica flag che puo' avere un settore specifico (locale).
// Tutte le altre sono globali (sector = null).

const FLAGS = Object.freeze({
  GREEN:     'GREEN',
  YELLOW:    'YELLOW',
  RED:       'RED',
  CHECKERED: 'CHECKERED',
  SC:        'SC',
  VSC:       'VSC',
});

const FLAG_VALUES = Object.freeze(Object.values(FLAGS));

// Allowed transition matrix: from -> [to, to, ...]
const ALLOWED_TRANSITIONS = Object.freeze({
  [FLAGS.GREEN]:     [FLAGS.YELLOW, FLAGS.SC, FLAGS.VSC, FLAGS.RED, FLAGS.CHECKERED],
  [FLAGS.YELLOW]:    [FLAGS.GREEN, FLAGS.SC, FLAGS.VSC, FLAGS.RED, FLAGS.CHECKERED],
  [FLAGS.SC]:        [FLAGS.GREEN, FLAGS.RED, FLAGS.CHECKERED],
  [FLAGS.VSC]:       [FLAGS.GREEN, FLAGS.RED, FLAGS.CHECKERED],
  [FLAGS.RED]:       [FLAGS.GREEN, FLAGS.CHECKERED],
  [FLAGS.CHECKERED]: [], // assorbente
});

function isValidFlag(flag) {
  return typeof flag === 'string' && FLAG_VALUES.includes(flag);
}

function isTerminalFlag(flag) {
  return flag === FLAGS.CHECKERED;
}

function canTransitionFlag(fromFlag, toFlag) {
  if (!isValidFlag(fromFlag) || !isValidFlag(toFlag)) return false;
  if (isTerminalFlag(fromFlag)) return false;
  const allowed = ALLOWED_TRANSITIONS[fromFlag];
  return Array.isArray(allowed) && allowed.includes(toFlag);
}

/**
 * Initial Race Control state.
 *
 * @returns {{ flag: string, sector: number|null, reason: string|null,
 *             activatedAtS: number|null, previousFlag: string|null }}
 */
function initialFlagState() {
  return {
    flag: FLAGS.GREEN,
    sector: null,
    reason: null,
    activatedAtS: null,
    previousFlag: null,
  };
}

/**
 * Attempts a flag transition.
 *
 * @param {object} current   - current state (from initialFlagState or previous changeFlag)
 * @param {string} newFlag   - la nuova flag da attivare
 * @param {object} opts      - { sector, reason, nowS }
 * @returns {{ ...flagState, changed: boolean }}
 */
function changeFlag(current, newFlag, opts = {}) {
  const cur = current && isValidFlag(current.flag) ? current : initialFlagState();
  const noChange = { ...cur, changed: false };

  if (!isValidFlag(newFlag)) return noChange;
  if (newFlag === cur.flag && newFlag !== FLAGS.YELLOW) return noChange;
  if (!canTransitionFlag(cur.flag, newFlag)) return noChange;

  // Solo YELLOW ammette settore specifico
  const sector = newFlag === FLAGS.YELLOW && opts.sector != null
    ? opts.sector
    : null;

  const reason = typeof opts.reason === 'string' && opts.reason.length > 0
    ? opts.reason
    : null;

  const nowS = typeof opts.nowS === 'number' && Number.isFinite(opts.nowS)
    ? opts.nowS
    : null;

  return {
    flag: newFlag,
    sector,
    reason,
    activatedAtS: nowS,
    previousFlag: cur.flag,
    changed: true,
  };
}

module.exports = {
  FLAGS,
  FLAG_VALUES,
  ALLOWED_TRANSITIONS,
  isValidFlag,
  isTerminalFlag,
  canTransitionFlag,
  initialFlagState,
  changeFlag,
};
