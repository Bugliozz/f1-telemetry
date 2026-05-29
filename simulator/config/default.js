// Simulator configuration parameters.
//
// Values can be overridden by environment variables. 
// Reasonable defaults are defined here for a
// 5-lap test race at Monza with 10 cars.

function intEnvInRange(name, fallback, min, max) {
  const value = parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const config = Object.freeze({

  // --- Network ---
  mqttBroker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
  mongoUrl: process.env.MONGO_URL || null,
  mongoDb: process.env.MONGO_DB || 'f1_telemetry',
  raceId: parseInt(process.env.RACE_ID, 10) || 1,

  // --- Tick rate (physics = publish) ---
  tickMs: intEnvInRange('TICK_MS', 250, 200, 500),  // 4 Hz default, clamp 2-5 Hz

  // --- Race ---
  totalLaps: parseInt(process.env.TOTAL_LAPS, 10) || 5,
  autoStart: process.env.AUTO_START === 'true',
  resetRaceOnStart: process.env.RESET_RACE_ON_START === 'true',

  // --- Determinism ---
  seed: process.env.SEED ? parseInt(process.env.SEED, 10) : null,

  // --- Logging ---
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Physical thresholds (transition conditions, §7.1) ---
  lowFuelWarningThresholdKg: 12,
  criticalFuelThresholdKg: 3,
  outOfFuelThresholdKg: 0.1,
  lowFuelSpeedMultiplier: 0.97,
  criticalFuelSpeedMultiplier: 0.85,
  tireOverheatThresholdC: 180,
  tireOverheatTicksRequired: 3,
  engineFailureProbPerTick: 2e-6,
  faultGraceS: 60,
  faultDiagnoseS: 5,
  pitDurationMinS: 2.0,
  pitDurationMaxS: 3.5,

  // --- Tire compounds and degradation ---
  // lifeLaps is the nominal tire life; car.js computes wearPerLap = 1 / lifeLaps
  // and applies per-car variance so that pit stops are naturally spread out.
  tireCompounds: {
    soft: { color: 'red', lifeLaps: 2 },
    medium: { color: 'yellow', lifeLaps: 3 },
    hard: { color: 'white', lifeLaps: 4 },
  },
  tireWearPitThreshold: 0.6,
  tireWearVariancePct: 0.15,
  tireWearThermalGain: 0.15,

  // --- Pit lane ---
  pitEntryPos: 0.95,      // trackPos at pit-lane entry
  pitBoxPos: 0.985,       // estimated pit box position in pit lane
  pitExitPos: 0.04,       // trackPos at pit-lane exit (next lap)
  pitLaneSpeedKmh: 80,    // pit-lane speed limit
  refuellingAllowed: false, // modern F1 pit stops are tyre changes only
  tireResetTempC: 90,     // tire temperature after pit stop

  // --- Monza sectors ---
  sectors: [
    { id: 1, start: 0.000, end: 0.330, label: 'Prima Variante / Roggia' },
    { id: 2, start: 0.330, end: 0.660, label: 'Lesmo / Serraglio' },
    { id: 3, start: 0.660, end: 1.000, label: 'Ascari / Parabolica' },
  ],

  // --- DRS zones (Monza: two zones, activated after detection point) ---
  // Zone 1: main straight, from Parabolica exit to Prima Variante braking point
  // Zone 2: Roggia–Lesmo straight, from Roggia exit to Lesmo 1 braking point
  drsZones: [
    { start: 0.000, end: 0.089 },   // main straight — first half (after start/finish)
    { start: 0.885, end: 1.000 },   // main straight — from Parabolica exit to the line
    { start: 0.340, end: 0.415 },   // Roggia → Lesmo 1 straight
  ],

  // --- Variability and randomness ---
  // RPM jitter (±200 rpm random per tick)
  rpmJitterRange: 200,
  // Target speed jitter (±3 km/h per car, fixed for the session)
  speedJitterKmh: 3,
  // Driver performance variance per carId (small fixed multiplier per car)
  driverPerformanceVariancePct: 0.006,
  // Initial fuel jitter per car (±2 kg) → effective range 36-40 kg
  initialFuelJitterKg: 2,
  // Tire temperature jitter (left/right asymmetry, ±1.5 C)
  tireTempJitterC: 1.5,
  // Fuel consumption jitter (±5%)
  fuelRateJitterPct: 0.05,
  // Team performance differential (multiplicative factor on target speed)
  // Simulates that some cars are intrinsically faster
  teamPerformanceFactor: {
    redbull: 1.030,
    ferrari: 1.018,
    mclaren: 1.008,
    mercedes: 0.995,
    alpine: 0.970,
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

  // --- Race Control triggers (Phase 4) ---
  raceControlTriggers: {
    retirementScProbability: 0,      // no automatic Safety Car in the 5-lap simulation
    multiFaultVscThreshold: 1,       // any car in FAULT on track → VSC
    massIncidentThreshold: 3,        // N cars in FAULT+RETIRED → RED FLAG
    scMinDurationS: 30,              // minimum SC duration before clearance
    vscMinDurationS: 20,             // minimum VSC duration before clearance
    yellowMinDurationS: 10,          // minimum YELLOW duration before clearance
  },
});

module.exports = config;
