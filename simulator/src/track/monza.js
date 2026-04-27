// Costanti e profilo del circuito di Monza (Autodromo Nazionale).
//
// `LENGTH_M` e' il riferimento fisico per convertire una distanza percorsa
// (metri) nell'avanzamento normalizzato `trackPos in [0,1)`.
//
// `SPEED_PROFILE` e' la lookup table dei punti chiave del giro (start/finish,
// chicane, curve, parabolica) con la velocita' target che un'auto in
// condizioni nominali dovrebbe tenere in quel punto. La sorgente dei valori
// e' §6.1 di docs/simulator-architecture.md. Tra due punti consecutivi
// `targetSpeed(trackPos)` interpola linearmente: e' un'approssimazione
// volutamente grezza ma sufficiente a produrre un giro che dura circa 80-95
// secondi e a far percepire chiaramente accelerazioni e frenate ai consumer
// della telemetria.
//
// Il profilo e' periodico: il punto `1.000` ha lo stesso valore di `0.000`,
// cosi' che `targetSpeed` non abbia discontinuita' al wrap del giro.

const LENGTH_M = 5793;

const SPEED_PROFILE = Object.freeze([
  Object.freeze({ pos: 0.000, kmh: 340 }), // Rettilineo Start/Finish
  Object.freeze({ pos: 0.060, kmh: 95 }),  // Variante del Rettifilo
  Object.freeze({ pos: 0.180, kmh: 290 }), // Curva Biassono (Curva Grande)
  Object.freeze({ pos: 0.300, kmh: 110 }), // Variante della Roggia
  Object.freeze({ pos: 0.420, kmh: 200 }), // Lesmo 1
  Object.freeze({ pos: 0.480, kmh: 215 }), // Lesmo 2
  Object.freeze({ pos: 0.660, kmh: 130 }), // Variante Ascari
  Object.freeze({ pos: 0.830, kmh: 230 }), // Parabolica
  Object.freeze({ pos: 0.940, kmh: 335 }), // Rettilineo d'arrivo
  Object.freeze({ pos: 1.000, kmh: 340 }), // = 0.000 (chiusura periodica)
]);

function normalizePos(trackPos) {
  if (!Number.isFinite(trackPos)) {
    return 0;
  }
  const wrapped = trackPos - Math.floor(trackPos);
  return wrapped >= 1 ? 0 : wrapped;
}

function targetSpeed(trackPos) {
  const p = normalizePos(trackPos);

  for (let i = 0; i < SPEED_PROFILE.length - 1; i += 1) {
    const a = SPEED_PROFILE[i];
    const b = SPEED_PROFILE[i + 1];
    if (p >= a.pos && p <= b.pos) {
      const span = b.pos - a.pos;
      const t = span === 0 ? 0 : (p - a.pos) / span;
      return a.kmh + t * (b.kmh - a.kmh);
    }
  }

  return SPEED_PROFILE[0].kmh;
}

module.exports = {
  LENGTH_M,
  SPEED_PROFILE,
  targetSpeed,
};
