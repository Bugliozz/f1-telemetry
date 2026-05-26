'use strict';

import {
    state,
    on,
    connectWebSocket,
    carKey,
    teamColor,
    flagLabel,
    humanizeToken,
    formatClock,
    formatDuration,
    formatGap,
    normalizedTrackPos,
    sectorLabel,
    sectorFullLabel,
    sectorSplitLabel,
    trackLocationAt,
    prettyReason,
    displayCarState,
    toneForState,
    telemetrySensorsOff,
    telemetryMetricRows,
    createCompoundBadge,
    rememberRaceEvent,
    clearEventDedup,
    TEAM_COLORS,
    TRACK_SECTORS,
    MAX_EVENT_LOG_ITEMS,
} from '/js/core.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TEAM_IDS = Object.keys(TEAM_COLORS);
const LS_KEY   = 'f1-team-view-selected-team';

// ─── Local state ──────────────────────────────────────────────────────────────

const local = {
    selectedTeam: null,
};

// ─── DOM element cache ────────────────────────────────────────────────────────

const elements = {
    connection:  document.getElementById('connection-status'),
    snapshot:    document.getElementById('snapshot-info'),
    raceClock:   document.getElementById('race-clock'),
    selector:    document.getElementById('team-selector'),
    prompt:      document.getElementById('team-prompt'),
    content:     document.getElementById('team-content'),
    carCards:    document.getElementById('car-cards'),
    carStates:   document.getElementById('car-states-container'),
    eventLog:    document.getElementById('race-event-log'),
};

// ─── Connection status ────────────────────────────────────────────────────────

function setConnectionStatus(label, kind) {
    if (!elements.connection) return;
    elements.connection.textContent = label;
    elements.connection.className = 'status-pill status-pill--' + kind;
}

function setSnapshotInfo(text) {
    if (elements.snapshot) elements.snapshot.textContent = text;
}

// ─── Live clock ───────────────────────────────────────────────────────────────

if (elements.raceClock) {
    const tickClock = () => {
        elements.raceClock.textContent = new Date().toLocaleTimeString();
    };
    tickClock();
    setInterval(tickClock, 1000);
}

// ─── Team selection & persistence ────────────────────────────────────────────

function readInitialTeam() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('team');
    if (fromUrl && TEAM_IDS.includes(fromUrl)) return fromUrl;

    const fromStorage = localStorage.getItem(LS_KEY);
    if (fromStorage && TEAM_IDS.includes(fromStorage)) return fromStorage;

    return null;
}

function persistTeam(teamId) {
    const url = new URL(window.location.href);
    if (teamId) {
        url.searchParams.set('team', teamId);
        localStorage.setItem(LS_KEY, teamId);
    } else {
        url.searchParams.delete('team');
        localStorage.removeItem(LS_KEY);
    }
    window.history.replaceState(null, '', url.toString());
}

function applyChipActiveStyles() {
    if (!elements.selector) return;
    for (const chip of elements.selector.querySelectorAll('.team-chip')) {
        const teamId  = chip.dataset.team;
        const isActive = teamId === local.selectedTeam;
        chip.classList.toggle('team-chip--active', isActive);
        chip.setAttribute('aria-pressed', String(isActive));
        chip.style.borderColor = isActive ? teamColor(teamId) : '';
    }
}

function selectTeam(teamId) {
    local.selectedTeam = teamId;
    persistTeam(teamId);
    applyChipActiveStyles();
    showContent(true);
    renderCarCards(teamId);
    renderCarStates(teamId);
    replayEventsForTeam(teamId);
}

