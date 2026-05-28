'use strict';

// ─── Shared constants ─────────────────────────────────────────────────────────

export const TEAM_COLORS = Object.freeze({
    ferrari:  '#dc0000',
    mercedes: '#27f4d2',
    redbull:  '#1e41ff',
    mclaren:  '#ff8000',
    alpine:   '#0090ff'
});

export const COMPOUND_LABELS = Object.freeze({
    soft:   'Soft',
    medium: 'Medium',
    hard:   'Hard'
});

export const STATE_CLASS = Object.freeze({
    PIT:       'car-marker--pit',
    FAULT:     'car-marker--fault',
    SUSPENDED: 'car-marker--suspended',
    RETIRED:   'car-marker--retired',
    FINISHED:  'car-marker--finished'
});

export const FLAG_LABELS = Object.freeze({
    GREEN:     'Green Flag',
    YELLOW:    'Yellow Flag',
    RED:       'Red Flag',
    CHECKERED: 'Checkered Flag',
    SC:        'Safety Car',
    VSC:       'Virtual Safety Car'
});

export const TELEMETRY_FIELDS = Object.freeze([
    'raceId', 'teamId', 'carId', 'compound', 'lap', 'trackPos',
    'speed', 'avgSpeedKmh', 'rpm', 'gear', 'throttle', 'brake',
    'drs', 'fuel', 'state', 'previousState', 'reason', 'timestamp', 'receivedAt'
]);

export const TRACK_SECTORS = Object.freeze([
    {
        id: 1, start: 0.000, end: 0.330,
        label: 'Sector 1',
        routeLabel: 'Prima Variante, Curva Biassono, Roggia',
        splitLabel: 'Roggia split'
    },
    {
        id: 2, start: 0.330, end: 0.660,
        label: 'Sector 2',
        routeLabel: 'Lesmo, Serraglio',
        splitLabel: 'Ascari entry split'
    },
    {
        id: 3, start: 0.660, end: 1.000,
        label: 'Sector 3',
        routeLabel: 'Ascari, Parabolica, finish straight',
        splitLabel: 'Finish line'
    }
]);

export const TRACK_LOCATIONS = Object.freeze([
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

export const MAX_EVENT_LOG_ITEMS = 80;

// ─── Internal constants ───────────────────────────────────────────────────────

const FALLBACK_COLOR = '#9ca3af';
const WS_PATH = '/api/ws/f1';
const SESSION_BUFFER_KEY = 'f1_race_event_buffer';

// ─── Shared state ─────────────────────────────────────────────────────────────

function loadBufferFromSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_BUFFER_KEY);
        if (!raw) return [];
        const saved = JSON.parse(raw);
        return Array.isArray(saved) ? saved : [];
    } catch (_) {
        return [];
    }
}

function saveBufferToSession(buf) {
    try {
        sessionStorage.setItem(SESSION_BUFFER_KEY, JSON.stringify(buf));
    } catch (_) { /* quota exceeded — silently ignore */ }
}

function eventBufferKey(frame) {
    if (!frame) return '';
    const d = frame.data || {};
    return [
        frame.type    || '',
        frame.timestamp || '',
        d.timestamp   || '',
        d.raceId      || '',
        d.teamId      || '',
        d.carId       || '',
        d.type        || '',
        d.flag        || ''
    ].join('|');
}

const _sessionBuffer = loadBufferFromSession();

export const state = {
    socket:             null,
    knownTeams:         new Set(),
    latestCars:         new Map(),
    latestStandings:    new Map(),
    raceFlags:          new Map(),
    raceEffects:        new Map(),
    eventIds:           new Set(),
    eventIdOrder:       [],
    raceEventBuffer:    _sessionBuffer,
    bufferedEventIds:   new Set(_sessionBuffer.map(eventBufferKey)),
    currentRaceStartKey: null,
};

// ─── Pub/sub ──────────────────────────────────────────────────────────────────
//
// Supported data types: 'snapshot' | 'classification' | 'state' | 'event' | 'race-control' | 'race-reset'
// Connection lifecycle:  'ws-status'  (payload: 'connecting' | 'connected' | 'error' | 'reconnecting')

