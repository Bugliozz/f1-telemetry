const SCENARIOS = Object.freeze({
  RED_FLAG: 'red-flag',
  CHECKERED: 'checkered',
  BALANCED: 'balanced',
});

const PROFILES = Object.freeze({
  [SCENARIOS.RED_FLAG]: Object.freeze({
    id: SCENARIOS.RED_FLAG,
    label: 'Red flag probability bias',
    overrides: Object.freeze({
      engineFailureProbPerTick: 8e-4,
      tireOverheatThresholdC: 210,
      tireOverheatTicksRequired: 6,
      faultGraceS: 45,
      faultDiagnoseS: 5,
      raceControlTriggers: Object.freeze({
        retirementScProbability: 0.60,
        multiFaultVscThreshold: 2,
        massIncidentThreshold: 3,
      }),
    }),
    scheduledFaults: Object.freeze([]),
  }),
  [SCENARIOS.CHECKERED]: Object.freeze({
    id: SCENARIOS.CHECKERED,
    label: 'Checkered probability bias',
    overrides: Object.freeze({
      engineFailureProbPerTick: 1e-7,
      tireOverheatThresholdC: 240,
      raceControlTriggers: Object.freeze({
        retirementScProbability: 0.05,
        multiFaultVscThreshold: 3,
        massIncidentThreshold: 4,
      }),
    }),
    scheduledFaults: Object.freeze([]),
  }),
  [SCENARIOS.BALANCED]: Object.freeze({
    id: SCENARIOS.BALANCED,
    label: 'Balanced race distance',
    overrides: Object.freeze({
      engineFailureProbPerTick: 2e-7,
      tireOverheatThresholdC: 190,
      tireOverheatTicksRequired: 8,
      faultGraceS: 120,
      raceControlTriggers: Object.freeze({
        retirementScProbability: 0.15,
        multiFaultVscThreshold: 4,
        massIncidentThreshold: 8,
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
