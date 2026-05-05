// Costanti e profilo del circuito di Monza (Autodromo Nazionale).
//
// Il profilo non descrive solo "quanto deve andare forte" l'auto in un
// punto: contiene anche le braking zone e la logica pedali di base. Questo
// evita un comportamento poco realistico in cui una semplice interpolazione
// lineare fa frenare l'auto sui rettilinei o non la fa frenare nel punto di
// staccata corretto.

const LENGTH_M = 5793;
const POS_PER_M = 1 / LENGTH_M;

function roundPos(pos) {
  return Math.round(pos * 1000000) / 1000000;
}

function metersBefore(pos, meters) {
  return roundPos(pos - meters * POS_PER_M);
}

const BRAKING_ZONES = Object.freeze([
  Object.freeze({
    id: 'prima-variante',
    label: 'Prima Variante',
    start: metersBefore(0.115, 150),
    hardEnd: 0.096,
    apex: 0.115,
    end: 0.145,
    peakBrake: 1.0,
    apexBrake: 0.16,
    throttleStart: 0.121,
    fullThrottle: 0.155,
  }),
  Object.freeze({
    id: 'roggia',
    label: 'Variante della Roggia',
    start: metersBefore(0.300, 100),
    hardEnd: 0.291,
    apex: 0.300,
    end: 0.335,
    peakBrake: 1.0,
    apexBrake: 0.18,
    throttleStart: 0.305,
    fullThrottle: 0.342,
  }),
  Object.freeze({
    id: 'lesmo-1',
    label: 'Lesmo 1',
    start: metersBefore(0.430, 50),
    hardEnd: 0.424,
    apex: 0.430,
    end: 0.445,
    peakBrake: 0.78,
    apexBrake: 0.10,
    throttleStart: 0.431,
    fullThrottle: 0.455,
  }),
  Object.freeze({
    id: 'lesmo-2',
    label: 'Lesmo 2',
    start: metersBefore(0.480, 50),
    hardEnd: 0.474,
    apex: 0.480,
    end: 0.520,
    peakBrake: 0.88,
    apexBrake: 0.12,
    throttleStart: 0.482,
    fullThrottle: 0.525,
  }),
  Object.freeze({
    id: 'ascari',
    label: 'Variante Ascari',
    start: metersBefore(0.660, 100),
    hardEnd: 0.652,
    apex: 0.660,
    end: 0.700,
    peakBrake: 1.0,
    apexBrake: 0.14,
    throttleStart: 0.666,
    fullThrottle: 0.705,
  }),
  Object.freeze({
    id: 'parabolica',
    label: 'Curva Alboreto / Parabolica',
    start: metersBefore(0.840, 100),
    hardEnd: 0.832,
    apex: 0.840,
    end: 0.890,
    peakBrake: 0.94,
    apexBrake: 0.08,
    throttleStart: 0.845,
    fullThrottle: 0.885,
  }),
]);