const _subs = Object.create(null);

export function on(type, cb) {
    if (!_subs[type]) _subs[type] = [];
    _subs[type].push(cb);
}

function emit(type, ...args) {
    const list = _subs[type];
    if (list) for (const cb of list) cb(...args);
}

// ─── Accessors ────────────────────────────────────────────────────────────────

export function getLatestCar(key) {
    return state.latestCars.get(key) || null;
}

export function getKnownTeams() {
    return Array.from(state.knownTeams);
}

// ─── Helpers / formatters ─────────────────────────────────────────────────────

export function teamColor(teamId) {
    return TEAM_COLORS[teamId] || FALLBACK_COLOR;
}

export function carKey(car) {
    return car.raceId + ':' + car.carId;
}

export function humanizeToken(value) {
    return String(value || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function flagLabel(flag) {
    return FLAG_LABELS[flag] || humanizeToken(flag);
}

export function formatClock(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '--:--:--';
    return date.toLocaleTimeString([], { hour12: false });
}

export function formatDuration(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 60) return n.toFixed(digits) + 's';
    const minutes = Math.floor(n / 60);
    const seconds = (n - minutes * 60).toFixed(digits);
    return minutes + ':' + seconds.padStart(3 + digits, '0');
}

export function formatGap(gap, pos) {
    if (pos === 1) return 'Leader';
    if (gap == null || isNaN(gap)) return '';
    return '+' + gap.toFixed(1) + 's';
}

export function normalizedTrackPos(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return ((n % 1) + 1) % 1;
}

export function sectorLabel(sector) {
    if (sector == null || sector === '') return 'Sector ?';
    const id = Number(sector);
    const item = TRACK_SECTORS.find((s) => s.id === id);
    return item ? item.label : 'Sector ' + sector;
}

export function sectorFullLabel(sector) {
    if (sector == null || sector === '') return 'Sector ?';
    const id = Number(sector);
    const item = TRACK_SECTORS.find((s) => s.id === id);
    if (!item) return 'Sector ' + sector;
    return item.label + ' - ' + item.routeLabel;
}

export function sectorSplitLabel(sector) {
    if (sector == null || sector === '') return '';
    const id = Number(sector);
    const item = TRACK_SECTORS.find((s) => s.id === id);
    return item ? item.splitLabel : '';
}

export function trackLocationAt(trackPos) {
    const pos = normalizedTrackPos(trackPos);
    if (pos == null) return '';
    const location = TRACK_LOCATIONS.find((item) => pos >= item.start && pos < item.end);
    return location ? location.label : 'Rettifilo finale';
}

export function prettyReason(reason) {
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

// Internal formatting helpers (used by telemetryMetricRows)

function formatNumber(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(digits);
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

function formatWearPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    return Math.round(n * 100) + '%';
}

function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

// Internal tone helpers (used by telemetryMetricRows)

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
    return 'muted';
}

function toneForTireWear(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'muted';
    if (n >= 0.75) return 'danger';
    if (n >= 0.50) return 'warn';
    return 'ok';
}

// ─── Race-state helpers ───────────────────────────────────────────────────────

export function toneForState(value) {
    const stateName = String(value || '').toUpperCase();
    if (stateName === 'FAULT' || stateName === 'RETIRED') return 'danger';
    if (stateName === 'PIT' || stateName === 'SUSPENDED') return 'warn';
    if (stateName === 'INIT') return 'muted';
    return 'ok';
}

function raceKeyFromId(raceId) {
    return raceId == null ? null : String(raceId);
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

export function displayCarState(car, standing) {
    const raw = rawCarState(car, standing);
    if (isRaceSuspended((car && car.raceId) || (standing && standing.raceId)) &&
        raw !== 'RETIRED' && raw !== 'FINISHED') {
        return 'SUSPENDED';
    }
    return raw;
}

export function telemetrySensorsOff(car, standing) {
    const raw = rawCarState(car, standing);
    if (raw === 'RETIRED' || raw === 'FINISHED') return true;
    return isRaceSuspended((car && car.raceId) || (standing && standing.raceId));
}

// ─── Compound badge helpers ───────────────────────────────────────────────────

function normalizeCompound(value) {
    const id = String(value || '').toLowerCase();
    return COMPOUND_LABELS[id] ? id : null;
}

export function createCompoundBadge(value, compact) {
    const compound = normalizeCompound(value);
    if (!compound) return null;
    const badge = document.createElement('span');
    badge.className = 'compound-badge compound-badge--' + compound;
    badge.textContent = compact ? compound.charAt(0).toUpperCase() : COMPOUND_LABELS[compound];
    badge.title = COMPOUND_LABELS[compound] + ' compound';
    return badge;
}

export function addCompoundBadge(container, value, compact) {
    const badge = createCompoundBadge(value, compact);
    if (badge) container.appendChild(badge);
}

// ─── Telemetry metrics ────────────────────────────────────────────────────────

export function telemetryMetricRows(car, sensorsOff) {
    const labels = [
        'Speed', 'RPM', 'Gear', 'Throttle', 'Brake', 'DRS', 'Fuel', 'Track',
        'Tyre FL', 'Tyre FR', 'Tyre RL', 'Tyre RR',
        'Wear FL', 'Wear FR', 'Wear RL', 'Wear RR'
    ];
    if (sensorsOff) {
        return labels.map((label) => ({ label, value: 'OFF', tone: 'muted' }));
    }

    const tireTemp = car && car.tireTemp && typeof car.tireTemp === 'object' ? car.tireTemp : {};
    const tireWear = car && car.tireWear && typeof car.tireWear === 'object' ? car.tireWear : {};
    return [
        { label: 'Speed',    value: formatTelemetryNumber(car && car.speed,    1, 'km/h'), tone: toneForSpeed(car && car.speed) },
        { label: 'RPM',      value: formatInteger(car && car.rpm),                          tone: toneForRpm(car && car.rpm) },
        { label: 'Gear',     value: Number(car && car.gear) === 0 ? 'N' : formatInteger(car && car.gear), tone: isFiniteNumber(car && car.gear) ? 'ok' : 'muted' },
        { label: 'Throttle', value: formatPercent(car && car.throttle),                     tone: toneForThrottle(car && car.throttle) },
        { label: 'Brake',    value: formatPercent(car && car.brake),                        tone: toneForBrake(car && car.brake) },
        { label: 'DRS',      value: car && car.drs === true ? 'ON' : (car && car.drs === false ? 'OFF' : '--'), tone: toneForDrs(car && car.drs) },
        { label: 'Fuel',     value: formatTelemetryNumber(car && car.fuel,     1, 'kg'),   tone: toneForFuel(car && car.fuel) },
        { label: 'Track',    value: formatTrackPercent(car && car.trackPos),                tone: isFiniteNumber(car && car.trackPos) ? 'ok' : 'muted' },
        { label: 'Tyre FL',  value: formatTelemetryNumber(tireTemp.fl, 1, 'C'),            tone: toneForTireTemp(tireTemp.fl) },
        { label: 'Tyre FR',  value: formatTelemetryNumber(tireTemp.fr, 1, 'C'),            tone: toneForTireTemp(tireTemp.fr) },
        { label: 'Tyre RL',  value: formatTelemetryNumber(tireTemp.rl, 1, 'C'),            tone: toneForTireTemp(tireTemp.rl) },
        { label: 'Tyre RR',  value: formatTelemetryNumber(tireTemp.rr, 1, 'C'),            tone: toneForTireTemp(tireTemp.rr) },
        { label: 'Wear FL',  value: formatWearPercent(tireWear.fl),                         tone: toneForTireWear(tireWear.fl) },
        { label: 'Wear FR',  value: formatWearPercent(tireWear.fr),                         tone: toneForTireWear(tireWear.fr) },
        { label: 'Wear RL',  value: formatWearPercent(tireWear.rl),                         tone: toneForTireWear(tireWear.rl) },
        { label: 'Wear RR',  value: formatWearPercent(tireWear.rr),                         tone: toneForTireWear(tireWear.rr) }
    ];
}

// ─── State management ─────────────────────────────────────────────────────────

export function mergeLatestCar(car) {
    if (!car || car.raceId == null || car.carId == null) return null;

    const key = carKey(car);
    const previous = state.latestCars.get(key) || {};
    const merged = { ...previous };
    for (const field of TELEMETRY_FIELDS) {
        if (car[field] != null) merged[field] = car[field];
    }
    if (typeof car.drs === 'boolean') merged.drs = car.drs;
    if (car.tireTemp && typeof car.tireTemp === 'object') {
        merged.tireTemp = { ...(previous.tireTemp || {}), ...car.tireTemp };
    }
    if (car.tireWear && typeof car.tireWear === 'object') {
        merged.tireWear = { ...(previous.tireWear || {}), ...car.tireWear };
    }
    state.latestCars.set(key, merged);

    if (car.teamId && !state.knownTeams.has(car.teamId)) {
        state.knownTeams.add(car.teamId);
    }
    return key;
}

function standingKey(classification, row) {
    if (!classification || classification.raceId == null || !row || row.carId == null) return null;
    return classification.raceId + ':' + row.carId;
}

export function rememberStanding(classification, row) {
    const key = standingKey(classification, row);
    if (!key) return null;
    state.latestStandings.set(key, {
        ...row,
        raceId: classification.raceId,
        timestamp: classification.timestamp
    });
    return key;
}

export function rememberRaceControl(flagDoc, effects) {
    const key = raceKeyFromId(flagDoc && flagDoc.raceId);
    if (!key) return;
    if (flagDoc) state.raceFlags.set(key, flagDoc);
    if (effects) state.raceEffects.set(key, effects);
}

export function rememberRaceEvent(id) {
    if (state.eventIds.has(id)) return false;
    state.eventIds.add(id);
    state.eventIdOrder.push(id);
    while (state.eventIdOrder.length > MAX_EVENT_LOG_ITEMS * 2) {
        state.eventIds.delete(state.eventIdOrder.shift());
    }
    return true;
}

export function clearEventDedup() {
    state.eventIds.clear();
    state.eventIdOrder.length = 0;
}

export function clearRaceEventBuffer() {
    state.raceEventBuffer.length = 0;
    state.bufferedEventIds.clear();
    clearEventDedup();
    try { sessionStorage.removeItem(SESSION_BUFFER_KEY); } catch (_) {}
}

function raceStartKey(frame) {
    if (!frame || frame.type !== 'race-control') return null;

    const data = frame.data || {};
    const flag = String(data.flag || '').toUpperCase();
    if (flag !== 'GREEN' || data.active === false || data.reason !== 'race-start') return null;

    const raceId = data.raceId == null ? '' : String(data.raceId);
    const timestamp = data.timestamp || frame.timestamp || '';
    return raceId && timestamp ? raceId + '|' + timestamp : null;
}

function latestRaceStartIndex(eventLog) {
    let index = -1;
    for (let i = 0; i < eventLog.length; i += 1) {
        if (raceStartKey(eventLog[i])) index = i;
    }
    return index;
}

function resetEventsForRaceStart(frame) {
    const key = raceStartKey(frame);
    if (!key || state.currentRaceStartKey === key) return false;

    state.currentRaceStartKey = key;
    clearRaceEventBuffer();
    emit('race-reset', frame);
    return true;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

export function send(command) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(command));
    return true;
}

function handleFrame(raw) {
    let frame;
    try {
        frame = JSON.parse(raw);
    } catch (err) {
        console.warn('invalid frame', err);
        return;
    }
    if (!frame) return;

    if (frame.type === 'snapshot') {
        for (const race of frame.races || []) {
            for (const car of race.cars || []) {
                if (car.carId != null) mergeLatestCar(car);
            }
            if (race.classification) {
                for (const row of race.classification.standings || []) {
                    rememberStanding(race.classification, row);
                }
            }
            const flagFrame = race.flag
                ? { type: 'race-control', timestamp: race.flag.timestamp, data: race.flag, effects: race.effects }
                : null;

            if (flagFrame) {
                resetEventsForRaceStart(flagFrame);
                rememberRaceControl(race.flag, race.effects);
            }

            const eventLog = Array.isArray(race.eventLog) ? race.eventLog : [];
            const raceStartIndex = latestRaceStartIndex(eventLog);
            const firstEventIndex = raceStartIndex >= 0 ? raceStartIndex : 0;
            if (raceStartIndex >= 0) resetEventsForRaceStart(eventLog[raceStartIndex]);

            if (raceStartIndex < 0 && raceStartKey(flagFrame)) {
                const key = eventBufferKey(flagFrame);
                if (!state.bufferedEventIds.has(key)) {
                    state.bufferedEventIds.add(key);
                    state.raceEventBuffer.push(flagFrame);
                    if (state.raceEventBuffer.length > MAX_EVENT_LOG_ITEMS * 3) state.raceEventBuffer.shift();
                    emit('race-control', flagFrame.data, flagFrame.effects);
                }
            }

            for (const ef of eventLog.slice(firstEventIndex)) {
                const key = eventBufferKey(ef);
                if (state.bufferedEventIds.has(key)) continue;
                state.bufferedEventIds.add(key);
                if (ef.type === 'event') {
                    state.raceEventBuffer.push(ef);
                    emit('event', ef);
                } else if (ef.type === 'race-control') {
                    state.raceEventBuffer.push({ type: 'race-control', timestamp: ef.data && ef.data.timestamp, data: ef.data });
                    emit('race-control', ef.data, ef.effects);
                }
                if (state.raceEventBuffer.length > MAX_EVENT_LOG_ITEMS * 3) state.raceEventBuffer.shift();
            }
        }
        saveBufferToSession(state.raceEventBuffer);
        emit('snapshot', frame);
    } else if (frame.type === 'classification') {
        if (frame.data && Array.isArray(frame.data.standings)) {
            for (const row of frame.data.standings) {
                rememberStanding(frame.data, row);
            }
        }
        emit('classification', frame.data);
    } else if (frame.type === 'state') {
        mergeLatestCar(frame.data);
        emit('state', frame.data);
    } else if (frame.type === 'event') {
        const key = eventBufferKey(frame);
        if (!state.bufferedEventIds.has(key)) {
            state.bufferedEventIds.add(key);
            state.raceEventBuffer.push(frame);
            if (state.raceEventBuffer.length > MAX_EVENT_LOG_ITEMS * 3) state.raceEventBuffer.shift();
            saveBufferToSession(state.raceEventBuffer);
            emit('event', frame);
        }
    } else if (frame.type === 'race-control') {
        rememberRaceControl(frame.data, frame.effects);
        const rcFrame = { type: 'race-control', timestamp: frame.data && frame.data.timestamp, data: frame.data };
        resetEventsForRaceStart(rcFrame);
        const key = eventBufferKey(rcFrame);
        if (!state.bufferedEventIds.has(key)) {
            state.bufferedEventIds.add(key);
            state.raceEventBuffer.push(rcFrame);
            if (state.raceEventBuffer.length > MAX_EVENT_LOG_ITEMS * 3) state.raceEventBuffer.shift();
            saveBufferToSession(state.raceEventBuffer);
        }
        emit('race-control', frame.data, frame.effects);
    }
}

export function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + window.location.host + WS_PATH;

    const socket = new WebSocket(url);
    state.socket = socket;
    emit('ws-status', 'connecting');

    socket.addEventListener('open',    ()      => emit('ws-status', 'connected'));
    socket.addEventListener('message', (event) => handleFrame(event.data));
    socket.addEventListener('error',   ()      => emit('ws-status', 'error'));
    socket.addEventListener('close',   ()      => {
        if (state.socket === socket) state.socket = null;
        emit('ws-status', 'reconnecting');
        setTimeout(connectWebSocket, 2000);
    });
}