function buildTeamSelector() {
    if (!elements.selector) return;
    elements.selector.innerHTML = '';

    for (const teamId of TEAM_IDS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'team-chip';
        chip.dataset.team = teamId;
        chip.setAttribute('aria-pressed', 'false');

        const dot = document.createElement('span');
        dot.className = 'team-chip__dot';
        dot.style.background = teamColor(teamId);
        dot.setAttribute('aria-hidden', 'true');

        const lbl = document.createElement('span');
        lbl.className = 'team-chip__label';
        lbl.textContent = teamId;

        chip.appendChild(dot);
        chip.appendChild(lbl);
        chip.addEventListener('click', () => selectTeam(teamId));

        chip.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectTeam(teamId);
            }
        });

        elements.selector.appendChild(chip);
    }
}

// ─── Content visibility ───────────────────────────────────────────────────────

function showContent(hasTeam) {
    if (elements.prompt)  elements.prompt.classList.toggle('team-prompt--hidden',  hasTeam);
    if (elements.content) elements.content.classList.toggle('team-content--hidden', !hasTeam);
}

// ─── Car card rendering ───────────────────────────────────────────────────────

function buildCarCard(car) {
    const key        = carKey(car);
    const standing   = state.latestStandings.get(key) || null;
    const visible    = displayCarState(car, standing);
    const sensorsOff = telemetrySensorsOff(car, standing);

    const card = document.createElement('div');
    card.className    = 'car-card';
    card.dataset.carKey = key;

    // Header
    const head = document.createElement('div');
    head.className = 'car-card__head';

    const identity = document.createElement('div');
    identity.className = 'car-card__identity';

    const carNum = document.createElement('div');
    carNum.className   = 'car-card__number';
    carNum.textContent = '#' + car.carId;
    carNum.style.color = teamColor(car.teamId);

    const teamLbl = document.createElement('div');
    teamLbl.className   = 'car-card__team';
    teamLbl.textContent = car.teamId;

    identity.appendChild(carNum);
    identity.appendChild(teamLbl);
    head.appendChild(identity);

    // Badges (state + compound) — each with a context label above
    const badges = document.createElement('div');
    badges.className = 'car-card__badges';

    const stateGroup = document.createElement('div');
    stateGroup.className = 'car-card__badge-group';
    const stateLabelEl = document.createElement('span');
    stateLabelEl.className   = 'car-card__badge-label';
    stateLabelEl.textContent = 'STATE';
    const stateEl = document.createElement('span');
    stateEl.className   = 'car-card__state telemetry-value--' + toneForState(visible);
    stateEl.textContent = visible;
    stateGroup.appendChild(stateLabelEl);
    stateGroup.appendChild(stateEl);
    badges.appendChild(stateGroup);

    const badge = createCompoundBadge(car.compound);
    if (badge) {
        const tyreGroup = document.createElement('div');
        tyreGroup.className = 'car-card__badge-group';
        const tyreLabelEl = document.createElement('span');
        tyreLabelEl.className   = 'car-card__badge-label';
        tyreLabelEl.textContent = 'TYRE';
        tyreGroup.appendChild(tyreLabelEl);
        tyreGroup.appendChild(badge);
        badges.appendChild(tyreGroup);
    }

    head.appendChild(badges);
    card.appendChild(head);

    // Meta row (lap, position, gap)
    const meta = document.createElement('div');
    meta.className = 'car-card__meta';

    if (car.lap != null) {
        const lapEl = document.createElement('span');
        lapEl.className   = 'car-card__meta-item';
        lapEl.textContent = 'Lap ' + car.lap;
        meta.appendChild(lapEl);
    }
    if (standing && standing.position != null) {
        const posEl = document.createElement('span');
        posEl.className   = 'car-card__meta-item';
        posEl.textContent = 'P' + standing.position;
        meta.appendChild(posEl);
    }
    if (standing && standing.gap != null) {
        const gapEl = document.createElement('span');
        gapEl.className   = 'car-card__meta-item';
        gapEl.textContent = formatGap(Number(standing.gap), Number(standing.position));
        meta.appendChild(gapEl);
    }
    card.appendChild(meta);

    // Telemetry metrics grid
    const grid = document.createElement('div');
    grid.className = 'car-card__grid';

    for (const row of telemetryMetricRows(car, sensorsOff)) {
        const item = document.createElement('div');
        item.className = 'telemetry-metric';

        const lbl = document.createElement('span');
        lbl.className   = 'telemetry-metric__label';
        lbl.textContent = row.label;

        const val = document.createElement('span');
        val.className   = 'telemetry-metric__value telemetry-value--' + row.tone;
        val.textContent = row.value;

        item.appendChild(lbl);
        item.appendChild(val);
        grid.appendChild(item);
    }
    card.appendChild(grid);

    return card;
}

