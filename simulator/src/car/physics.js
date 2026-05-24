const { LENGTH_M } = require('../track/monza');

// Modello base di avanzamento lungo il circuito.
//
// `advance` (pure function): given the current position state
// (`trackPos`, `lap`), the speed in km/h and the `dt` interval in seconds,
// ritorna un nuovo oggetto con la posizione aggiornata. Quando `trackPos`
// raggiunge o supera 1 viene riavvolto a [0,1) e `lap` viene incrementato
// how many laps were completed in the tick (normally 0 or 1, but the
// code is defensive for very large `dt` values or anomalous speeds).
//
// `updateSpeed` (pure function): integrates speed toward a target speed
// target (tipicamente quella restituita da `track/monza.targetSpeed`)
// while respecting physical acceleration and braking limits. Speed
// reale non puo' saltare al target, segue il profilo. Le costanti sono
// quelle di §6.1 dell'architettura: +8 m/s^2 in accelerazione e una
// frenata di picco da F1, sufficiente a superare 4.5 G nelle staccate piu'
// violente. Tutti i valori in km/h, `dt` in secondi.
//
// Convenzioni:
// - `trackPos` resta sempre in [0,1) — l'estremo 1 e' escluso.
// - `lap` is a monotonic counter of completed laps. Its meaning
//   semantico (es. "lap 1 = primo giro in corso") e' a carico della FSM
//   nelle fasi successive: qui si modella solo la cinematica di base.
// - Negative speeds are not allowed by the data model (see telemetry
//   schema); if passed by mistake, they are clamped to zero for
//   safety.

const MAX_ACCEL_MS2 = 8;
const MAX_BRAKE_MS2 = 44;
const MS2_TO_KMH_PER_S = 3.6;

// Powertrain (cfr. docs/simulator-architecture.md §5.1):
//   gear = clamp(round(speed/50), 1, 7)
//   rpm  = 7000 + speed * 22, con jitter opzionale
// Nota: il modello e' una semplificazione lineare. In F1 reale l'rpm cala
// to gear shifts, not here - sufficient to give telemetry a value
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
