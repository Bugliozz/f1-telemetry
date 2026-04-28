// Parametri di configurazione del simulatore.
//
// I valori possono essere sovrascritti da variabili d'ambiente (vedi §9.1
// dell'architettura). Qui si definiscono i default ragionevoli per una
// gara di test di 15 giri a Monza con 10 auto.

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
  raceId: parseInt(process.env.RACE_ID, 10) || 1,

  // --- Tick rate (fisica = publish) ---
  tickMs: intEnvInRange('TICK_MS', 250, 200, 500),  // 4 Hz default, clamp 2-5 Hz

  // --- Gara ---
  totalLaps: parseInt(process.env.TOTAL_LAPS, 10) || 15,
  autoStart: process.env.AUTO_START === 'true',

  // --- Determinismo ---
  seed: process.env.SEED ? parseInt(process.env.SEED, 10) : null,

  // --- Logging ---
  logLevel: process.env.LOG_LEVEL || 'info',

  // --- Soglie fisiche (condizioni di transizione, §7.1) ---
  fuelPitThresholdKg: 8,
  tireOverheatThresholdC: 180,
  tireOverheatTicksRequired: 3,
  engineFailureProbPerTick: 1e-4,
  faultDiagnoseS: 5,
  pitDurationMinS: 2.0,
  pitDurationMaxS: 3.5,

  // --- Degrado gomme ---
  // wearFactor = 1 + lap * wearPerLap  →  a lap 15: 1.45
  wearPerLap: 0.03,

  // --- Pit lane ---
  pitEntryPos: 0.95,      // trackPos di ingresso pit-lane
  pitBoxPos: 0.985,       // trackPos stimata del box nella pit-lane
  pitExitPos: 0.04,       // trackPos di uscita pit-lane (giro successivo)
  pitLaneSpeedKmh: 80,    // velocita' pit-lane limit
  fuelAddedOnPit: 50,     // kg riforniti a ogni pit
  tireResetTempC: 90,     // temperatura gomme dopo pit-stop

  // --- Settori Monza ---
  sectors: [
    { id: 1, start: 0.000, end: 0.330 },
    { id: 2, start: 0.330, end: 0.660 },
    { id: 3, start: 0.660, end: 1.000 },
  ],

  // --- DRS zones (rettilinei lunghi settore 1 e 3, §5.1) ---
  drsZones: [
    { start: 0.000, end: 0.055 },   // rettilineo start/finish
    { start: 0.910, end: 1.000 },   // rettilineo arrivo
  ],

  // --- Variabilita' e randomness ---
  // Jitter su RPM (±200 rpm random per tick)
  rpmJitterRange: 200,
  // Jitter su velocita' target (±3 km/h per auto, fisso per sessione)
  speedJitterKmh: 3,
  // Jitter temperatura gomme (asimmetria left/right, ±1.5 C)
  tireTempJitterC: 1.5,
  // Jitter fuel rate (±5%)
  fuelRateJitterPct: 0.05,
  // Differenziale di prestazione per team (fattore moltiplicativo su target speed)
  // Simula che alcune auto siano intrinsecamente piu' veloci
  teamPerformanceFactor: {
    redbull: 1.02,
    ferrari: 1.01,
    mclaren: 1.005,
    mercedes: 1.00,
    alpine: 0.99,
  },

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
    retirementScProbability: 0.40,   // prob. SC per ogni ritiro
    multiFaultVscThreshold: 2,       // N auto in FAULT → VSC
    massIncidentThreshold: 3,        // N auto FAULT+RETIRED → RED FLAG
    scMinDurationS: 30,              // durata minima SC prima di clearance
    vscMinDurationS: 20,             // durata minima VSC prima di clearance
    yellowMinDurationS: 10,          // durata minima YELLOW prima di clearance
  },
});

module.exports = config;