// Lookup table del giro. I punti di braking start mantengono la velocita' di
// arrivo, poi il target cala rapidamente fino all'apice. Tra una staccata e la
// successiva il profilo resta in accelerazione o in hold, cosi' il freno non
// viene generato sui rettilinei.
const SPEED_PROFILE = Object.freeze([
  Object.freeze({ pos: 0.000, kmh: 345 }), // Rettilineo Start/Finish
  Object.freeze({ pos: 0.050, kmh: 350 }), // DRS, pieno gas
  Object.freeze({ pos: BRAKING_ZONES[0].start, kmh: 350 }), // Cartello 150m
  Object.freeze({ pos: 0.096, kmh: 260 }),
  Object.freeze({ pos: 0.106, kmh: 135 }),
  Object.freeze({ pos: 0.115, kmh: 78 }),  // Apice Prima Variante
  Object.freeze({ pos: 0.145, kmh: 125 }), // Uscita Prima Variante
  Object.freeze({ pos: 0.175, kmh: 235 }),
  Object.freeze({ pos: 0.205, kmh: 305 }), // Curva Grande, pieno
  Object.freeze({ pos: 0.245, kmh: 325 }),
  Object.freeze({ pos: BRAKING_ZONES[1].start, kmh: 335 }), // Roggia 100m
  Object.freeze({ pos: 0.291, kmh: 235 }),
  Object.freeze({ pos: 0.296, kmh: 150 }),
  Object.freeze({ pos: 0.300, kmh: 115 }), // Apice Roggia
  Object.freeze({ pos: 0.335, kmh: 145 }),
  Object.freeze({ pos: 0.390, kmh: 265 }),
  Object.freeze({ pos: BRAKING_ZONES[2].start, kmh: 268 }), // Lesmo 1 50m
  Object.freeze({ pos: 0.430, kmh: 185 }), // Apice Lesmo 1
  Object.freeze({ pos: 0.445, kmh: 205 }),
  Object.freeze({ pos: BRAKING_ZONES[3].start, kmh: 260 }), // Lesmo 2 50m
  Object.freeze({ pos: 0.480, kmh: 165 }), // Apice Lesmo 2
  Object.freeze({ pos: 0.520, kmh: 195 }),
  Object.freeze({ pos: 0.589, kmh: 315 }), // Serraglio, pieno gas gia' stabilizzato
  Object.freeze({ pos: 0.625, kmh: 335 }), // Serraglio, pieno gas
  Object.freeze({ pos: BRAKING_ZONES[4].start, kmh: 338 }), // Ascari 100m
  Object.freeze({ pos: 0.652, kmh: 230 }),
  Object.freeze({ pos: 0.660, kmh: 160 }), // Ingresso Ascari
  Object.freeze({ pos: 0.700, kmh: 235 }),
  Object.freeze({ pos: 0.790, kmh: 335 }), // Rettilineo verso Parabolica
  Object.freeze({ pos: BRAKING_ZONES[5].start, kmh: 338 }), // Parabolica 100m
  Object.freeze({ pos: 0.832, kmh: 250 }),
  Object.freeze({ pos: 0.840, kmh: 185 }), // Apice Parabolica
  Object.freeze({ pos: 0.860, kmh: 245 }),
  Object.freeze({ pos: 0.880, kmh: 290 }), // Gas riaperto prima della fine
  Object.freeze({ pos: 0.940, kmh: 340 }),
  Object.freeze({ pos: 1.000, kmh: 345 }), // = 0.000 (chiusura periodica)
]);

function normalizePos(trackPos) {
  if (!Number.isFinite(trackPos)) {
    return 0;
  }
  const wrapped = trackPos - Math.floor(trackPos);
  return wrapped >= 1 ? 0 : wrapped;
}

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function targetSpeed(trackPos) {
  const p = normalizePos(trackPos);

  for (let i = 0; i < SPEED_PROFILE.length - 1; i += 1) {
    const a = SPEED_PROFILE[i];
    const b = SPEED_PROFILE[i + 1];
    if (p >= a.pos && p <= b.pos) {
      const span = b.pos - a.pos;
      const t = span === 0 ? 0 : (p - a.pos) / span;
      return lerp(a.kmh, b.kmh, t);
    }
  }

  return SPEED_PROFILE[0].kmh;
}

function brakePressureForZone(zone, p) {
  if (p < zone.start || p > zone.apex) return 0;
  if (p <= zone.hardEnd) return zone.peakBrake;

  const span = zone.apex - zone.hardEnd;
  const t = span <= 0 ? 1 : (p - zone.hardEnd) / span;
  return lerp(zone.peakBrake, zone.apexBrake, smoothstep(t));
}

function throttleForZone(zone, p) {
  if (p < zone.throttleStart || p > zone.fullThrottle) return null;

  const span = zone.fullThrottle - zone.throttleStart;
  const t = span <= 0 ? 1 : (p - zone.throttleStart) / span;
  return lerp(0.22, 1.0, smoothstep(t));
}

function racingControls(trackPos) {
  const p = normalizePos(trackPos);

  for (const zone of BRAKING_ZONES) {
    const brake = brakePressureForZone(zone, p);
    if (brake > 0) {
      return {
        throttle: 0,
        brake: clamp01(brake),
        zoneId: zone.id,
        phase: p <= zone.hardEnd ? 'hard-brake' : 'trail-brake',
      };
    }
  }

  for (const zone of BRAKING_ZONES) {
    const throttle = throttleForZone(zone, p);
    if (throttle != null) {
      return {
        throttle: clamp01(throttle),
        brake: 0,
        zoneId: zone.id,
        phase: throttle >= 0.999 ? 'full-throttle' : 'throttle-ramp',
      };
    }
  }

  return {
    throttle: 1,
    brake: 0,
    zoneId: null,
    phase: 'full-throttle',
  };
}

module.exports = {
  LENGTH_M,
  SPEED_PROFILE,
  BRAKING_ZONES,
  targetSpeed,
  racingControls,
};
