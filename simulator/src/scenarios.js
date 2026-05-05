const SCENARIOS = Object.freeze({
  RED_FLAG: 'red-flag',
  BALANCED: 'balanced',
});

const PROFILES = Object.freeze({
  [SCENARIOS.RED_FLAG]: Object.freeze({
    id: SCENARIOS.RED_FLAG,
    label: 'Failure likely',
    overrides: Object.freeze({
      engineFailureProbPerTick: 0.0012,
      tireOverheatThresholdC: 142,
      tireOverheatTicksRequired: 8,
      faultGraceS: 300,
      faultDiagnoseS: 5,
      wearPerLap: 0.08,
      raceControlTriggers: Object.freeze({
        retirementScProbability: 0.35,
        multiFaultVscThreshold: 2,
        massIncidentThreshold: 3,
      }),
    }),
    scheduledFaults: Object.freeze([]),
  }),
  [SCENARIOS.BALANCED]: Object.freeze({
    id: SCENARIOS.BALANCED,
    label: 'Balanced race distance',
    overrides: Object.freeze({
      engineFailureProbPerTick: 1e-5,
      faultGraceS: 60,
      wearPerLap: 0.06,
      tireOverheatThresholdC: 138,
      tireOverheatTicksRequired: 8,
      raceControlTriggers: Object.freeze({
        retirementScProbability: 0.08,
        multiFaultVscThreshold: 3,
        massIncidentThreshold: 3,
      }),
    }),
    scheduledFaults: Object.freeze([]),
  }),
});

function normalizeScenarioId(value) {
  const id = String(value || '').trim().toLowerCase();
  return PROFILES[id] ? id : SCENARIOS.BALANCED;
}

function applyScenario(baseConfig, scenarioId) {
  const id = normalizeScenarioId(scenarioId);
  const profile = PROFILES[id];
  const overrides = profile.overrides || {};

  return Object.freeze({
    ...baseConfig,
    ...overrides,
    raceControlTriggers: {
      ...(baseConfig.raceControlTriggers || {}),
      ...(overrides.raceControlTriggers || {}),
    },
    scenario: {
      id: profile.id,
      label: profile.label,
      scheduledFaults: profile.scheduledFaults.map((fault) => ({ ...fault })),
    },
  });
}

module.exports = {
  SCENARIOS,
  applyScenario,
  normalizeScenarioId,
};
