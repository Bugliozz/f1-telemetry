const { LENGTH_M } = require('../track/monza');

// Modello base di avanzamento lungo il circuito.
//
// `advance` (funzione pura): dato lo stato di posizione corrente
// (`trackPos`, `lap`), la velocita' in km/h e l'intervallo `dt` in secondi,
// ritorna un nuovo oggetto con la posizione aggiornata. Quando `trackPos`
// raggiunge o supera 1 viene riavvolto a [0,1) e `lap` viene incrementato
// di quanti giri sono stati completati nel tick (di norma 0 o 1, ma il
// codice e' difensivo per `dt` molto grandi o velocita' anomale).
//
// `updateSpeed` (funzione pura): integra la velocita' verso una velocita'
// target (tipicamente quella restituita da `track/monza.targetSpeed`)
// rispettando i limiti fisici di accelerazione e frenata. La velocita'
// reale non puo' saltare al target, segue il profilo. Le costanti sono
// quelle di §6.1 dell'architettura: +8 m/s^2 in accelerazione, -25 m/s^2
// in frenata. Tutti i valori in km/h, `dt` in secondi.
//
// Convenzioni:
// - `trackPos` resta sempre in [0,1) — l'estremo 1 e' escluso.
// - `lap` e' un contatore monotono di giri completati. Il significato
//   semantico (es. "lap 1 = primo giro in corso") e' a carico della FSM
//   nelle fasi successive: qui si modella solo la cinematica di base.
// - Velocita' negative non sono ammesse dal data model (vedi schema
//   telemetry); se passate per errore vengono clamp-ate a zero per
//   sicurezza.

const MAX_ACCEL_MS2 = 8;
const MAX_BRAKE_MS2 = 25;
const MS2_TO_KMH_PER_S = 3.6;

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

module.exports = {
  advance,
  updateSpeed,
  MAX_ACCEL_MS2,
  MAX_BRAKE_MS2,
};
