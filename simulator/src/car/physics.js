const { LENGTH_M } = require('../track/monza');

// Base circuit advancement model.
//
// `advance` (pure function): given the current position state
// (`trackPos`, `lap`), speed in km/h and interval `dt` in seconds,
// returns a new object with the updated position. When `trackPos`
// reaches or exceeds 1 it is wrapped back to [0,1) and `lap` is incremented
// by the number of laps completed in the tick (normally 0 or 1, but the
// code is defensive for very large `dt` values or anomalous speeds).
//
// `updateSpeed` (pure function): integrates speed toward a target speed
// (typically returned by `track/monza.targetSpeed`) respecting the
// physical limits of acceleration and braking. The actual speed cannot
// jump to the target; it follows the profile. Constants are those of §6.1
// of the architecture: +8 m/s^2 acceleration and a peak F1 braking force
// sufficient to exceed 4.5 G at the hardest braking points.
// All values in km/h, `dt` in seconds.
//
// Conventions:
// - `trackPos` always stays in [0,1) — the upper bound 1 is excluded.
// - `lap` is a monotonic counter of completed laps. Its semantic meaning
//   (e.g. "lap 1 = first lap in progress") is the responsibility of the FSM
//   in later stages: only basic kinematics are modelled here.
// - Negative speeds are not allowed by the data model (see telemetry
//   schema); if passed by mistake, they are clamped to zero for safety.

const MAX_ACCEL_MS2 = 8;
const MAX_BRAKE_MS2 = 44;
const MS2_TO_KMH_PER_S = 3.6;

// Powertrain (see docs/simulator-architecture.md §5.1):
//   gear = clamp(round(speed/50), 1, 7)
//   rpm  = 7000 + speed * 22, with optional jitter
// Note: the model is a linear simplification. In real F1 rpm drops during
// gear changes, not here — sufficient to give telemetry a value
// consistent with speed without requiring a separate engine state.

const GEAR_KMH_PER_GEAR = 50;
const GEAR_MIN = 1;
const GEAR_MAX = 7;

const RPM_IDLE = 7000;
const RPM_PER_KMH = 22;
const RPM_MIN = 0;
const RPM_MAX = 16000;

function advance(positionState, speedKmh, dt) {
  const safeSpeed = Math.max(0, speedKmh);
  const safeDt = Math.max(0, dt);

  const distanceM = (safeSpeed / 3.6) * safeDt;
  const deltaPos = distanceM / LENGTH_M;

  let trackPos = positionState.trackPos + deltaPos;
  let lap = positionState.lap;
  let lapsCompleted = 0;

  while (trackPos >= 1) {
    trackPos -= 1;
    lap += 1;
    lapsCompleted += 1;
  }

  return { trackPos, lap, lapsCompleted };
}

function updateSpeed(currentKmh, targetKmh, dt) {
  const safeCurrent = Math.max(0, currentKmh);
  const safeTarget = Math.max(0, targetKmh);
  const safeDt = Math.max(0, dt);

  const maxAccelKmh = MAX_ACCEL_MS2 * MS2_TO_KMH_PER_S * safeDt;
  const maxBrakeKmh = MAX_BRAKE_MS2 * MS2_TO_KMH_PER_S * safeDt;

  const delta = safeTarget - safeCurrent;
  if (delta >= 0) {
    return safeCurrent + Math.min(delta, maxAccelKmh);
  }
  return safeCurrent + Math.max(delta, -maxBrakeKmh);
}

function gearForSpeed(speedKmh) {
  const safeSpeed = Math.max(0, Number.isFinite(speedKmh) ? speedKmh : 0);
  const raw = Math.round(safeSpeed / GEAR_KMH_PER_GEAR);
  if (raw < GEAR_MIN) return GEAR_MIN;
  if (raw > GEAR_MAX) return GEAR_MAX;
  return raw;
}

function rpmForSpeed(speedKmh, jitter = 0) {
  const safeSpeed = Math.max(0, Number.isFinite(speedKmh) ? speedKmh : 0);
  const safeJitter = Number.isFinite(jitter) ? jitter : 0;
  const raw = Math.round(RPM_IDLE + safeSpeed * RPM_PER_KMH + safeJitter);
  if (raw < RPM_MIN) return RPM_MIN;
  if (raw > RPM_MAX) return RPM_MAX;
  return raw;
}

module.exports = {
  advance,
  updateSpeed,
  gearForSpeed,
  rpmForSpeed,
  MAX_ACCEL_MS2,
  MAX_BRAKE_MS2,
  GEAR_KMH_PER_GEAR,
  GEAR_MIN,
  GEAR_MAX,
  RPM_IDLE,
  RPM_PER_KMH,
  RPM_MIN,
  RPM_MAX,
};