function getCarsForTeam(teamId) {
    const cars = [];
    for (const car of state.latestCars.values()) {
        if (car.teamId === teamId) cars.push(car);
    }
    return cars.sort((a, b) => Number(a.carId) - Number(b.carId));
}

function renderCarCards(teamId) {
    if (!elements.carCards) return;
    const frag = document.createDocumentFragment();
    for (const car of getCarsForTeam(teamId)) {
        frag.appendChild(buildCarCard(car));
    }
    elements.carCards.innerHTML = '';
    elements.carCards.appendChild(frag);
}

function refreshCarCard(car) {
    if (!elements.carCards) return;
    const key      = carKey(car);
    const existing = elements.carCards.querySelector('[data-car-key="' + key + '"]');
    const updated  = buildCarCard(car);
    if (existing) {
        existing.replaceWith(updated);
    } else {
        renderCarCards(local.selectedTeam);
    }
}

// ─── Car states panel ─────────────────────────────────────────────────────────

function renderCarStates(teamId) {
    if (!elements.carStates) return;
    const frag = document.createDocumentFragment();

    for (const car of getCarsForTeam(teamId)) {
        const visible = displayCarState(car, null) || 'INIT';
        const pill = document.createElement('div');
        pill.className = 'car-state-pill';
        pill.setAttribute('data-state', visible);

        const num = document.createElement('div');
        num.className   = 'car-number';
        num.textContent = car.carId;
        num.style.color = teamColor(car.teamId);

        const stateTxt = document.createElement('div');
        stateTxt.textContent = visible;

        pill.appendChild(num);
        pill.appendChild(stateTxt);

        if (car.reason && visible !== 'RUNNING') {
            const reason = document.createElement('div');
            reason.className   = 'car-state-reason';
            reason.textContent = prettyReason(car.reason);
            reason.title       = prettyReason(car.reason);
            pill.appendChild(reason);
        }
        frag.appendChild(pill);
    }

    elements.carStates.innerHTML = '';
    elements.carStates.appendChild(frag);
}

// ─── Race event log ───────────────────────────────────────────────────────────

function replayEventsForTeam(teamId) {
    if (!elements.eventLog) return;
    clearEventDedup();
    elements.eventLog.innerHTML = '';
    const empty = document.createElement('li');
    empty.className   = 'race-event-empty';
    empty.textContent = 'No events yet';
    elements.eventLog.appendChild(empty);
    for (const frame of state.raceEventBuffer) {
        if (!frame || !frame.data) continue;
        if (frame.type !== 'race-control' && frame.data.teamId !== teamId) continue;
        appendRaceEvent(frame);
    }
}

function raceEventIdentity(kind, frame, data) {
    return [
        kind,
        frame.timestamp || '',
        data.timestamp  || '',
        data.raceId     || '',
        data.teamId     || '',
        data.carId      || '',
        data.type       || '',
        data.flag       || '',
        data.active,
        data.sector == null ? '' : data.sector,
        data.reason     || '',
        JSON.stringify(data.details || {})
    ].join('|');
}

function eventTone(type) {
    if (type === 'race-control') return 'flag';
    if (type === 'fault')        return 'fault';
    if (type === 'retirement')   return 'retirement';
    if (String(type || '').startsWith('pit-')) return 'pit';
    if (type === 'lap-completed' || type === 'sector-completed') return 'lap';
    return 'event';
}

