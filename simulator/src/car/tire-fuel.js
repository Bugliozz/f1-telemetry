// Modello termico delle gomme e consumo carburante.
//
// Funzioni pure, senza I/O e senza mutazione degli input. Coerenti con il
// resto di `simulator/src/car/` (cfr. physics.js): l'orchestrator passa lo
// stato corrente piu' gli input del tick e riceve un nuovo stato.
//
// Modello gomme (`updateTireTemp`):
//
//   dT/dt = heating - cooling
//   heating_axle = K_HEAT_SPEED * (speed/300)^2 * wearFactor
//                + K_HEAT_BRAKE    * brake     [solo asse anteriore]
//                + K_HEAT_THROTTLE * throttle  [solo asse posteriore]
//   cooling_axle = K_COOL * (T - ambient)
//
// Le gomme partono a INITIAL_TIRE_TEMP_C (~95°C, gia' in temperatura dopo
// il giro di formazione) e tendono asintoticamente a un valore di
// equilibrio dipendente dalla guida. Convenzione angoli: front = (fl, fr)
// e rear = (rl, rr); per la Fase 3 left e right sono trattati simmetrici
// (il modello di carico in curva left/right e' rinviato a Fase 4 con
// l'arrivo del lateralG da Race Control).
//
// `wearFactor` (default 1) e' un moltiplicatore del termine di riscaldamento
// che l'orchestrator alza giro dopo giro per simulare il degrado progressivo
// (es. wearFactor = 1 + lap * WEAR_PER_LAP). A parita' di input la gomma
// si scalda di piu' man mano che il giro avanza, ma uno stint normale deve
// restare nel range operativo: il tire-overheat FSM e' un guasto grave, non
// un evento inevitabile dopo pochi giri.
//
// Modello fuel (`consumeFuel`):
//
//   dFuel/dt = -( K_FUEL_BASE + K_FUEL_LOAD * (speed/300)^2 * throttle )
//
// Il carburante decresce monotonamente, clampato a 0. Il termine `base`
// modella consumi accessori (pompa, pre-load), il termine `load` la potenza
// erogata dal motore in funzione di velocita' e apertura acceleratore.
// Costanti scelte in modo che a regime medio (200 km/h, throttle 0.7) si
// consumino ~5 kg/giro a Monza (~110 s/giro), portando una partenza da
// 105 kg verso ~25-30 kg residui sui 15 giri di test.

const INITIAL_TIRE_TEMP_C = 95;
const INITIAL_FUEL_KG = 105;
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
