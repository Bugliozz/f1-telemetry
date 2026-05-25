(() => {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CIRCUIT_URL = 'assets/monza-circuit.svg';
    const WS_PATH = '/api/ws/f1';
    const DEFAULT_RACE_ID = 1;
    const RACE_TOTAL_LAPS = 5;
    // The SVG path is authored counter-clockwise and starts near Lesmo.
    // Telemetry trackPos starts on the start straight and increases clockwise.
    const TRACK_PATH_START_OFFSET = 0.390;

    // Smooth-movement tuning. We use an interpolation buffer based on the server's
    // timestamp to completely eliminate network jitter and velocity changes.
    // The playout delay is dynamically sized based on the snapshot interval.
    const ANIMATION_DEFAULT_DURATION = 500;
    const ANIMATION_MIN_DURATION = 100;
    const ANIMATION_MAX_DURATION = 1500;
    const ANIMATION_INTERVAL_EMA_ALPHA = 0.4;

    const TEAM_COLORS = Object.freeze({
        ferrari:  '#dc0000',
        mercedes: '#27f4d2',
        redbull:  '#1e41ff',
        mclaren:  '#ff8000',
        alpine:   '#0090ff'
    });
    const FALLBACK_COLOR = '#9ca3af';
    const COMPOUND_LABELS = Object.freeze({
        soft: 'Soft',
        medium: 'Medium',
        hard: 'Hard'
    });

    const STATE_CLASS = Object.freeze({
        PIT:      'car-marker--pit',
        FAULT:    'car-marker--fault',
        SUSPENDED: 'car-marker--suspended',
        RETIRED:  'car-marker--retired',
        FINISHED: 'car-marker--finished'
    });

    const FLAG_LABELS = Object.freeze({
        GREEN: 'Green Flag',
        YELLOW: 'Yellow Flag',
        RED: 'Red Flag',
        CHECKERED: 'Checkered Flag',
        SC: 'Safety Car',
        VSC: 'Virtual Safety Car'
    });
    const TRACK_SECTORS = Object.freeze([
        {
            id: 1,
            start: 0.000,
            end: 0.330,
            label: 'Sector 1',
            routeLabel: 'Prima Variante, Curva Biassono, Roggia',
            splitLabel: 'Roggia split'
        },
        {
            id: 2,
            start: 0.330,
            end: 0.660,
            label: 'Sector 2',
            routeLabel: 'Lesmo, Serraglio',
            splitLabel: 'Ascari entry split'
        },
        {
            id: 3,
            start: 0.660,
            end: 1.000,
            label: 'Sector 3',
            routeLabel: 'Ascari, Parabolica, finish straight',
            splitLabel: 'Finish line'
        }
    ]);
    const TRACK_LOCATIONS = Object.freeze([
        { start: 0.000, end: 0.089, label: 'Rettifilo principale' },
        { start: 0.089, end: 0.145, label: 'Prima Variante' },
        { start: 0.145, end: 0.235, label: 'Curva Biassono' },
        { start: 0.235, end: 0.330, label: 'Seconda Variante / Roggia' },
        { start: 0.330, end: 0.445, label: 'Lesmo 1' },
        { start: 0.445, end: 0.545, label: 'Lesmo 2' },
        { start: 0.545, end: 0.660, label: 'Serraglio' },
        { start: 0.660, end: 0.735, label: 'Variante Ascari' },
        { start: 0.735, end: 0.825, label: 'Rettilineo verso Parabolica' },
        { start: 0.825, end: 0.910, label: 'Curva Parabolica' },
        { start: 0.910, end: 1.000, label: 'Rettifilo finale' }
    ]);
    const TRACK_ANNOTATIONS = Object.freeze({
        labels: [
            { x: 176, y: 228, anchor: 'middle', lines: ['Prima Variante', '(Rettifilo)'] },
            { x: 18, y: 252, anchor: 'start', lines: ['Curva Biassono', '(Curva Grande)'] },
            { x: 50, y: 102, anchor: 'start', lines: ['Seconda Variante', '(Roggia)'] },
            { x: 48, y: 42, anchor: 'middle', lines: ['Curve di', 'Lesmo'] },
            { x: 148, y: 62, anchor: 'start', lines: ['Curva del', 'Serraglio'] },
            { x: 270, y: 168, anchor: 'middle', lines: ['Variante Ascari'] },
            { x: 488, y: 222, anchor: 'end', lines: ['Curva', 'Parabolica'] }
        ]
    });
    const MAX_EVENT_LOG_ITEMS = 80;
    const TELEMETRY_FIELDS = Object.freeze([
        'raceId',
        'teamId',
        'carId',
        'compound',
        'lap',
        'trackPos',
        'speed',
        'avgSpeedKmh',
        'rpm',
        'gear',
        'throttle',
        'brake',
        'drs',
        'fuel',
        'state',
        'previousState',
        'reason',
        'timestamp',
        'receivedAt'
    ]);

    const elements = {
        container: document.getElementById('circuit-container'),
        connection: document.getElementById('connection-status'),
        snapshot: document.getElementById('snapshot-info'),
        legend: document.getElementById('legend'),
        leaderboardBody: document.getElementById('leaderboard-body'),
        carStatesContainer: document.getElementById('car-states-container'),
        flagIndicator: document.getElementById('flag-indicator'),
        flagLabel: document.getElementById('flag-label'),
        flagMeta: document.getElementById('flag-meta'),
        flagEffects: document.getElementById('flag-effect-grid'),
        raceProgressLabel: document.getElementById('race-progress-label'),
        raceProgressPercent: document.getElementById('race-progress-percent'),
        raceProgressTrack: document.getElementById('race-progress-track'),
        raceProgressBar: document.getElementById('race-progress-bar'),
        eventLog: document.getElementById('race-event-log'),
        scenarioModal: document.getElementById('scenario-modal'),
        scenarioStatus: document.getElementById('scenario-status'),
        scenarioButtons: Array.from(document.querySelectorAll('[data-scenario]'))
    };

    const state = {
        svg: null,
        path: null,
        pathLength: 0,
        markersLayer: null,
        markers: new Map(), // carKey -> marker (see createMarker for shape)
        knownTeams: new Set(),
        lastSnapshotTime: 0,
        snapshotInterval: ANIMATION_DEFAULT_DURATION,
        timeOffset: null,
        socket: null,
        scenarioStarted: false,
        rafHandle: null,
        eventIds: new Set(),
        eventIdOrder: [],
        latestCars: new Map(),
        latestStandings: new Map(),
        raceFlags: new Map(),
        raceEffects: new Map(),
        telemetryPopup: null,
        telemetry: {
            visible: false,
            pinned: false,
            carKey: null,
            anchorKind: null,
            pointerX: 0,
            pointerY: 0
        }
    };

    function setConnectionStatus(label, kind) {
        elements.connection.textContent = label;
        elements.connection.className = 'status-pill status-pill--' + kind;
    }

    function setSnapshotInfo(text) {
        elements.snapshot.textContent = text;
    }

    function setScenarioStatus(text) {
        if (elements.scenarioStatus) elements.scenarioStatus.textContent = text;
    }

    function setScenarioControlsEnabled(enabled) {
        for (const button of elements.scenarioButtons) {
            button.disabled = !enabled;
        }
    }

    function hideScenarioModal() {
        if (!elements.scenarioModal) return;
        elements.scenarioModal.classList.add('scenario-modal--hidden');
    }

    function sendDashboardCommand(command) {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
        state.socket.send(JSON.stringify(command));
        return true;
    }

    function startScenario(scenario) {
        if (state.scenarioStarted) return;
        state.scenarioStarted = true;
        setScenarioControlsEnabled(false);
        setScenarioStatus('starting race...');
        const sent = sendDashboardCommand({
            type: 'start-scenario',
            raceId: DEFAULT_RACE_ID,
            scenario,
            timestamp: new Date().toISOString()
        });
        if (!sent) {
            state.scenarioStarted = false;
            setScenarioStatus('waiting for connection...');
            return;
        }
        window.setTimeout(hideScenarioModal, 220);
    }

    function bindScenarioButtons() {
        for (const button of elements.scenarioButtons) {
            button.addEventListener('click', () => startScenario(button.dataset.scenario));
        }
    }

    function teamColor(teamId) {
        return TEAM_COLORS[teamId] || FALLBACK_COLOR;
    }

    function carKey(car) {
        return car.raceId + ':' + car.carId;
    }

    function formatClock(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) return '--:--:--';
        return date.toLocaleTimeString([], { hour12: false });
    }

    function formatNumber(value, digits) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return n.toFixed(digits);
    }

    function humanizeToken(value) {
        return String(value || '')
            .replace(/[-_]+/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function flagLabel(flag) {
        return FLAG_LABELS[flag] || humanizeToken(flag);
    }

    function sectorLabel(sector) {
        if (sector == null || sector === '') return 'Sector ?';
        const id = Number(sector);
        const item = TRACK_SECTORS.find((candidate) => candidate.id === id);
        return item ? item.label : 'Sector ' + sector;
    }

    function sectorFullLabel(sector) {
        if (sector == null || sector === '') return 'Sector ?';
        const id = Number(sector);
        const item = TRACK_SECTORS.find((candidate) => candidate.id === id);
        if (!item) return 'Sector ' + sector;
        return item.label + ' - ' + item.routeLabel;
    }

    function sectorSplitLabel(sector) {
        if (sector == null || sector === '') return '';
        const id = Number(sector);
        const item = TRACK_SECTORS.find((candidate) => candidate.id === id);
        return item ? item.splitLabel : '';
    }

    function normalizedTrackPos(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        return ((n % 1) + 1) % 1;
    }

    function trackLocationAt(trackPos) {
        const pos = normalizedTrackPos(trackPos);
        if (pos == null) return '';
        const location = TRACK_LOCATIONS.find((item) => pos >= item.start && pos < item.end);
        return location ? location.label : 'Rettifilo finale';
    }

    function isFiniteNumber(value) {
        return Number.isFinite(Number(value));
    }

    function formatTelemetryNumber(value, digits, unit) {
        const text = formatNumber(value, digits);
        if (text == null) return '--';
        return unit ? text + ' ' + unit : text;
    }

    function formatInteger(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '--';
        return Math.round(n).toLocaleString();
    }

    function formatPercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '--';
        return Math.round(n * 100) + '%';
    }

    function formatTrackPercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '--';
        return Math.round(n * 1000) / 10 + '%';
    }

    function clamp01(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.max(0, Math.min(1, n));
    }

    function findLeaderCar(race, classification) {
        const cars = race && Array.isArray(race.cars) ? race.cars : [];
        if (cars.length === 0) return null;

        const standings = classification && Array.isArray(classification.standings)
            ? classification.standings
            : [];
        const leaderId = standings.length > 0 ? Number(standings[0].carId) : null;
        if (Number.isFinite(leaderId)) {
            const byClassification = cars.find((car) => Number(car.carId) === leaderId);
            if (byClassification) return byClassification;
        }

        return cars.reduce((leader, car) => {
            if (!leader) return car;
            const leaderProgress = (Number(leader.lap) || 0) + (Number(leader.trackPos) || 0);
            const carProgress = (Number(car.lap) || 0) + (Number(car.trackPos) || 0);
            return carProgress > leaderProgress ? car : leader;
        }, null);
    }

    function renderRaceProgress(race) {
        if (!elements.raceProgressLabel || !elements.raceProgressPercent || !elements.raceProgressBar) return;

        const classification = race && race.classification ? race.classification : null;
        const leaderCar = findLeaderCar(race, classification);
        const rawLeaderLap = classification && Number.isFinite(Number(classification.leaderLap))
            ? Number(classification.leaderLap)
            : (leaderCar && Number.isFinite(Number(leaderCar.lap)) ? Number(leaderCar.lap) : null);
        const leaderTrackPos = leaderCar && Number.isFinite(Number(leaderCar.trackPos))
            ? clamp01(leaderCar.trackPos)
            : 0;
        const progress = rawLeaderLap == null
            ? 0
            : clamp01((rawLeaderLap + leaderTrackPos) / RACE_TOTAL_LAPS);
        const percent = Math.round(progress * 100);
        const currentLap = rawLeaderLap == null
            ? '--'
            : Math.min(RACE_TOTAL_LAPS, Math.max(1, Math.floor(rawLeaderLap) + 1));

        elements.raceProgressLabel.textContent = 'Lap ' + currentLap + ' / ' + RACE_TOTAL_LAPS;
        elements.raceProgressPercent.textContent = percent + '%';
        elements.raceProgressBar.style.width = percent + '%';
        if (elements.raceProgressTrack) {
            elements.raceProgressTrack.setAttribute('aria-valuenow', String(percent));
        }
    }

    function toneForState(value) {
        const stateName = String(value || '').toUpperCase();
        if (stateName === 'FAULT' || stateName === 'RETIRED') return 'danger';
        if (stateName === 'PIT') return 'warn';
        if (stateName === 'SUSPENDED') return 'warn';
        if (stateName === 'INIT') return 'muted';
        return 'ok';
    }

    function normalizeCompound(value) {
        const id = String(value || '').toLowerCase();
        return COMPOUND_LABELS[id] ? id : null;
    }

    function createCompoundBadge(value, compact) {
        const compound = normalizeCompound(value);
        if (!compound) return null;

        const badge = document.createElement('span');
        badge.className = 'compound-badge compound-badge--' + compound;
        badge.textContent = compact ? compound.charAt(0).toUpperCase() : COMPOUND_LABELS[compound];
        badge.title = COMPOUND_LABELS[compound] + ' compound';
        return badge;
    }

    function addCompoundBadge(container, value, compact) {
        const badge = createCompoundBadge(value, compact);
        if (badge) container.appendChild(badge);
    }

    function raceKeyFromId(raceId) {
        return raceId == null ? null : String(raceId);
    }

    function rememberRaceControl(flagDoc, effects) {
        const key = raceKeyFromId(flagDoc && flagDoc.raceId);
        if (!key) return;
        if (flagDoc) state.raceFlags.set(key, flagDoc);
        if (effects) state.raceEffects.set(key, effects);
    }

    function isRaceSuspended(raceId) {
        const key = raceKeyFromId(raceId);
        if (!key) return false;
        const effects = state.raceEffects.get(key);
        if (effects && effects.raceSuspended === true) return true;
        const flag = state.raceFlags.get(key);
        return !!(flag && flag.active !== false && String(flag.flag || '').toUpperCase() === 'RED');
    }

    function rawCarState(car, standing) {
        return (car && car.state) || (standing && standing.state) || 'LIVE';
    }

    function displayCarState(car, standing) {
        const raw = rawCarState(car, standing);
        if (isRaceSuspended((car && car.raceId) || (standing && standing.raceId)) &&
            raw !== 'RETIRED' && raw !== 'FINISHED') {
            return 'SUSPENDED';
        }
        return raw;
    }

    function telemetrySensorsOff(car, standing) {
        const raw = rawCarState(car, standing);
        if (raw === 'RETIRED' || raw === 'FINISHED') return true;
        return isRaceSuspended((car && car.raceId) || (standing && standing.raceId));
    }

    function toneForSpeed(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 340) return 'danger';
        if (n >= 300) return 'warn';
        return 'ok';
    }

    function toneForRpm(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 14500) return 'danger';
        if (n >= 12500) return 'warn';
        return 'ok';
    }

    function toneForTireTemp(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 130 || n < 65) return 'danger';
        if (n >= 115 || n < 80) return 'warn';
        return 'ok';
    }

    function toneForFuel(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n <= 5) return 'danger';
        if (n <= 15) return 'warn';
        return 'ok';
    }

    function toneForThrottle(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 0.75) return 'ok';
        if (n >= 0.25) return 'warn';
        return 'danger';
    }

    function toneForBrake(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 0.7) return 'danger';
        if (n >= 0.25) return 'warn';
        return 'ok';
    }

    function toneForDrs(value) {
        if (value === true) return 'ok';
        if (value === false) return 'muted';
        return 'muted';
    }

    function toneForTireWear(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 'muted';
        if (n >= 0.75) return 'danger';
        if (n >= 0.50) return 'warn';
        return 'ok';
    }

    function mergeLatestCar(car) {
        if (!car || car.raceId == null || car.carId == null) return null;

        const key = carKey(car);
        const previous = state.latestCars.get(key) || {};
        const merged = { ...previous };
        for (const field of TELEMETRY_FIELDS) {
            if (car[field] != null) merged[field] = car[field];
        }
        if (typeof car.drs === 'boolean') merged.drs = car.drs;
        if (car.tireTemp && typeof car.tireTemp === 'object') {
            merged.tireTemp = {
                ...(previous.tireTemp || {}),
                ...car.tireTemp
            };
        }
        if (car.tireWear && typeof car.tireWear === 'object') {
            merged.tireWear = {
                ...(previous.tireWear || {}),
                ...car.tireWear
            };
        }
        state.latestCars.set(key, merged);
        return key;
    }

    function standingKey(classification, row) {
        if (!classification || classification.raceId == null || !row || row.carId == null) return null;
        return classification.raceId + ':' + row.carId;
    }

    function rememberStanding(classification, row) {
        const key = standingKey(classification, row);
        if (!key) return null;
        state.latestStandings.set(key, {
            ...row,
            raceId: classification.raceId,
            timestamp: classification.timestamp
        });
        return key;
    }

    function ensureTelemetryPopup() {
        if (state.telemetryPopup) return state.telemetryPopup;

        const popup = document.createElement('div');
        popup.className = 'telemetry-popup telemetry-popup--hidden';
        popup.setAttribute('role', 'status');
        document.body.appendChild(popup);
        state.telemetryPopup = popup;
        return popup;
    }

    function addTelemetryChip(container, text, tone) {
        if (!text) return;
        const chip = document.createElement('span');
        chip.className = 'telemetry-popup__chip telemetry-value--' + (tone || 'muted');
        chip.textContent = text;
        container.appendChild(chip);
    }

    function addTelemetryMetric(container, labelText, valueText, tone) {
        const item = document.createElement('div');
        item.className = 'telemetry-metric';

        const label = document.createElement('span');
        label.className = 'telemetry-metric__label';
        label.textContent = labelText;

        const value = document.createElement('span');
        value.className = 'telemetry-metric__value telemetry-value--' + (tone || 'muted');
        value.textContent = valueText || '--';

        item.appendChild(label);
        item.appendChild(value);
        container.appendChild(item);
    }

    function formatWearPercent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '--';
        return Math.round(n * 100) + '%';
    }

    function telemetryMetricRows(car, sensorsOff) {
        const labels = ['Speed', 'RPM', 'Gear', 'Throttle', 'Brake', 'DRS', 'Fuel', 'Track', 'Tyre FL', 'Tyre FR', 'Tyre RL', 'Tyre RR', 'Wear FL', 'Wear FR', 'Wear RL', 'Wear RR'];
        if (sensorsOff) {
            return labels.map((label) => ({ label, value: 'OFF', tone: 'muted' }));
        }

        const tireTemp = car && car.tireTemp && typeof car.tireTemp === 'object' ? car.tireTemp : {};
        const tireWear = car && car.tireWear && typeof car.tireWear === 'object' ? car.tireWear : {};
        return [
            { label: 'Speed', value: formatTelemetryNumber(car && car.speed, 1, 'km/h'), tone: toneForSpeed(car && car.speed) },
            { label: 'RPM', value: formatInteger(car && car.rpm), tone: toneForRpm(car && car.rpm) },
            { label: 'Gear', value: Number(car && car.gear) === 0 ? 'N' : formatInteger(car && car.gear), tone: isFiniteNumber(car && car.gear) ? 'ok' : 'muted' },
            { label: 'Throttle', value: formatPercent(car && car.throttle), tone: toneForThrottle(car && car.throttle) },
            { label: 'Brake', value: formatPercent(car && car.brake), tone: toneForBrake(car && car.brake) },
            { label: 'DRS', value: car && car.drs === true ? 'ON' : (car && car.drs === false ? 'OFF' : '--'), tone: toneForDrs(car && car.drs) },
            { label: 'Fuel', value: formatTelemetryNumber(car && car.fuel, 1, 'kg'), tone: toneForFuel(car && car.fuel) },
            { label: 'Track', value: formatTrackPercent(car && car.trackPos), tone: isFiniteNumber(car && car.trackPos) ? 'ok' : 'muted' },
            { label: 'Tyre FL', value: formatTelemetryNumber(tireTemp.fl, 1, 'C'), tone: toneForTireTemp(tireTemp.fl) },
            { label: 'Tyre FR', value: formatTelemetryNumber(tireTemp.fr, 1, 'C'), tone: toneForTireTemp(tireTemp.fr) },
            { label: 'Tyre RL', value: formatTelemetryNumber(tireTemp.rl, 1, 'C'), tone: toneForTireTemp(tireTemp.rl) },
            { label: 'Tyre RR', value: formatTelemetryNumber(tireTemp.rr, 1, 'C'), tone: toneForTireTemp(tireTemp.rr) },
            { label: 'Wear FL', value: formatWearPercent(tireWear.fl), tone: toneForTireWear(tireWear.fl) },
            { label: 'Wear FR', value: formatWearPercent(tireWear.fr), tone: toneForTireWear(tireWear.fr) },
            { label: 'Wear RL', value: formatWearPercent(tireWear.rl), tone: toneForTireWear(tireWear.rl) },
            { label: 'Wear RR', value: formatWearPercent(tireWear.rr), tone: toneForTireWear(tireWear.rr) }
        ];
    }

    function renderTelemetryPopupContent(carKeyValue) {
        const car = state.latestCars.get(carKeyValue) || {};
        const standing = state.latestStandings.get(carKeyValue) || {};
        const carId = car.carId != null ? car.carId : standing.carId;
        if (carId == null) return false;

        const popup = ensureTelemetryPopup();
        popup.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'telemetry-popup__head';

        const identity = document.createElement('div');
        identity.className = 'telemetry-popup__identity';

        const carLabel = document.createElement('div');
        carLabel.className = 'telemetry-popup__car';
        carLabel.textContent = '#' + carId;

        const team = document.createElement('div');
        team.className = 'telemetry-popup__team';
        team.textContent = car.teamId || standing.teamId || 'unknown';

        identity.appendChild(carLabel);
        identity.appendChild(team);
        head.appendChild(identity);

        const stateLabel = document.createElement('span');
        const visibleState = displayCarState(car, standing);
        stateLabel.className = 'telemetry-popup__state telemetry-value--' + toneForState(visibleState);
        stateLabel.textContent = visibleState;
        head.appendChild(stateLabel);
        popup.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'telemetry-popup__meta';
        if (standing.position != null) addTelemetryChip(meta, 'P' + standing.position, 'ok');
        addCompoundBadge(meta, car.compound || standing.compound, false);
        if (standing.gap != null) addTelemetryChip(meta, formatGap(Number(standing.gap), Number(standing.position)), standing.position === 1 ? 'ok' : 'warn');
        if (car.lap != null || standing.lap != null) addTelemetryChip(meta, 'Lap ' + (car.lap != null ? car.lap : standing.lap), 'muted');
        if (car.timestamp || standing.timestamp) addTelemetryChip(meta, formatClock(car.timestamp || standing.timestamp), 'muted');
        popup.appendChild(meta);

        const grid = document.createElement('div');
        grid.className = 'telemetry-popup__grid';
        for (const row of telemetryMetricRows(car, telemetrySensorsOff(car, standing))) {
            addTelemetryMetric(grid, row.label, row.value, row.tone);
        }
        popup.appendChild(grid);

        return true;
    }

    function findLeaderboardRow(carKeyValue) {
        if (!elements.leaderboardBody) return null;
        for (const row of elements.leaderboardBody.querySelectorAll('[data-car-key]')) {
            if (row.dataset.carKey === carKeyValue) return row;
        }
        return null;
    }

    function closestMarkerElement(target) {
        let node = target;
        while (node && node !== state.markersLayer) {
            if (node.classList && node.classList.contains('car-marker')) return node;
            node = node.parentNode;
        }
        return null;
    }

    function closestLeaderboardRow(target) {
        if (!target || !target.closest) return null;
        return target.closest('tr[data-car-key]');
    }

    function placeTelemetryPopup(x, y, preferLeft) {
        const popup = ensureTelemetryPopup();
        const margin = 8;
        const gap = 12;
        const rect = popup.getBoundingClientRect();
        let left = preferLeft ? x - rect.width - gap : x + gap;
        let top = y + gap;

        if (!preferLeft && left + rect.width > window.innerWidth - margin) {
            left = x - rect.width - gap;
        }
        if (preferLeft && left < margin) {
            left = x + gap;
        }
        if (left + rect.width > window.innerWidth - margin) {
            left = window.innerWidth - rect.width - margin;
        }
        if (left < margin) left = margin;

        if (top + rect.height > window.innerHeight - margin) {
            top = y - rect.height - gap;
        }
        if (top < margin) top = margin;

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';
    }

    function syncTelemetryPopupPosition() {
        if (!state.telemetry.visible) return;

        let x = state.telemetry.pointerX;
        let y = state.telemetry.pointerY;
        let preferLeft = false;

        if (state.telemetry.anchorKind === 'marker') {
            const marker = state.markers.get(state.telemetry.carKey);
            if (marker) {
                const rect = marker.group.getBoundingClientRect();
                x = rect.left + rect.width / 2;
                y = rect.top + rect.height / 2;
            }
        } else if (state.telemetry.anchorKind === 'leaderboard') {
            const row = findLeaderboardRow(state.telemetry.carKey);
            if (row) {
                const rect = row.getBoundingClientRect();
                x = rect.left;
                y = rect.top + rect.height / 2;
                preferLeft = true;
            }
        }

        placeTelemetryPopup(x, y, preferLeft);
    }

    function showTelemetryPopup(carKeyValue, anchorKind, event, pinned) {
        if (!carKeyValue) return;
        if (!pinned && state.telemetry.pinned) return;
        if (!renderTelemetryPopupContent(carKeyValue)) return;

        const popup = ensureTelemetryPopup();
        popup.className = 'telemetry-popup' + (pinned ? ' telemetry-popup--pinned' : '');
        state.telemetry.visible = true;
        state.telemetry.pinned = !!pinned;
        state.telemetry.carKey = carKeyValue;
        state.telemetry.anchorKind = anchorKind;
        if (event) {
            state.telemetry.pointerX = event.clientX;
            state.telemetry.pointerY = event.clientY;
        }
        syncTelemetryPopupPosition();
    }

    function refreshTelemetryPopup() {
        if (!state.telemetry.visible) return;
        if (!renderTelemetryPopupContent(state.telemetry.carKey)) {
            hideTelemetryPopup(true);
            return;
        }
        syncTelemetryPopupPosition();
    }

    function hideTelemetryPopup(force) {
        if (!force && state.telemetry.pinned) return;
        const popup = ensureTelemetryPopup();
        popup.className = 'telemetry-popup telemetry-popup--hidden';
        state.telemetry.visible = false;
        state.telemetry.pinned = false;
        state.telemetry.carKey = null;
        state.telemetry.anchorKind = null;
    }

    function togglePinnedTelemetry(carKeyValue, anchorKind, event) {
        if (state.telemetry.pinned && state.telemetry.carKey === carKeyValue) {
            hideTelemetryPopup(true);
            return;
        }
        showTelemetryPopup(carKeyValue, anchorKind, event, true);
    }

    function isActivationKey(event) {
        return event.key === 'Enter' || event.key === ' ';
    }

    function handleTelemetryHover(carKeyValue, anchorKind, event) {
        if (state.telemetry.pinned) return;
        showTelemetryPopup(carKeyValue, anchorKind, event, false);
    }

    function handleTelemetryMove(event) {
        if (!state.telemetry.visible || state.telemetry.pinned) return;
        state.telemetry.pointerX = event.clientX;
        state.telemetry.pointerY = event.clientY;
        syncTelemetryPopupPosition();
    }

    function bindTelemetryInteractions() {
        if (state.markersLayer) {
            state.markersLayer.addEventListener('pointerover', (event) => {
                const marker = closestMarkerElement(event.target);
                if (!marker || marker.contains(event.relatedTarget)) return;
                handleTelemetryHover(marker.dataset.carKey, 'marker', event);
            });
            state.markersLayer.addEventListener('pointermove', handleTelemetryMove);
            state.markersLayer.addEventListener('pointerout', (event) => {
                const marker = closestMarkerElement(event.target);
                if (!marker || marker.contains(event.relatedTarget)) return;
                if (state.telemetry.carKey === marker.dataset.carKey) hideTelemetryPopup(false);
            });
            state.markersLayer.addEventListener('click', (event) => {
                const marker = closestMarkerElement(event.target);
                if (!marker) return;
                event.stopPropagation();
                togglePinnedTelemetry(marker.dataset.carKey, 'marker', event);
            });
            state.markersLayer.addEventListener('focusin', (event) => {
                const marker = closestMarkerElement(event.target);
                if (!marker) return;
                handleTelemetryHover(marker.dataset.carKey, 'marker', event);
            });
            state.markersLayer.addEventListener('focusout', (event) => {
                const marker = closestMarkerElement(event.target);
                if (!marker || marker.contains(event.relatedTarget)) return;
                if (state.telemetry.carKey === marker.dataset.carKey) hideTelemetryPopup(false);
            });
            state.markersLayer.addEventListener('keydown', (event) => {
                if (!isActivationKey(event)) return;
                const marker = closestMarkerElement(event.target);
                if (!marker) return;
                event.preventDefault();
                event.stopPropagation();
                togglePinnedTelemetry(marker.dataset.carKey, 'marker', event);
            });
        }

        if (elements.leaderboardBody) {
            elements.leaderboardBody.addEventListener('pointerover', (event) => {
                const row = closestLeaderboardRow(event.target);
                if (!row || row.contains(event.relatedTarget)) return;
                handleTelemetryHover(row.dataset.carKey, 'leaderboard', event);
            });
            elements.leaderboardBody.addEventListener('pointermove', handleTelemetryMove);
            elements.leaderboardBody.addEventListener('pointerout', (event) => {
                const row = closestLeaderboardRow(event.target);
                if (!row || row.contains(event.relatedTarget)) return;
                if (state.telemetry.carKey === row.dataset.carKey) hideTelemetryPopup(false);
            });
            elements.leaderboardBody.addEventListener('click', (event) => {
                const row = closestLeaderboardRow(event.target);
                if (!row) return;
                event.stopPropagation();
                togglePinnedTelemetry(row.dataset.carKey, 'leaderboard', event);
            });
            elements.leaderboardBody.addEventListener('focusin', (event) => {
                const row = closestLeaderboardRow(event.target);
                if (!row) return;
                handleTelemetryHover(row.dataset.carKey, 'leaderboard', event);
            });
            elements.leaderboardBody.addEventListener('focusout', (event) => {
                const row = closestLeaderboardRow(event.target);
                if (!row || row.contains(event.relatedTarget)) return;
                if (state.telemetry.carKey === row.dataset.carKey) hideTelemetryPopup(false);
            });
            elements.leaderboardBody.addEventListener('keydown', (event) => {
                if (!isActivationKey(event)) return;
                const row = closestLeaderboardRow(event.target);
                if (!row) return;
                event.preventDefault();
                event.stopPropagation();
                togglePinnedTelemetry(row.dataset.carKey, 'leaderboard', event);
            });
        }

        document.addEventListener('click', () => hideTelemetryPopup(true));
        window.addEventListener('resize', refreshTelemetryPopup);
    }

    async function loadCircuit() {
        const response = await fetch(CIRCUIT_URL, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error('failed to load circuit svg: ' + response.status);
        }
        const text = await response.text();
        elements.container.innerHTML = text;

        const svg = elements.container.querySelector('svg');
        if (!svg) throw new Error('svg element not found in circuit asset');
        const path = svg.querySelector('path');
        if (!path) throw new Error('circuit path not found in svg');

        // Ensure the SVG scales responsively while keeping its aspect ratio.
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

        state.svg = svg;
        state.path = path;
        state.pathLength = path.getTotalLength();

        renderSectorOverlay();
        renderTrackAnnotations();

        const layer = document.createElementNS(SVG_NS, 'g');
        layer.setAttribute('id', 'car-markers');
        svg.appendChild(layer);
        state.markersLayer = layer;
    }

    function renderSectorOverlay() {
        const layer = document.createElementNS(SVG_NS, 'g');
        layer.setAttribute('class', 'sector-overlay');

        for (const sector of TRACK_SECTORS) {
            const line = document.createElementNS(SVG_NS, 'polyline');
            line.setAttribute('class', 'sector-overlay__line sector-overlay__line--s' + sector.id);
            line.setAttribute('points', sectorPolylinePoints(sector.start, sector.end));
            layer.appendChild(line);
        }

        state.svg.appendChild(layer);
    }

    function renderTrackAnnotations() {
        const layer = document.createElementNS(SVG_NS, 'g');
        layer.setAttribute('class', 'track-annotations');

        for (const item of TRACK_ANNOTATIONS.labels) {
            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('class', 'track-annotation__label');
            label.setAttribute('x', item.x);
            label.setAttribute('y', item.y);
            label.setAttribute('text-anchor', item.anchor || 'middle');
            label.setAttribute('aria-label', item.lines.join(' '));

            const firstDy = item.lines.length > 1 ? -4 : 0;
            for (let i = 0; i < item.lines.length; i += 1) {
                const tspan = document.createElementNS(SVG_NS, 'tspan');
                tspan.setAttribute('x', item.x);
                tspan.setAttribute('dy', String(i === 0 ? firstDy : 8));
                tspan.textContent = item.lines[i];
                label.appendChild(tspan);
            }
            layer.appendChild(label);
        }

        state.svg.appendChild(layer);
    }

    function sectorPolylinePoints(start, end) {
        const steps = 56;
        const points = [];
        for (let i = 0; i <= steps; i += 1) {
            const t = start + ((end - start) * i / steps);
            const point = pointForTrackPos(t);
            points.push(point.x + ',' + point.y);
        }
        return points.join(' ');
    }

    function createMarker(car) {
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'car-marker');
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', 'Car ' + car.carId + ' telemetry');
        group.dataset.carKey = carKey(car);

        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('class', 'car-marker__dot');
        dot.setAttribute('r', '7');
        dot.setAttribute('fill', teamColor(car.teamId));
        group.appendChild(dot);

        const label = document.createElementNS(SVG_NS, 'text');
        label.setAttribute('class', 'car-marker__label');
        label.textContent = String(car.carId);
        group.appendChild(label);

        state.markersLayer.appendChild(group);
        return {
            group,
            dot,
            label,
            teamId: car.teamId,
            history: []
        };
    }

    function clampTrackPos(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        // trackPos is normalized [0, 1) — wrap negatives, fold values >= 1.
        const wrapped = ((n % 1) + 1) % 1;
        return wrapped;
    }

    // Pick the representation of `target` closest to `prev` so a lap wrap
    // (e.g. 0.98 → 0.02) interpolates forward through the start/finish line
    // instead of sweeping backward across the whole track.
    function unwrapTarget(prev, target) {
        let t = target;
        while (t < prev - 0.5) t += 1;
        while (t > prev + 0.5) t -= 1;
        return t;
    }

    function visualPathProgressForTrackPos(trackPos) {
        const wrapped = clampTrackPos(trackPos);
        return clampTrackPos(TRACK_PATH_START_OFFSET - wrapped);
    }

    function pointForTrackPos(trackPos) {
        const progress = visualPathProgressForTrackPos(trackPos);
        return state.path.getPointAtLength(progress * state.pathLength);
    }

    function applyMarkerTransform(marker, pos) {
        const point = pointForTrackPos(pos);
        marker.group.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
    }

    function updateMarker(car, serverTimeMs) {
        const key = carKey(car);
        let marker = state.markers.get(key);
        const trackPos = clampTrackPos(car.trackPos);

        if (!marker) {
            marker = createMarker(car);
            state.markers.set(key, marker);
        }

        if (marker.teamId !== car.teamId) {
            marker.dot.setAttribute('fill', teamColor(car.teamId));
            marker.teamId = car.teamId;
        }

        const stateClasses = ['car-marker'];
        const stateClass = STATE_CLASS[displayCarState(car, null)];
        if (stateClass) stateClasses.push(stateClass);
        marker.group.setAttribute('class', stateClasses.join(' '));

        if (car.teamId && !state.knownTeams.has(car.teamId)) {
            state.knownTeams.add(car.teamId);
            renderLegend();
        }

        let pos = trackPos;
        const lastHistory = marker.history.length > 0 ? marker.history[marker.history.length - 1] : null;

        if (lastHistory) {
            // If we already have this exact timestamp (e.g. Node-RED polled twice before new telemetry), skip it
            if (lastHistory.time === serverTimeMs) return;
            pos = unwrapTarget(lastHistory.pos, trackPos);
        } else {
            applyMarkerTransform(marker, pos);
        }
        marker.history.push({ time: serverTimeMs, pos });
        if (marker.history.length > 10) marker.history.shift();
    }

    function tickAnimation() {
        const now = performance.now();
        if (state.timeOffset == null) {
            state.rafHandle = requestAnimationFrame(tickAnimation);
            return;
        }

        const playoutDelay = 500; // Fixed delay to prevent jitter
        const renderTime = now + state.timeOffset - playoutDelay;

        for (const marker of state.markers.values()) {
            const history = marker.history;
            if (history.length === 0) continue;

            if (history.length === 1 || renderTime <= history[0].time) {
                applyMarkerTransform(marker, history[0].pos);
                continue;
            }

            let i = history.length - 1;
            while (i > 0 && history[i].time > renderTime) {
                i--;
            }

            const p1 = history[i];
            const p2 = history[i + 1];

            if (p2) {
                const t = (renderTime - p1.time) / (p2.time - p1.time);
                const pos = p1.pos + (p2.pos - p1.pos) * t;
                applyMarkerTransform(marker, pos);
            } else {
                const p0 = history[i - 1];
                if (p0 && (p1.time - p0.time) > 0) {
                    const velocity = (p1.pos - p0.pos) / (p1.time - p0.time);
                    const dt = Math.min(renderTime - p1.time, state.snapshotInterval * 2);
                    const pos = p1.pos + velocity * dt;
                    applyMarkerTransform(marker, pos);
                } else {
                    applyMarkerTransform(marker, p1.pos);
                }
            }
        }
        syncTelemetryPopupPosition();
        state.rafHandle = requestAnimationFrame(tickAnimation);
    }

    function ensureAnimationLoop() {
        if (state.rafHandle != null) return;
        state.rafHandle = requestAnimationFrame(tickAnimation);
    }

    function pruneMarkers(activeKeys) {
        for (const [key, marker] of state.markers) {
            if (!activeKeys.has(key)) {
                marker.group.remove();
                state.markers.delete(key);
                if (state.telemetry.carKey === key) hideTelemetryPopup(true);
            }
        }
    }

    function renderFlagEffects(effects) {
        if (!elements.flagEffects) return;
        elements.flagEffects.innerHTML = '';

        if (!effects) return;

        const speed = Number.isFinite(Number(effects.speedMultiplier))
            ? Math.round(Number(effects.speedMultiplier) * 100) + '%'
            : 'n/a';
        const rows = [
            { label: 'Mode', value: humanizeToken(effects.mode || 'nominal') },
            { label: 'Speed', value: speed },
            { label: 'Overtake', value: effects.overtakingAllowed === false ? 'Blocked' : 'Allowed' },
            { label: 'Race', value: effects.raceSuspended ? 'Suspended' : 'Live' }
        ];
        if (effects.localSector != null) {
            rows.push({ label: 'Sector', value: sectorLabel(effects.localSector) });
        }

        const fragment = document.createDocumentFragment();
        for (const row of rows) {
            const item = document.createElement('div');
            item.className = 'flag-effect';

            const label = document.createElement('span');
            label.className = 'flag-effect__label';
            label.textContent = row.label;

            const value = document.createElement('span');
            value.className = 'flag-effect__value';
            value.textContent = row.value;

            item.appendChild(label);
            item.appendChild(value);
            fragment.appendChild(item);
        }
        elements.flagEffects.appendChild(fragment);
    }

    function renderFlagIndicator(flagDoc, effects) {
        if (!elements.flagIndicator || !elements.flagLabel || !elements.flagMeta) return;

        if (!flagDoc) {
            elements.flagIndicator.className = 'flag-indicator flag-indicator--idle';
            elements.flagIndicator.dataset.flag = '';
            elements.flagLabel.textContent = 'No active flag';
            elements.flagMeta.textContent = 'waiting for race control';
            renderFlagEffects(null);
            return;
        }

        const flag = String(flagDoc.flag || '').toUpperCase();
        const active = flagDoc.active !== false;
        const meta = ['Race ' + flagDoc.raceId];
        if (flagDoc.sector != null) meta.push(sectorFullLabel(flagDoc.sector));
        if (flagDoc.reason) meta.push(String(flagDoc.reason));
        meta.push(formatClock(flagDoc.timestamp));

        elements.flagIndicator.className = 'flag-indicator';
        elements.flagIndicator.dataset.flag = active ? flag : '';
        elements.flagLabel.textContent = active ? flagLabel(flag) : flagLabel(flag) + ' cleared';
        elements.flagMeta.textContent = meta.filter(Boolean).join(' | ');
        renderFlagEffects(effects);
    }

    function renderRaceControlFromSnapshot(snapshot) {
        const races = snapshot.races || [];
        for (const item of races) {
            if (item && item.flag) rememberRaceControl(item.flag, item.effects);
        }
        const race = races.find((item) => item && item.flag) || races[0];
        renderFlagIndicator(race && race.flag ? race.flag : null, race ? race.effects : null);
        renderRaceProgress(race || null);
    }

    function renderSnapshot(snapshot) {
        const now = performance.now();
        const snapshotServerTime = new Date(snapshot.timestamp || Date.now()).getTime();

        if (state.timeOffset == null) {
            state.timeOffset = snapshotServerTime - now;
        }
        // We no longer adjust timeOffset dynamically because doing so re-introduces
        // network jitter into the playback timeline.

        if (state.lastSnapshotTime) {
            const observed = now - state.lastSnapshotTime;
            if (observed >= ANIMATION_MIN_DURATION && observed <= ANIMATION_MAX_DURATION) {
                state.snapshotInterval =
                    state.snapshotInterval * (1 - ANIMATION_INTERVAL_EMA_ALPHA) +
                    observed * ANIMATION_INTERVAL_EMA_ALPHA;
            }
        }
        state.lastSnapshotTime = now;

        const activeKeys = new Set();
        const carsForStatePanel = [];
        let totalCars = 0;

        renderRaceControlFromSnapshot(snapshot);

        for (const race of snapshot.races || []) {
            const cars = race.cars || [];
            for (const car of cars) {
                if (car.carId == null) continue;
                mergeLatestCar(car);
            }

            if (race.classification) {
                renderClassification(race.classification);
            }

            for (const car of cars) {
                if (car.carId == null) continue;
                carsForStatePanel.push(car);
                if (car.trackPos == null) continue;
                // Use the car's actual telemetry timestamp, not the snapshot's bundling timestamp
                const carTime = new Date(car.timestamp || snapshot.timestamp || Date.now()).getTime();
                updateMarker(car, carTime);
                activeKeys.add(carKey(car));
                totalCars += 1;
            }
        }

        renderCarStates(carsForStatePanel);
        pruneMarkers(activeKeys);
        ensureAnimationLoop();
        refreshTelemetryPopup();
        setSnapshotInfo(totalCars + ' car(s) — ' + new Date(snapshotServerTime).toLocaleTimeString());
    }

    function renderLegend() {
        const teams = Array.from(state.knownTeams).sort();
        elements.legend.innerHTML = '';
        for (const teamId of teams) {
            const li = document.createElement('li');
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.background = teamColor(teamId);
            const name = document.createElement('span');
            name.textContent = teamId;
            li.appendChild(swatch);
            li.appendChild(name);
            elements.legend.appendChild(li);
        }
    }

    function renderCarStates(cars) {
        if (!elements.carStatesContainer) return;

        // Sort cars by ID for consistent display
        const sortedCars = [...cars].sort((a, b) => {
            const aId = typeof a.carId === 'number' ? a.carId : parseInt(a.carId, 10);
            const bId = typeof b.carId === 'number' ? b.carId : parseInt(b.carId, 10);
            return aId - bId;
        });

        const fragment = document.createDocumentFragment();
        for (const car of sortedCars) {
            const pill = document.createElement('div');
            pill.className = 'car-state-pill';
            const visibleState = displayCarState(car, null) || 'INIT';
            pill.setAttribute('data-state', visibleState);

            const num = document.createElement('div');
            num.className = 'car-number';
            num.textContent = car.carId;
            num.style.color = teamColor(car.teamId);

            const stateText = document.createElement('div');
            stateText.textContent = visibleState;

            pill.appendChild(num);
            pill.appendChild(stateText);

            if (car.reason && visibleState !== 'RUNNING') {
                const reasonText = document.createElement('div');
                reasonText.className = 'car-state-reason';
                reasonText.textContent = prettyReason(car.reason);
                reasonText.title = prettyReason(car.reason);
                pill.appendChild(reasonText);
            }
            fragment.appendChild(pill);
        }

        elements.carStatesContainer.innerHTML = '';
        elements.carStatesContainer.appendChild(fragment);
    }

    function formatGap(gap, pos) {
        if (pos === 1) return 'Leader';
        if (gap == null || isNaN(gap)) return '';
        return '+' + gap.toFixed(1) + 's';
    }

    function renderClassification(classification) {
        if (!classification || !classification.standings) return;

        const fragment = document.createDocumentFragment();

        for (const row of classification.standings) {
            const key = rememberStanding(classification, row);
            const tr = document.createElement('tr');
            if (key) {
                tr.dataset.carKey = key;
                tr.setAttribute('tabindex', '0');
                tr.setAttribute('aria-label', 'Car ' + row.carId + ' telemetry');
            }

            const tdPos = document.createElement('td');
            tdPos.className = 'leaderboard-pos';
            tdPos.textContent = row.position;
            tr.appendChild(tdPos);

            const tdCar = document.createElement('td');
            tdCar.className = 'leaderboard-car';
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.background = teamColor(row.teamId);
            const name = document.createElement('span');
            name.textContent = '#' + row.carId;
            const latestCar = key ? state.latestCars.get(key) : null;
            tdCar.appendChild(swatch);
            tdCar.appendChild(name);
            addCompoundBadge(tdCar, row.compound || (latestCar && latestCar.compound), true);
            tr.appendChild(tdCar);

            const tdGap = document.createElement('td');
            tdGap.className = 'leaderboard-gap';
            const visibleState = displayCarState(
                { raceId: classification.raceId, state: row.state },
                { raceId: classification.raceId, state: row.state }
            );
            if (visibleState && visibleState !== 'RUNNING') {
                tdGap.textContent = visibleState;
                if (visibleState === 'PIT' || visibleState === 'SUSPENDED') tdGap.style.color = '#fbbf24';
                else if (visibleState === 'FAULT' || visibleState === 'RETIRED') tdGap.style.color = '#f87171';
                else if (visibleState === 'FINISHED') tdGap.style.color = '#5cd39c';
            } else {
                tdGap.textContent = formatGap(row.gap, row.position);
            }
            tr.appendChild(tdGap);

            fragment.appendChild(tr);
        }

        elements.leaderboardBody.innerHTML = '';
        elements.leaderboardBody.appendChild(fragment);
        refreshTelemetryPopup();
    }

    function renderEmptyEventLog() {
        if (!elements.eventLog || elements.eventLog.children.length > 0) return;
        const item = document.createElement('li');
        item.className = 'race-event-empty';
        item.textContent = 'No events yet';
        elements.eventLog.appendChild(item);
    }

    function raceEventIdentity(kind, frame, data) {
        return [
            kind,
            frame.timestamp || '',
            data.timestamp || '',
            data.raceId || '',
            data.teamId || '',
            data.carId || '',
            data.type || '',
            data.flag || '',
            data.active,
            data.sector == null ? '' : data.sector,
            data.reason || '',
            JSON.stringify(data.details || {})
        ].join('|');
    }

    function rememberRaceEvent(id) {
        if (state.eventIds.has(id)) return false;
        state.eventIds.add(id);
        state.eventIdOrder.push(id);
        while (state.eventIdOrder.length > MAX_EVENT_LOG_ITEMS * 2) {
            state.eventIds.delete(state.eventIdOrder.shift());
        }
        return true;
    }

    function eventTone(type) {
        if (type === 'race-control') return 'flag';
        if (type === 'fault') return 'fault';
        if (type === 'retirement') return 'retirement';
        if (String(type || '').startsWith('pit-')) return 'pit';
        if (type === 'lap-completed' || type === 'sector-completed') return 'lap';
        return 'event';
    }

    function prettyReason(reason) {
        const text = String(reason || '');
        if (!text) return '';
        if (text.startsWith('low-fuel:')) return 'Low fuel (' + text.slice('low-fuel:'.length) + ')';
        if (text === 'low-fuel') return 'Low fuel';
        if (text.startsWith('tire-overheat:max=')) return 'Tire overheat (max ' + text.slice('tire-overheat:max='.length) + ')';
        if (text === 'engine-failure') return 'Engine failure';
        if (text === 'unrecoverable') return 'Unrecoverable damage';
        if (text === 'pit-out') return 'Pit exit';
        if (text === 'race-end') return 'Race end';
        if (text.startsWith('mass-incident:')) return humanizeToken(text.replace(':', ' '));
        if (text.startsWith('debris-retirement:')) return humanizeToken(text.replace(':', ' '));
        return humanizeToken(text);
    }

    function formatDuration(value, digits) {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (n < 60) return n.toFixed(digits) + 's';
        const minutes = Math.floor(n / 60);
        const seconds = (n - minutes * 60).toFixed(digits);
        return minutes + ':' + seconds.padStart(3 + digits, '0');
    }

    function latestCarForEvent(data) {
        if (!data || data.raceId == null || data.carId == null) return null;
        return state.latestCars.get(data.raceId + ':' + data.carId) || null;
    }

    function eventTrackPosition(data) {
        if (!data) return null;
        const details = data && data.details ? data.details : {};
        const detailPos = normalizedTrackPos(details.trackPos);
        if (detailPos != null) return detailPos;

        if (data.type === 'pit-entry') return 0.950;
        if (data.type === 'pit-stop') return 0.985;
        if (data.type === 'pit-exit') return 0.040;
        if (data.type === 'lap-completed') return 0;

        if (data.type === 'sector-completed') {
            const sectorId = Number(details.sector);
            const sector = TRACK_SECTORS.find((item) => item.id === sectorId);
            if (sector) return normalizedTrackPos(sector.end);
        }

        const car = latestCarForEvent(data);
        return normalizedTrackPos(car && car.trackPos);
    }

    function eventLocationLabel(data) {
        if (!data) return '';
        if (data.type === 'pit-entry') return 'Pit entry';
        if (data.type === 'pit-stop') return 'Pit box';
        if (data.type === 'pit-exit') return 'Pit exit';
        if (data.type === 'lap-completed') return 'Finish line';
        if (data.type === 'sector-completed') return sectorFullLabel(data.details && data.details.sector);

        const trackPos = eventTrackPosition(data);
        return trackPos == null ? '' : trackLocationAt(trackPos);
    }

    function eventTitle(data) {
        const car = '#' + data.carId;
        const details = data.details || {};
        if (data.type === 'pit-entry') return car + ' Pit Entry';
        if (data.type === 'pit-stop') return car + ' Pit Stop';
        if (data.type === 'pit-exit') return car + ' Pit Exit';
        if (data.type === 'fault') return car + ' Fault';
        if (data.type === 'retirement') return car + ' Retired';
        if (data.type === 'lap-completed') return car + ' Lap ' + (details.lap || '?') + ' Completed';
        if (data.type === 'sector-completed') {
            return car + ' ' + sectorLabel(details.sector) + ' Completed';
        }
        if (data.type === 'state-change') {
            if (details.to === 'FINISHED') return car + ' Finished';
            if (String(details.reason || '').startsWith('low-fuel')) return car + ' Low Fuel Warning';
            return car + ' State Change';
        }
        return car + ' ' + humanizeToken(data.type);
    }

    function isRaceStartStateChange(data) {
        const details = data && data.details ? data.details : {};
        return data && data.type === 'state-change' &&
            details.to === 'RUNNING' &&
            (details.reason === 'race-start' || details.reason === 'race start');
    }

    function hasCompanionRaceEvent(data) {
        if (!data || data.type !== 'state-change') return false;
        const reason = String((data.details && data.details.reason) || '');
        return reason === 'pit-out' ||
            reason === 'engine-failure' ||
            reason === 'unrecoverable' ||
            reason.startsWith('low-fuel:') ||
            reason.startsWith('tire-overheat:');
    }

    function shouldHideRaceEvent(data) {
        return isRaceStartStateChange(data) || hasCompanionRaceEvent(data);
    }

    function raceControlTitle(data) {
        const flag = String(data.flag || '').toUpperCase();
        if (data.active !== false && flag === 'GREEN' && data.reason === 'race-start') {
            return 'Race Started';
        }
        return (data.active === false ? 'Cleared ' : '') + flagLabel(flag);
    }

    function eventDetails(data) {
        const details = data.details || {};
        if (data.type === 'state-change') {
            const parts = [];
            if (details.from || details.to) parts.push((details.from || '?') + ' -> ' + (details.to || '?'));
            if (details.reason) parts.push(prettyReason(details.reason));
            return parts.join(' | ');
        }
        if (data.type === 'fault' || data.type === 'retirement') {
            return prettyReason(details.reason);
        }
        if (data.type === 'pit-stop') {
            const parts = [];
            const duration = formatDuration(details.duration, 2);
            if (duration != null) parts.push(duration + ' stop');
            if (details.tyreCompound) parts.push(details.tyreCompound);
            if (details.fuelAdded != null) parts.push(details.fuelAdded + 'kg fuel');
            return parts.join(' | ');
        }
        if (data.type === 'lap-completed') {
            const lapTime = formatDuration(details.lapTime, 3);
            return lapTime != null ? 'Lap time ' + lapTime : '';
        }
        if (data.type === 'sector-completed') {
            const parts = [];
            const sectorTime = formatDuration(details.sectorTime, 3);
            if (sectorTime != null) parts.push(sectorTime);
            const split = sectorSplitLabel(details.sector);
            if (split) parts.push(split);
            return parts.join(' | ');
        }
        if (details.reason) return prettyReason(details.reason);
        return '';
    }

    function appendRaceEvent(frame) {
        if (!elements.eventLog || !frame || !frame.data) return;

        const data = frame.data;
        if (shouldHideRaceEvent(data)) return;

        const kind = frame.type === 'race-control' ? 'race-control' : 'event';
        const id = raceEventIdentity(kind, frame, data);
        if (!rememberRaceEvent(id)) return;

        const empty = elements.eventLog.querySelector('.race-event-empty');
        if (empty) empty.remove();

        const item = document.createElement('li');
        item.className = 'race-event-item race-event-item--' + eventTone(kind === 'race-control' ? 'race-control' : data.type);

        const time = document.createElement('time');
        time.className = 'race-event-time';
        time.dateTime = data.timestamp || frame.timestamp || '';
        time.textContent = formatClock(data.timestamp || frame.timestamp);

        const body = document.createElement('div');

        const title = document.createElement('div');
        title.className = 'race-event-title';
        if (kind === 'race-control') {
            title.textContent = raceControlTitle(data);
        } else {
            title.textContent = eventTitle(data);
        }

        const meta = document.createElement('div');
        meta.className = 'race-event-meta';
        const metaParts = ['Race ' + data.raceId];
        if (data.teamId) metaParts.push(data.teamId);
        if (kind === 'race-control') {
            if (data.sector != null) metaParts.push(sectorFullLabel(data.sector));
            if (data.reason) metaParts.push(prettyReason(data.reason));
        } else {
            const location = eventLocationLabel(data);
            if (location) metaParts.push(location);
        }
        meta.textContent = metaParts.filter(Boolean).join(' | ');

        body.appendChild(title);
        body.appendChild(meta);

        const detailText = kind === 'race-control' ? '' : eventDetails(data);
        if (detailText) {
            const detail = document.createElement('div');
            detail.className = 'race-event-detail';
            detail.textContent = detailText;
            body.appendChild(detail);
        }

        item.appendChild(time);
        item.appendChild(body);
        elements.eventLog.prepend(item);

        while (elements.eventLog.children.length > MAX_EVENT_LOG_ITEMS) {
            elements.eventLog.lastElementChild.remove();
        }
    }

    function handleFrame(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch (err) {
            console.warn('invalid frame', err);
            return;
        }
        if (frame && frame.type === 'snapshot') {
            renderSnapshot(frame);
        } else if (frame && frame.type === 'classification') {
            renderClassification(frame.data);
        } else if (frame && frame.type === 'state') {
            mergeLatestCar(frame.data);
            refreshTelemetryPopup();
        } else if (frame && frame.type === 'event') {
            appendRaceEvent(frame);
        } else if (frame && frame.type === 'race-control') {
            rememberRaceControl(frame.data, frame.effects);
            renderFlagIndicator(frame.data, frame.effects);
            appendRaceEvent(frame);
            refreshTelemetryPopup();
        }
    }

    function connectWebSocket() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = proto + '//' + window.location.host + WS_PATH;

        setConnectionStatus('connecting…', 'idle');
        const socket = new WebSocket(url);
        state.socket = socket;

        socket.addEventListener('open', () => {
            setConnectionStatus('connected', 'ok');
            if (!state.scenarioStarted) {
                setScenarioControlsEnabled(true);
                setScenarioStatus('ready');
            }
        });
        socket.addEventListener('message', (event) => handleFrame(event.data));
        socket.addEventListener('error', () => {
            setConnectionStatus('error', 'error');
            if (!state.scenarioStarted) setScenarioControlsEnabled(false);
        });
        socket.addEventListener('close', () => {
            if (state.socket === socket) state.socket = null;
            setConnectionStatus('reconnecting…', 'error');
            if (!state.scenarioStarted) {
                setScenarioControlsEnabled(false);
                setScenarioStatus('reconnecting...');
            }
            setTimeout(connectWebSocket, 2000);
        });
    }

    async function bootstrap() {
        try {
            await loadCircuit();
        } catch (err) {
            console.error(err);
            setSnapshotInfo('failed to load circuit: ' + err.message);
            return;
        }
        renderEmptyEventLog();
        bindTelemetryInteractions();
        bindScenarioButtons();
        connectWebSocket();
    }

    bootstrap();
})();