function isRaceStartStateChange(data) {
    const d = data && data.details ? data.details : {};
    return data && data.type === 'state-change' &&
        d.to === 'RUNNING' &&
        (d.reason === 'race-start' || d.reason === 'race start');
}

function hasCompanionEvent(data) {
    if (!data || data.type !== 'state-change') return false;
    const reason = String((data.details && data.details.reason) || '');
    return reason === 'pit-out' || reason === 'engine-failure' ||
        reason === 'unrecoverable' || reason.startsWith('low-fuel:') ||
        reason.startsWith('tire-overheat:');
}

function shouldHideEvent(data) {
    return isRaceStartStateChange(data) || hasCompanionEvent(data);
}

function raceControlTitle(data) {
    const flag = String(data.flag || '').toUpperCase();
    if (data.active !== false && flag === 'GREEN' && data.reason === 'race-start') return 'Race Started';
    return (data.active === false ? 'Cleared ' : '') + flagLabel(flag);
}

function eventTrackPosition(data) {
    if (!data) return null;
    const details   = data.details ? data.details : {};
    const detailPos = normalizedTrackPos(details.trackPos);
    if (detailPos != null) return detailPos;

    if (data.type === 'pit-entry') return 0.950;
    if (data.type === 'pit-stop')  return 0.985;
    if (data.type === 'pit-exit')  return 0.040;
    if (data.type === 'lap-completed') return 0;

    if (data.type === 'sector-completed') {
        const sid    = Number(details.sector);
        const sector = TRACK_SECTORS.find((s) => s.id === sid);
        if (sector) return normalizedTrackPos(sector.end);
    }

    const car = (data.raceId != null && data.carId != null)
        ? state.latestCars.get(data.raceId + ':' + data.carId)
        : null;
    return normalizedTrackPos(car && car.trackPos);
}

function eventLocationLabel(data) {
    if (!data) return '';
    if (data.type === 'pit-entry') return 'Pit entry';
    if (data.type === 'pit-stop')  return 'Pit box';
    if (data.type === 'pit-exit')  return 'Pit exit';
    if (data.type === 'lap-completed') return 'Finish line';
    if (data.type === 'sector-completed') return sectorFullLabel(data.details && data.details.sector);
    const pos = eventTrackPosition(data);
    return pos == null ? '' : trackLocationAt(pos);
}

function eventTitle(data) {
    const car     = '#' + data.carId;
    const details = data.details || {};
    if (data.type === 'pit-entry')  return car + ' Pit Entry';
    if (data.type === 'pit-stop')   return car + ' Pit Stop';
    if (data.type === 'pit-exit')   return car + ' Pit Exit';
    if (data.type === 'fault')      return car + ' Fault';
    if (data.type === 'retirement') return car + ' Retired';
    if (data.type === 'lap-completed')    return car + ' Lap ' + (details.lap || '?') + ' Completed';
    if (data.type === 'sector-completed') return car + ' ' + sectorLabel(details.sector) + ' Completed';
    if (data.type === 'state-change') {
        if (details.to === 'FINISHED') return car + ' Finished';
        if (String(details.reason || '').startsWith('low-fuel')) return car + ' Low Fuel Warning';
        return car + ' State Change';
    }
    return car + ' ' + humanizeToken(data.type);
}

