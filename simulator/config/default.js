// Parametri di configurazione del simulatore.
//
// I valori possono essere sovrascritti da variabili d'ambiente (vedi §9.1
// dell'architettura). Qui si definiscono i default ragionevoli per una
// 5-lap Monza test race with 10 cars.

function intEnvInRange(name, fallback, min, max) {
  const value = parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const config = Object.freeze({

  // --- Rete ---
  mqttBroker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
  mongoUrl: process.env.MONGO_URL || null,
  mongoDb: process.env.MONGO_DB || 'f1_telemetry',
  raceId: parseInt(process.env.RACE_ID, 10) || 1,

  // --- Tick rate (fisica = publish) ---
  tickMs: intEnvInRange('TICK_MS', 250, 200, 500),  // 4 Hz default, clamp 2-5 Hz

  // --- Race ---
  totalLaps: parseInt(process.env.TOTAL_LAPS, 10) || 5,
  autoStart: process.env.AUTO_START === 'true',
  resetRaceOnStart: process.env.RESET_RACE_ON_START === 'true',

  // --- Determinismo ---
  seed: process.env.SEED ? parseInt(process.env.SEED, 10) : null,

  // --- Logging ---
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Physical thresholds (transition conditions, §7.1) ---
  lowFuelWarningThresholdKg: 8,
  tireServiceLap: 2,
  tireOverheatThresholdC: 180,
  tireOverheatTicksRequired: 3,
  engineFailureProbPerTick: 2e-6,
  faultGraceS: 60,
  faultDiagnoseS: 5,
  pitDurationMinS: 2.0,
  pitDurationMaxS: 3.5,

  // --- Tire degradation ---
  // wearFactor = 1 + lap * wearPerLap  →  a lap 15: 1.45
  wearPerLap: 0.03,

  // --- Pit lane ---
  pitEntryPos: 0.95,      // trackPos di ingresso pit-lane
  pitBoxPos: 0.985,       // estimated pit box trackPos in the pit lane
  pitExitPos: 0.04,       // trackPos di uscita pit-lane (giro successivo)
  pitLaneSpeedKmh: 80,    // pit-lane speed limit
  refuellingAllowed: false, // modern F1 pit stops are tire-service only
  tireResetTempC: 90,     // tire temperature after pit stop

  // --- Settori Monza ---
  sectors: [
    { id: 1, start: 0.000, end: 0.330, label: 'Prima Variante / Roggia' },
    { id: 2, start: 0.330, end: 0.660, label: 'Lesmo / Serraglio' },
    { id: 3, start: 0.660, end: 1.000, label: 'Ascari / Parabolica' },
  ],

  // --- DRS zones (rettilinei lunghi settore 1 e 3, §5.1) ---
  drsZones: [
    { start: 0.000, end: 0.089 },   // rettilineo start/finish fino alla staccata Rettifilo
    { start: 0.910, end: 1.000 },   // start/finish straight
  ],

  // --- Variabilita' e randomness ---
  // Jitter su RPM (±200 rpm random per tick)
  rpmJitterRange: 200,
  // Target speed jitter (±3 km/h per car, fixed per session)
  speedJitterKmh: 3,
  // Initial fuel jitter per car (±4 kg) -> effective range 18-26 kg
  initialFuelJitterKg: 4,
  // Tire temperature jitter (left/right asymmetry, ±1.5 C)
  tireTempJitterC: 1.5,
  // Jitter fuel rate (±5%)
  fuelRateJitterPct: 0.05,
  // Differenziale di prestazione per team (fattore moltiplicativo su target speed)
  // Simulates that some cars are intrinsically faster
  teamPerformanceFactor: {
    redbull: 1.012,
    ferrari: 1.008,
    mclaren: 1.004,
    mercedes: 1.00,
    alpine: 0.995,
  },
  maxRaceSpeedKmh: 350,

  // --- Race flag behaviour ---
  yellowSpeedMultiplier: 0.6,

  // --- Safety Car ---
  safetyCarSpeedKmh: 140,
  safetyCarCatchupSpeedKmh: 180,
  safetyCarTargetGapS: 0.5,
  safetyCarGapGainKmhPerS: 12,
  safetyCarCloseGapSlowdownKmhPerS: 60,
  safetyCarMinSpeedKmh: 60,

  // --- Virtual Safety Car ---
  virtualSafetyCarSpeedKmh: 120,
  virtualSafetyCarMinGapM: 5,

  // --- Race Control trigger (Fase 4) ---
  raceControlTriggers: {
    retirementScProbability: 0.40,   // SC probability for each retirement
    multiFaultVscThreshold: 2,       // N cars in FAULT -> VSC
    massIncidentThreshold: 3,        // N cars in FAULT+RETIRED -> RED FLAG
    scMinDurationS: 30,              // durata minima SC prima di clearance
    vscMinDurationS: 20,             // durata minima VSC prima di clearance
    yellowMinDurationS: 10,          // durata minima YELLOW prima di clearance
  },
});

module.exports = config;
