// Tyre thermal model and fuel consumption.
//
// Pure functions, no I/O and no mutations of inputs. Consistent with the
// rest of `simulator/src/car/` (see physics.js): the orchestrator passes the
// current state plus tick inputs and receives a new state.
//
// Tyre model (`updateTireTemp`):
//
//   dT/dt = heating - cooling
//   axle_heating = K_HEAT_SPEED * (speed/300)^2 * wearFactor
//                + K_HEAT_BRAKE    * brake     [front axle only]
//                + K_HEAT_THROTTLE * throttle  [rear axle only]
//   axle_cooling = K_COOL * (T - ambient)
//
// Tyres start at INITIAL_TIRE_TEMP_C (~95°C, already up to temperature after
// the formation lap) and converge asymptotically toward an equilibrium value
// that depends on driving style. Corner convention: front = (fl, fr)
// and rear = (rl, rr); left and right are treated symmetrically
// (lateral load model in corners is deferred to a later phase when
// Race Control lateral G is available).
//
// `wearFactor` (default 1) is a multiplier on the heating term that
// the orchestrator increments lap by lap to simulate progressive degradation
// (e.g. wearFactor = 1 + lap * WEAR_PER_LAP). For the same inputs, the tyre
// heats up more as the race progresses, but a normal stint must
// stay in the operating range: the FSM tire-overheat condition is a serious
// failure, not an inevitable event after a few laps.
//
// Fuel model (`consumeFuel`):
//
//   dFuel/dt = -( K_FUEL_BASE + K_FUEL_LOAD * (speed/300)^2 * throttle )
//
// Fuel decreases monotonically, clamped to 0. The `base` term models
// accessory consumption (pump, preload); the `load` term models engine
// power output as a function of speed and throttle position.
// Constants are calibrated so that at average speed (200 km/h, throttle 0.7)
// consumption is ~5 kg/lap at Monza (~110 s/lap). Without refuelling,
// the sprint tank must cover the entire 5-lap race with an operating margin,
// keeping fuel as a continuously decreasing telemetry signal.

const INITIAL_TIRE_TEMP_C = 95;
const INITIAL_FUEL_KG = 38;
const AMBIENT_C = 25;

const K_HEAT_SPEED = 6;
const K_HEAT_THROTTLE = 1.8;
const K_HEAT_BRAKE = 5;
const K_COOL = 0.08;

const K_FUEL_BASE = 0.01;
const K_FUEL_LOAD = 0.12;

const SPEED_REF_KMH = 300;

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function safeNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function initialTireTemp(value = INITIAL_TIRE_TEMP_C) {
  const t = safeNumber(value, INITIAL_TIRE_TEMP_C);
  return { fl: t, fr: t, rl: t, rr: t };
}

function speedLoad(speedKmh) {
  const v = Math.max(0, safeNumber(speedKmh, 0));
  const ratio = v / SPEED_REF_KMH;
  return ratio * ratio;
}

function updateTireTemp(prev, inputs, dt) {
  const safeDt = Math.max(0, safeNumber(dt, 0));
  const speedKmh = Math.max(0, safeNumber(inputs && inputs.speedKmh, 0));
  const throttle = clamp01(safeNumber(inputs && inputs.throttle, 0));
  const brake = clamp01(safeNumber(inputs && inputs.brake, 0));
  const ambient = safeNumber(inputs && inputs.ambientC, AMBIENT_C);
  const wearFactorRaw = safeNumber(inputs && inputs.wearFactor, 1);
  const wearFactor = wearFactorRaw < 0 ? 0 : wearFactorRaw;

  const baseHeat = K_HEAT_SPEED * speedLoad(speedKmh) * wearFactor;
  const frontHeat = baseHeat + K_HEAT_BRAKE * brake;
  const rearHeat = baseHeat + K_HEAT_THROTTLE * throttle;

  const stepFront = (axleTemp) => {
    const cooling = K_COOL * (axleTemp - ambient);
    return axleTemp + (frontHeat - cooling) * safeDt;
  };
  const stepRear = (axleTemp) => {
    const cooling = K_COOL * (axleTemp - ambient);
    return axleTemp + (rearHeat - cooling) * safeDt;
  };

  const safePrev = prev || initialTireTemp();

  return {
    fl: stepFront(safeNumber(safePrev.fl, INITIAL_TIRE_TEMP_C)),
    fr: stepFront(safeNumber(safePrev.fr, INITIAL_TIRE_TEMP_C)),
    rl: stepRear(safeNumber(safePrev.rl, INITIAL_TIRE_TEMP_C)),
    rr: stepRear(safeNumber(safePrev.rr, INITIAL_TIRE_TEMP_C)),
  };
}

function fuelRateKgPerS(speedKmh, throttle) {
  const v = Math.max(0, safeNumber(speedKmh, 0));
  const t = clamp01(safeNumber(throttle, 0));
  return K_FUEL_BASE + K_FUEL_LOAD * speedLoad(v) * t;
}

function consumeFuel(prevFuel, inputs, dt) {
  const safeDt = Math.max(0, safeNumber(dt, 0));
  const speedKmh = inputs && inputs.speedKmh;
  const throttle = inputs && inputs.throttle;
  const current = Math.max(0, safeNumber(prevFuel, INITIAL_FUEL_KG));
  const rate = fuelRateKgPerS(speedKmh, throttle);
  const next = current - rate * safeDt;
  return next < 0 ? 0 : next;
}

module.exports = {
  INITIAL_TIRE_TEMP_C,
  INITIAL_FUEL_KG,
  AMBIENT_C,
  K_HEAT_SPEED,
  K_HEAT_THROTTLE,
  K_HEAT_BRAKE,
  K_COOL,
  K_FUEL_BASE,
  K_FUEL_LOAD,
  SPEED_REF_KMH,
  initialTireTemp,
  updateTireTemp,
  fuelRateKgPerS,
  consumeFuel,
};