function eventDetails(data) {
    const details = data.details || {};
    if (data.type === 'state-change') {
        const parts = [];
        if (details.from || details.to) parts.push((details.from || '?') + ' → ' + (details.to || '?'));
        if (details.reason) parts.push(prettyReason(details.reason));
        return parts.join(' | ');
    }
    if (data.type === 'fault' || data.type === 'retirement') return prettyReason(details.reason);
    if (data.type === 'pit-stop') {
        const parts = [];
        const dur = formatDuration(details.duration, 2);
        if (dur != null) parts.push(dur + ' stop');
        if (details.tyreCompound) parts.push(details.tyreCompound);
        if (details.fuelAdded != null) parts.push(details.fuelAdded + 'kg fuel');
        return parts.join(' | ');
    }
    if (data.type === 'lap-completed') {
        const t = formatDuration(details.lapTime, 3);
        return t != null ? 'Lap time ' + t : '';
    }
    if (data.type === 'sector-completed') {
        const parts = [];
        const t = formatDuration(details.sectorTime, 3);
        if (t != null) parts.push(t);
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
    if (frame.type !== 'race-control' && shouldHideEvent(data)) return;

    const kind = frame.type === 'race-control' ? 'race-control' : 'event';
    const id   = raceEventIdentity(kind, frame, data);
    if (!rememberRaceEvent(id)) return;

    const empty = elements.eventLog.querySelector('.race-event-empty');
    if (empty) empty.remove();

    const item = document.createElement('li');
    item.className = 'race-event-item race-event-item--' + eventTone(
        kind === 'race-control' ? 'race-control' : data.type
    );

    const time = document.createElement('time');
    time.className   = 'race-event-time';
    time.dateTime    = data.timestamp || frame.timestamp || '';
    time.textContent = formatClock(data.timestamp || frame.timestamp);

    const body = document.createElement('div');

    const title = document.createElement('div');
    title.className   = 'race-event-title';
    title.textContent = kind === 'race-control' ? raceControlTitle(data) : eventTitle(data);

    const metaEl    = document.createElement('div');
    metaEl.className = 'race-event-meta';
    const metaParts = ['Race ' + data.raceId];
    if (data.teamId) metaParts.push(data.teamId);
    if (kind === 'race-control') {
        if (data.sector != null) metaParts.push(sectorFullLabel(data.sector));
        if (data.reason)         metaParts.push(prettyReason(data.reason));
    } else {
        const loc = eventLocationLabel(data);
        if (loc) metaParts.push(loc);
    }
    metaEl.textContent = metaParts.filter(Boolean).join(' | ');

    body.appendChild(title);
    body.appendChild(metaEl);

    const detailText = kind === 'race-control' ? '' : eventDetails(data);
    if (detailText) {
        const detail = document.createElement('div');
        detail.className   = 'race-event-detail';
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

// ─── Core subscriptions ───────────────────────────────────────────────────────

on('ws-status', (status) => {
    const map = {
        connecting:   ['connecting…',   'idle'],
        connected:    ['connected',     'ok'],
        error:        ['error',         'error'],
        reconnecting: ['reconnecting…', 'error'],
    };
    const [label, kind] = map[status] || ['unknown', 'idle'];
    setConnectionStatus(label, kind);
});

on('snapshot', (frame) => {
    const t    = new Date(frame.timestamp || Date.now()).getTime();
    let   cars = 0;
    for (const race of frame.races || []) cars += (race.cars || []).length;
    setSnapshotInfo(cars + ' car(s) — ' + new Date(t).toLocaleTimeString());
    if (local.selectedTeam) {
        renderCarCards(local.selectedTeam);
        renderCarStates(local.selectedTeam);
    }
});

on('state', (car) => {
    if (!local.selectedTeam || !car || car.teamId !== local.selectedTeam) return;
    refreshCarCard(car);
    renderCarStates(local.selectedTeam);
});

on('event', (frame) => {
    if (!local.selectedTeam) return;
    const data = frame && frame.data;
    if (!data || data.teamId !== local.selectedTeam) return;
    appendRaceEvent(frame);
});

on('race-control', (data, _effects) => {
    if (!local.selectedTeam) return;
    appendRaceEvent({ type: 'race-control', timestamp: data && data.timestamp, data });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function bootstrap() {
    buildTeamSelector();
    local.selectedTeam = readInitialTeam();
    applyChipActiveStyles();

    if (local.selectedTeam) {
        showContent(true);
        replayEventsForTeam(local.selectedTeam);
    } else {
        showContent(false);
    }

    connectWebSocket();
}

bootstrap();
