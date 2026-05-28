import {
    state,
    on,
    connectWebSocket,
    send,
    carKey,
    teamColor,
    flagLabel,
    humanizeToken,
    formatClock,
    formatGap,
    sectorLabel,
    sectorFullLabel,
    normalizedTrackPos,
    displayCarState,
    toneForState,
    telemetrySensorsOff,
    telemetryMetricRows,
    addCompoundBadge,
    clearRaceEventBuffer,
    STATE_CLASS,
    TRACK_SECTORS,
} from '/js/core.js?v=20260529b';

// ─── Local constants ──────────────────────────────────────────────────────────

const SVG_NS                  = 'http://www.w3.org/2000/svg';
const CIRCUIT_URL             = '/assets/monza-circuit.svg';
const DEFAULT_RACE_ID         = 1;
const RACE_TOTAL_LAPS         = 5;
const TRACK_PATH_START_OFFSET = 0.390;
const ANIMATION_MIN_DURATION  = 100;
const ANIMATION_MAX_DURATION  = 1500;
const ANIMATION_DEFAULT_INTERVAL = 500;
const SCENARIO_PROMPT_DELAY_MS = 650;

const TRACK_ANNOTATIONS = Object.freeze({
    labels: [
        { x: 176, y: 228, anchor: 'middle', lines: ['Prima Variante',    '(Rettifilo)']    },
        { x: 18,  y: 252, anchor: 'start',  lines: ['Curva Biassono',    '(Curva Grande)'] },
        { x: 50,  y: 102, anchor: 'start',  lines: ['Seconda Variante',  '(Roggia)']       },
        { x: 48,  y: 42,  anchor: 'middle', lines: ['Curve di',          'Lesmo']          },
        { x: 148, y: 62,  anchor: 'start',  lines: ['Curva del',         'Serraglio']      },
        { x: 270, y: 168, anchor: 'middle', lines: ['Variante Ascari']                      },
        { x: 488, y: 222, anchor: 'end',    lines: ['Curva',             'Parabolica']     },
    ]
});

// ─── DOM element cache ────────────────────────────────────────────────────────

const elements = {
    container:           document.getElementById('circuit-container'),
    connection:          document.getElementById('connection-status'),
    snapshot:            document.getElementById('snapshot-info'),
    legend:              document.getElementById('legend'),
    leaderboardBody:     document.getElementById('leaderboard-body'),
    flagIndicator:       document.getElementById('flag-indicator'),
    flagLabel:           document.getElementById('flag-label'),
    flagMeta:            document.getElementById('flag-meta'),
    flagEffects:         document.getElementById('flag-effect-grid'),
    raceProgressLabel:   document.getElementById('race-progress-label'),
    raceProgressPercent: document.getElementById('race-progress-percent'),
    raceProgressTrack:   document.getElementById('race-progress-track'),
    raceProgressBar:     document.getElementById('race-progress-bar'),
    scenarioModal:       document.getElementById('scenario-modal'),
    scenarioStatus:      document.getElementById('scenario-status'),
    scenarioButtons:     Array.from(document.querySelectorAll('[data-scenario]')),
    restartBtn:          document.getElementById('restart-race-btn'),
};

// ─── Local (animation + telemetry) state ─────────────────────────────────────

const local = {
    svg:              null,
    path:             null,
    pathLength:       0,
    markersLayer:     null,
    markers:          new Map(),
    lastSnapshotTime: 0,
    snapshotInterval: ANIMATION_DEFAULT_INTERVAL,
    timeOffset:       null,
    scenarioStarted:  false,
    scenarioSelectionOpen: false,
    scenarioStartPending: false,
    scenarioPromptTimer: null,
    rafHandle:        null,
    telemetryPopup:   null,
    leaderboardRows:  new Map(),
    telemetry: {
        visible:    false,
        pinned:     false,
        carKey:     null,
        anchorKind: null,
        pointerX:   0,
        pointerY:   0,
    },
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

// ─── Scenario modal ───────────────────────────────────────────────────────────

function setScenarioStatus(text) {
    if (elements.scenarioStatus) elements.scenarioStatus.textContent = text;
}

function setScenarioControlsEnabled(enabled) {
    for (const btn of elements.scenarioButtons) btn.disabled = !enabled;
}

function hideScenarioModal() {
    if (elements.scenarioModal) elements.scenarioModal.classList.add('scenario-modal--hidden');
}

function showScenarioModal() {
    if (elements.scenarioModal) elements.scenarioModal.classList.remove('scenario-modal--hidden');
}

function cancelScenarioPrompt() {
    if (!local.scenarioPromptTimer) return;
    window.clearTimeout(local.scenarioPromptTimer);
    local.scenarioPromptTimer = null;
}

function scheduleScenarioPrompt() {
    cancelScenarioPrompt();
    local.scenarioPromptTimer = window.setTimeout(() => {
        local.scenarioPromptTimer = null;
        if (!local.scenarioStarted && local.scenarioSelectionOpen && !local.scenarioStartPending) {
            showScenarioModal();
        }
    }, SCENARIO_PROMPT_DELAY_MS);
}

function showRestartButton() {
    if (elements.restartBtn) elements.restartBtn.classList.remove('restart-race-btn--hidden');
}

function hideRestartButton() {
    if (elements.restartBtn) elements.restartBtn.classList.add('restart-race-btn--hidden');
}

function stopRace() {
    send({ type: 'stop-race', raceId: DEFAULT_RACE_ID, timestamp: new Date().toISOString() });
    clearRaceEventBuffer();
    cancelScenarioPrompt();
    local.scenarioStarted = false;
    local.scenarioSelectionOpen = true;
    local.scenarioStartPending = false;
    hideRestartButton();
    setScenarioControlsEnabled(true);
    setScenarioStatus('ready');
    showScenarioModal();
}

function startScenario(scenario) {
    if (local.scenarioStarted) return;
    cancelScenarioPrompt();
    local.scenarioStarted = true;
    local.scenarioSelectionOpen = false;
    local.scenarioStartPending = true;
    setScenarioControlsEnabled(false);
    setScenarioStatus('starting race...');
    const sent = send({ type: 'start-scenario', raceId: DEFAULT_RACE_ID, scenario, timestamp: new Date().toISOString() });
    if (!sent) {
        local.scenarioStarted = false;
        local.scenarioSelectionOpen = true;
        local.scenarioStartPending = false;
        setScenarioControlsEnabled(true);
        setScenarioStatus('waiting for connection...');
        return;
    }
    window.setTimeout(hideScenarioModal, 220);
}

function bindScenarioButtons() {
    for (const btn of elements.scenarioButtons) {
        btn.addEventListener('click', () => startScenario(btn.dataset.scenario));
    }
    if (elements.restartBtn) elements.restartBtn.addEventListener('click', stopRace);
}

// ─── SVG circuit loading ──────────────────────────────────────────────────────

async function loadCircuit() {
    const response = await fetch(CIRCUIT_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('failed to load circuit svg: ' + response.status);
    elements.container.innerHTML = await response.text();

    const svg  = elements.container.querySelector('svg');
    if (!svg)  throw new Error('svg element not found in circuit asset');
    const path = svg.querySelector('path');
    if (!path) throw new Error('circuit path not found in svg');

    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const MARKER_PAD = 12;
    const vb = svg.viewBox.baseVal;
    svg.setAttribute('viewBox', [
        vb.x - MARKER_PAD, vb.y - MARKER_PAD,
        vb.width + MARKER_PAD * 2, vb.height + MARKER_PAD * 2,
    ].join(' '));

    local.svg        = svg;
    local.path       = path;
    local.pathLength = path.getTotalLength();

    renderSectorOverlay();
    renderTrackAnnotations();

    const layer = document.createElementNS(SVG_NS, 'g');
    layer.setAttribute('id', 'car-markers');
    svg.appendChild(layer);
    local.markersLayer = layer;
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
    local.svg.appendChild(layer);
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
    local.svg.appendChild(layer);
}

function sectorPolylinePoints(start, end) {
    const steps  = 56;
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = start + ((end - start) * i / steps);
        const pt = pointForTrackPos(t);
        points.push(pt.x + ',' + pt.y);
    }
    return points.join(' ');
}

// ─── Track position / marker animation ───────────────────────────────────────

function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function clampTrackPos(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return ((n % 1) + 1) % 1;
}

function unwrapTarget(prev, target) {
    let t = target;
    while (t < prev - 0.5) t += 1;
    while (t > prev + 0.5) t -= 1;
    return t;
}

function pointForTrackPos(trackPos) {
    const progress = clampTrackPos(TRACK_PATH_START_OFFSET - clampTrackPos(trackPos));
    return local.path.getPointAtLength(progress * local.pathLength);
}

function applyMarkerTransform(marker, pos) {
    const pt = pointForTrackPos(pos);
    marker.group.setAttribute('transform', 'translate(' + pt.x + ' ' + pt.y + ')');
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

    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('class', 'car-marker__label');
    lbl.textContent = String(car.carId);
    group.appendChild(lbl);

    local.markersLayer.appendChild(group);
    return { group, dot, label: lbl, teamId: car.teamId, history: [] };
}

function updateMarker(car, serverTimeMs) {
    const key    = carKey(car);
    let   marker = local.markers.get(key);
    const trackPos = clampTrackPos(car.trackPos);

    if (!marker) {
        marker = createMarker(car);
        local.markers.set(key, marker);
    }

    if (marker.teamId !== car.teamId) {
        marker.dot.setAttribute('fill', teamColor(car.teamId));
        marker.teamId = car.teamId;
    }

    const stateClasses = ['car-marker'];
    const sc = STATE_CLASS[displayCarState(car, null)];
    if (sc) stateClasses.push(sc);
    // Preserve the selected class if this marker is currently pinned
    if (marker.group.classList.contains('car-marker--selected')) stateClasses.push('car-marker--selected');
    marker.group.setAttribute('class', stateClasses.join(' '));

    const last = marker.history.length > 0 ? marker.history[marker.history.length - 1] : null;
    let pos = trackPos;
    if (last) {
        if (last.time === serverTimeMs) return;
        pos = unwrapTarget(last.pos, trackPos);
    } else {
        applyMarkerTransform(marker, pos);
    }
    marker.history.push({ time: serverTimeMs, pos });
    if (marker.history.length > 10) marker.history.shift();
}

function tickAnimation() {
    const now = performance.now();
    if (local.timeOffset == null) {
        local.rafHandle = requestAnimationFrame(tickAnimation);
        return;
    }

    const renderTime = now + local.timeOffset - 500;

    for (const marker of local.markers.values()) {
        const h = marker.history;
        if (h.length === 0) continue;

        if (h.length === 1 || renderTime <= h[0].time) {
            applyMarkerTransform(marker, h[0].pos);
            continue;
        }

        let i = h.length - 1;
        while (i > 0 && h[i].time > renderTime) i--;

        const p1 = h[i];
        const p2 = h[i + 1];

        if (p2) {
            const t = (renderTime - p1.time) / (p2.time - p1.time);
            applyMarkerTransform(marker, p1.pos + (p2.pos - p1.pos) * t);
        } else {
            const p0 = h[i - 1];
            if (p0 && (p1.time - p0.time) > 0) {
                const velocity = (p1.pos - p0.pos) / (p1.time - p0.time);
                const dt = Math.min(renderTime - p1.time, local.snapshotInterval * 2);
                applyMarkerTransform(marker, p1.pos + velocity * dt);
            } else {
                applyMarkerTransform(marker, p1.pos);
            }
        }
    }

    syncTelemetryPopupPosition();
    local.rafHandle = requestAnimationFrame(tickAnimation);
}

function ensureAnimationLoop() {
    if (local.rafHandle != null) return;
    local.rafHandle = requestAnimationFrame(tickAnimation);
}

function pruneMarkers(activeKeys) {
    for (const [key, marker] of local.markers) {
        if (!activeKeys.has(key)) {
            marker.group.remove();
            local.markers.delete(key);
            if (local.telemetry.carKey === key) hideTelemetryPopup(true);
        }
    }
}

// ─── Race control / flag rendering ───────────────────────────────────────────

function renderFlagEffects(effects) {
    if (!elements.flagEffects) return;
    elements.flagEffects.innerHTML = '';
    if (!effects) return;

    const isFinished = effects.finish === true;
    const speed = isFinished
        ? '-'
        : (Number.isFinite(Number(effects.speedMultiplier))
            ? Math.round(Number(effects.speedMultiplier) * 100) + '%'
            : 'n/a');
    const rows = [
        { label: 'Mode',     value: humanizeToken(effects.mode || 'nominal') },
        { label: 'Speed',    value: speed },
        { label: 'Overtake', value: isFinished ? '-' : (effects.overtakingAllowed === false ? 'Blocked' : 'Allowed') },
        { label: 'Race',     value: isFinished ? 'Finished' : (effects.raceSuspended ? 'Suspended' : 'Live') },
    ];
    if (effects.localSector != null) rows.push({ label: 'Sector', value: sectorLabel(effects.localSector) });

    const frag = document.createDocumentFragment();
    for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'flag-effect';
        const lbl = document.createElement('span');
        lbl.className = 'flag-effect__label';
        lbl.textContent = row.label;
        const val = document.createElement('span');
        val.className = 'flag-effect__value';
        val.textContent = row.value;
        item.appendChild(lbl);
        item.appendChild(val);
        frag.appendChild(item);
    }
    elements.flagEffects.appendChild(frag);
}

function renderFlagIndicator(flagDoc, effects) {
    if (!elements.flagIndicator || !elements.flagLabel || !elements.flagMeta) return;

    if (!flagDoc) {
        elements.flagIndicator.className = 'flag-indicator flag-indicator--idle';
        elements.flagIndicator.dataset.flag = '';
        elements.flagLabel.textContent = 'No active flag';
        elements.flagMeta.textContent  = 'waiting for race control';
        renderFlagEffects(null);
        return;
    }

    const flag   = String(flagDoc.flag || '').toUpperCase();
    const active = flagDoc.active !== false;
    const meta   = ['Race ' + flagDoc.raceId];
    if (flagDoc.sector != null) meta.push(sectorFullLabel(flagDoc.sector));
    if (flagDoc.reason) meta.push(String(flagDoc.reason));
    meta.push(formatClock(flagDoc.timestamp));

    elements.flagIndicator.className = 'flag-indicator';
    elements.flagIndicator.dataset.flag = active ? flag : '';
    elements.flagLabel.textContent = active ? flagLabel(flag) : flagLabel(flag) + ' cleared';
    elements.flagMeta.textContent  = meta.filter(Boolean).join(' | ');
    renderFlagEffects(effects);
}

// ─── Race progress ────────────────────────────────────────────────────────────

function findLeaderCar(race, classification) {
    const cars      = race && Array.isArray(race.cars) ? race.cars : [];
    if (cars.length === 0) return null;
    const standings = classification && Array.isArray(classification.standings) ? classification.standings : [];
    const leaderId  = standings.length > 0 ? Number(standings[0].carId) : null;
    if (Number.isFinite(leaderId)) {
        const found = cars.find((c) => Number(c.carId) === leaderId);
        if (found) return found;
    }
    return cars.reduce((leader, car) => {
        if (!leader) return car;
        return ((Number(car.lap) || 0) + (Number(car.trackPos) || 0)) >
               ((Number(leader.lap) || 0) + (Number(leader.trackPos) || 0)) ? car : leader;
    }, null);
}

function renderRaceProgress(race) {
    if (!elements.raceProgressLabel || !elements.raceProgressBar) return;
    const classification = race && race.classification ? race.classification : null;
    const leaderCar      = findLeaderCar(race, classification);
    const rawLeaderLap   = classification && Number.isFinite(Number(classification.leaderLap))
        ? Number(classification.leaderLap)
        : (leaderCar && Number.isFinite(Number(leaderCar.lap)) ? Number(leaderCar.lap) : null);
    const leaderTrackPos = leaderCar && Number.isFinite(Number(leaderCar.trackPos)) ? clamp01(leaderCar.trackPos) : 0;
    const progress   = rawLeaderLap == null ? 0 : clamp01((rawLeaderLap + leaderTrackPos) / RACE_TOTAL_LAPS);
    const percent    = Math.round(progress * 100);
    const currentLap = rawLeaderLap == null ? '--' : Math.min(RACE_TOTAL_LAPS, Math.max(1, Math.floor(rawLeaderLap) + 1));

    elements.raceProgressLabel.textContent   = 'Lap ' + currentLap + ' / ' + RACE_TOTAL_LAPS;
    if (elements.raceProgressPercent) elements.raceProgressPercent.textContent = percent + '%';
    elements.raceProgressBar.style.width = percent + '%';
    if (elements.raceProgressTrack) elements.raceProgressTrack.setAttribute('aria-valuenow', String(percent));
}

function renderRaceControlFromSnapshot(snapshot) {
    const races = snapshot.races || [];
    const race  = races.find((item) => item && item.flag) || races[0];
    renderFlagIndicator(race && race.flag ? race.flag : null, race ? race.effects : null);
    renderRaceProgress(race || null);
}

// ─── Legend and leaderboard ───────────────────────────────────────────────────

function renderLegend() {
    if (!elements.legend) return;
    const teams = Array.from(state.knownTeams).sort();
    elements.legend.innerHTML = '';
    for (const teamId of teams) {
        const li     = document.createElement('li');
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

function setTextIfChanged(element, text) {
    const next = String(text == null ? '' : text);
    if (element.textContent !== next) element.textContent = next;
}

function setStyleIfChanged(element, property, value) {
    const next = value || '';
    if (element.style[property] !== next) element.style[property] = next;
}

function ensureLeaderboardCell(row, index, className) {
    let cell = row.cells[index];
    if (!cell) {
        cell = document.createElement('td');
        row.appendChild(cell);
    }
    if (cell.className !== className) cell.className = className;
    return cell;
}

function renderLeaderboardRow(tr, classification, row, key) {
    if (key) {
        tr.dataset.carKey = key;
        tr.setAttribute('tabindex', '0');
        tr.setAttribute('aria-label', 'Car ' + row.carId + ' telemetry');
    }

    const latestCar = key ? state.latestCars.get(key) : null;
    const compound = row.compound || (latestCar && latestCar.compound) || '';
    const visibleState = displayCarState(
        { raceId: classification.raceId, state: row.state },
        { raceId: classification.raceId, state: row.state }
    );

    const GAP_OVERRIDE_STATES = new Set(['PIT', 'FAULT', 'RETIRED', 'FINISHED', 'SUSPENDED']);
    let gapText;
    let gapColor = '';
    if (GAP_OVERRIDE_STATES.has(visibleState)) {
        gapText = visibleState;
        if (visibleState === 'PIT' || visibleState === 'SUSPENDED') gapColor = '#fbbf24';
        else if (visibleState === 'FAULT' || visibleState === 'RETIRED') gapColor = '#f87171';
        else if (visibleState === 'FINISHED') gapColor = '#5cd39c';
    } else {
        gapText = formatGap(row.gap, row.position);
    }

    const tdPos = ensureLeaderboardCell(tr, 0, 'leaderboard-pos');
    const positionSignature = String(row.position == null ? '' : row.position);
    if (tr.dataset.positionSignature !== positionSignature) {
        tr.dataset.positionSignature = positionSignature;
        setTextIfChanged(tdPos, row.position);
    }

    const tdCar = ensureLeaderboardCell(tr, 1, 'leaderboard-car');
    const carSignature = [
        row.carId,
        row.teamId,
        teamColor(row.teamId),
    ].join('|');
    if (tr.dataset.carSignature !== carSignature) {
        tr.dataset.carSignature = carSignature;
        tdCar.replaceChildren();
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = teamColor(row.teamId);
        const name = document.createElement('span');
        name.className = 'leaderboard-car__number';
        name.textContent = '#' + row.carId;
        const entry = document.createElement('span');
        entry.className = 'leaderboard-car__entry';
        entry.appendChild(swatch);
        entry.appendChild(name);
        tdCar.appendChild(entry);
    }

    const tdGap = ensureLeaderboardCell(tr, 2, 'leaderboard-gap');
    const gapSignature = [gapText, gapColor].join('|');
    if (tr.dataset.gapSignature !== gapSignature) {
        tr.dataset.gapSignature = gapSignature;
        setTextIfChanged(tdGap, gapText);
        setStyleIfChanged(tdGap, 'color', gapColor);
    }

    const tdTyre = ensureLeaderboardCell(tr, 3, 'leaderboard-tyre');
    const tyreSignature = String(compound || '');
    if (tr.dataset.tyreSignature !== tyreSignature) {
        tr.dataset.tyreSignature = tyreSignature;
        tdTyre.replaceChildren();
        addCompoundBadge(tdTyre, compound, true);
    }
}

function renderClassification(classification) {
    if (!classification || !classification.standings || !elements.leaderboardBody) return;

    const desiredRows = [];
    const activeKeys = new Set();
    for (const row of classification.standings) {
        const key = (classification.raceId != null && row.carId != null)
            ? classification.raceId + ':' + row.carId
            : null;

        const tr = key && local.leaderboardRows.has(key)
            ? local.leaderboardRows.get(key)
            : document.createElement('tr');

        if (key) {
            activeKeys.add(key);
            local.leaderboardRows.set(key, tr);
        }

        renderLeaderboardRow(tr, classification, row, key);
        desiredRows.push(tr);
    }

    for (const [key, row] of local.leaderboardRows) {
        if (!activeKeys.has(key)) {
            row.remove();
            local.leaderboardRows.delete(key);
        }
    }

    const desiredSet = new Set(desiredRows);
    for (const row of Array.from(elements.leaderboardBody.children)) {
        if (!desiredSet.has(row)) row.remove();
    }

    let cursor = elements.leaderboardBody.firstElementChild;
    for (const row of desiredRows) {
        if (row === cursor) {
            cursor = cursor.nextElementSibling;
        } else {
            elements.leaderboardBody.insertBefore(row, cursor);
        }
    }

    refreshTelemetryPopup();
}

// ─── Snapshot handler ─────────────────────────────────────────────────────────

function renderSnapshot(frame) {
    const now                = performance.now();
    const snapshotServerTime = new Date(frame.timestamp || Date.now()).getTime();

    if (local.timeOffset == null) local.timeOffset = snapshotServerTime - now;

    if (local.lastSnapshotTime) {
        const observed = now - local.lastSnapshotTime;
        if (observed >= ANIMATION_MIN_DURATION && observed <= ANIMATION_MAX_DURATION) {
            local.snapshotInterval = local.snapshotInterval * 0.6 + observed * 0.4;
        }
    }
    local.lastSnapshotTime = now;

    const activeKeys = new Set();
    let   totalCars  = 0;

    const raceActive = (frame.races || []).some((r) =>
        Array.isArray(r.cars) && r.cars.some((car) => {
            const s = String(car.state || '').toUpperCase();
            return s !== 'FINISHED' && s !== 'RETIRED';
        })
    );
    if (raceActive) {
        cancelScenarioPrompt();
        local.scenarioStarted = true;
        local.scenarioSelectionOpen = false;
        local.scenarioStartPending = false;
        hideScenarioModal();
        hideRestartButton();
    } else if (local.scenarioSelectionOpen) {
        cancelScenarioPrompt();
        local.scenarioStarted = false;
        showScenarioModal();
        hideRestartButton();
    } else if (local.scenarioStartPending) {
        cancelScenarioPrompt();
        local.scenarioStarted = true;
        hideScenarioModal();
        hideRestartButton();
    } else if (allCarsFinished(frame)) {
        cancelScenarioPrompt();
        local.scenarioStarted = true;
        hideScenarioModal();
        showRestartButton();
    } else if (!local.scenarioStarted) {
        cancelScenarioPrompt();
        showScenarioModal();
    }

    renderRaceControlFromSnapshot(frame);

    for (const race of frame.races || []) {
        if (race.classification) renderClassification(race.classification);

        for (const car of race.cars || []) {
            if (car.carId == null || car.trackPos == null) continue;
            const carTime = new Date(car.timestamp || frame.timestamp || Date.now()).getTime();
            updateMarker(car, carTime);
            activeKeys.add(carKey(car));
            totalCars += 1;
        }
    }

    renderLegend();
    pruneMarkers(activeKeys);
    ensureAnimationLoop();
    refreshTelemetryPopup();
    setSnapshotInfo(totalCars + ' car(s) — ' + new Date(snapshotServerTime).toLocaleTimeString());
}

// ─── Telemetry popup ──────────────────────────────────────────────────────────

function ensureTelemetryPopup() {
    if (local.telemetryPopup) return local.telemetryPopup;
    const popup = document.createElement('div');
    popup.className = 'telemetry-popup telemetry-popup--hidden';
    popup.setAttribute('role', 'status');
    document.body.appendChild(popup);
    local.telemetryPopup = popup;
    return popup;
}

function addTelemetryChip(container, text, tone) {
    if (!text) return;
    const chip = document.createElement('span');
    chip.className   = 'telemetry-popup__chip telemetry-value--' + (tone || 'muted');
    chip.textContent = text;
    container.appendChild(chip);
}

function addTelemetryMetric(container, labelText, valueText, tone) {
    const item = document.createElement('div');
    item.className = 'telemetry-metric';
    const lbl = document.createElement('span');
    lbl.className   = 'telemetry-metric__label';
    lbl.textContent = labelText;
    const val = document.createElement('span');
    val.className   = 'telemetry-metric__value telemetry-value--' + (tone || 'muted');
    val.textContent = valueText || '--';
    item.appendChild(lbl);
    item.appendChild(val);
    container.appendChild(item);
}

function renderTelemetryPopupContent(key) {
    const car      = state.latestCars.get(key) || {};
    const standing = state.latestStandings.get(key) || {};
    const carId    = car.carId != null ? car.carId : standing.carId;
    if (carId == null) return false;

    const popup = ensureTelemetryPopup();
    popup.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'telemetry-popup__head';
    const identity = document.createElement('div');
    identity.className = 'telemetry-popup__identity';
    const carLabel = document.createElement('div');
    carLabel.className   = 'telemetry-popup__car';
    carLabel.textContent = '#' + carId;
    const team = document.createElement('div');
    team.className   = 'telemetry-popup__team';
    team.textContent = car.teamId || standing.teamId || 'unknown';
    identity.appendChild(carLabel);
    identity.appendChild(team);
    head.appendChild(identity);
    const stateEl = document.createElement('span');
    const visibleState = displayCarState(car, standing);
    stateEl.className   = 'telemetry-popup__state telemetry-value--' + toneForState(visibleState);
    stateEl.textContent = visibleState;
    head.appendChild(stateEl);
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

function findLeaderboardRow(key) {
    if (!elements.leaderboardBody) return null;
    for (const row of elements.leaderboardBody.querySelectorAll('[data-car-key]')) {
        if (row.dataset.carKey === key) return row;
    }
    return null;
}

function closestMarkerElement(target) {
    let node = target;
    while (node && node !== local.markersLayer) {
        if (node.classList && node.classList.contains('car-marker')) return node;
        node = node.parentNode;
    }
    return null;
}

function closestLeaderboardRow(target) {
    return (target && target.closest) ? target.closest('tr[data-car-key]') : null;
}

function telemetryPopupBounds(anchorKind) {
    const margin = 8;
    if (anchorKind === 'marker' && elements.container) {
        const panel = elements.container.closest('.circuit-panel') || elements.container;
        const rect = panel.getBoundingClientRect();
        return {
            left:   Math.max(margin, rect.left + margin),
            top:    Math.max(margin, rect.top + margin),
            right:  Math.min(window.innerWidth - margin, rect.right - margin),
            bottom: Math.min(window.innerHeight - margin, rect.bottom - margin),
        };
    }
    return {
        left:   margin,
        top:    margin,
        right:  window.innerWidth - margin,
        bottom: window.innerHeight - margin,
    };
}

function placeTelemetryPopup(x, y, preferLeft, verticalAlign, anchorKind) {
    const popup  = ensureTelemetryPopup();
    const gap    = 12;
    const bounds = telemetryPopupBounds(anchorKind);
    const boundsWidth = Math.max(0, bounds.right - bounds.left);
    const boundsHeight = Math.max(0, bounds.bottom - bounds.top);

    popup.style.maxWidth = boundsWidth ? boundsWidth + 'px' : '';
    popup.style.maxHeight = boundsHeight ? boundsHeight + 'px' : '';

    const rect   = popup.getBoundingClientRect();
    let left = preferLeft ? x - rect.width - gap : x + gap;
    let top  = verticalAlign === 'center' ? y - rect.height / 2 : y + gap;

    if (!preferLeft && left + rect.width > bounds.right) left = x - rect.width - gap;
    if ( preferLeft && left < bounds.left) left = x + gap;

    const maxLeft = Math.max(bounds.left, bounds.right - rect.width);
    left = Math.min(Math.max(left, bounds.left), maxLeft);

    if (verticalAlign !== 'center' && top + rect.height > bounds.bottom) top = y - rect.height - gap;

    const maxTop = Math.max(bounds.top, bounds.bottom - rect.height);
    top = Math.min(Math.max(top, bounds.top), maxTop);

    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
}

function syncTelemetryPopupPosition() {
    if (!local.telemetry.visible) return;
    let x = local.telemetry.pointerX;
    let y = local.telemetry.pointerY;
    let preferLeft = false;
    let verticalAlign = 'below';

    if (local.telemetry.anchorKind === 'marker') {
        const marker = local.markers.get(local.telemetry.carKey);
        if (marker) {
            const rect = marker.group.getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.top  + rect.height / 2;
        }
    } else if (local.telemetry.anchorKind === 'leaderboard') {
        const row = findLeaderboardRow(local.telemetry.carKey);
        if (row) {
            const rect = row.getBoundingClientRect();
            x = rect.left;
            y = rect.top + rect.height / 2;
            preferLeft = true;
            verticalAlign = 'center';
        }
    }
    placeTelemetryPopup(x, y, preferLeft, verticalAlign, local.telemetry.anchorKind);
}

function showTelemetryPopup(key, anchorKind, event, pinned) {
    if (!key) return;
    if (!pinned && local.telemetry.pinned) return;
    if (!renderTelemetryPopupContent(key)) return;

    // Update car-marker--selected class
    if (pinned) {
        // Clear from previously selected marker
        if (local.telemetry.carKey && local.telemetry.carKey !== key) {
            const prev = local.markers.get(local.telemetry.carKey);
            if (prev) prev.group.classList.remove('car-marker--selected');
        }
        const next = local.markers.get(key);
        if (next) next.group.classList.add('car-marker--selected');
    }

    const popup = ensureTelemetryPopup();
    popup.className = 'telemetry-popup' + (pinned ? ' telemetry-popup--pinned' : '');
    local.telemetry.visible    = true;
    local.telemetry.pinned     = !!pinned;
    local.telemetry.carKey     = key;
    local.telemetry.anchorKind = anchorKind;
    if (event) {
        local.telemetry.pointerX = event.clientX;
        local.telemetry.pointerY = event.clientY;
    }
    syncTelemetryPopupPosition();
}

function refreshTelemetryPopup() {
    if (!local.telemetry.visible) return;
    if (!renderTelemetryPopupContent(local.telemetry.carKey)) { hideTelemetryPopup(true); return; }
    syncTelemetryPopupPosition();
}

function hideTelemetryPopup(force) {
    if (!force && local.telemetry.pinned) return;
    // Remove selected class from the currently pinned marker
    if (local.telemetry.carKey) {
        const m = local.markers.get(local.telemetry.carKey);
        if (m) m.group.classList.remove('car-marker--selected');
    }
    const popup = ensureTelemetryPopup();
    popup.className = 'telemetry-popup telemetry-popup--hidden';
    local.telemetry.visible    = false;
    local.telemetry.pinned     = false;
    local.telemetry.carKey     = null;
    local.telemetry.anchorKind = null;
}

function togglePinnedTelemetry(key, anchorKind, event) {
    if (local.telemetry.pinned && local.telemetry.carKey === key) { hideTelemetryPopup(true); return; }
    showTelemetryPopup(key, anchorKind, event, true);
}

function isActivationKey(event) {
    return event.key === 'Enter' || event.key === ' ';
}

function bindTelemetryInteractions() {
    if (local.markersLayer) {
        local.markersLayer.addEventListener('pointerover', (e) => {
            const m = closestMarkerElement(e.target);
            if (!m || m.contains(e.relatedTarget)) return;
            if (!local.telemetry.pinned) showTelemetryPopup(m.dataset.carKey, 'marker', e, false);
        });
        local.markersLayer.addEventListener('pointermove', (e) => {
            if (!local.telemetry.visible || local.telemetry.pinned) return;
            local.telemetry.pointerX = e.clientX;
            local.telemetry.pointerY = e.clientY;
            syncTelemetryPopupPosition();
        });
        local.markersLayer.addEventListener('pointerout', (e) => {
            const m = closestMarkerElement(e.target);
            if (!m || m.contains(e.relatedTarget)) return;
            if (local.telemetry.carKey === m.dataset.carKey) hideTelemetryPopup(false);
        });
        local.markersLayer.addEventListener('click', (e) => {
            const m = closestMarkerElement(e.target);
            if (!m) return;
            e.stopPropagation();
            togglePinnedTelemetry(m.dataset.carKey, 'marker', e);
        });
        local.markersLayer.addEventListener('focusin', (e) => {
            const m = closestMarkerElement(e.target);
            if (!m) return;
            if (!local.telemetry.pinned) showTelemetryPopup(m.dataset.carKey, 'marker', e, false);
        });
        local.markersLayer.addEventListener('focusout', (e) => {
            const m = closestMarkerElement(e.target);
            if (!m || m.contains(e.relatedTarget)) return;
            if (local.telemetry.carKey === m.dataset.carKey) hideTelemetryPopup(false);
        });
        local.markersLayer.addEventListener('keydown', (e) => {
            if (!isActivationKey(e)) return;
            const m = closestMarkerElement(e.target);
            if (!m) return;
            e.preventDefault(); e.stopPropagation();
            togglePinnedTelemetry(m.dataset.carKey, 'marker', e);
        });
    }

    if (elements.leaderboardBody) {
        elements.leaderboardBody.addEventListener('pointerover', (e) => {
            const row = closestLeaderboardRow(e.target);
            if (!row || row.contains(e.relatedTarget)) return;
            if (!local.telemetry.pinned) showTelemetryPopup(row.dataset.carKey, 'leaderboard', e, false);
        });
        elements.leaderboardBody.addEventListener('pointermove', (e) => {
            if (!local.telemetry.visible || local.telemetry.pinned) return;
            local.telemetry.pointerX = e.clientX;
            local.telemetry.pointerY = e.clientY;
            syncTelemetryPopupPosition();
        });
        elements.leaderboardBody.addEventListener('pointerout', (e) => {
            const row = closestLeaderboardRow(e.target);
            if (!row || row.contains(e.relatedTarget)) return;
            if (local.telemetry.carKey === row.dataset.carKey) hideTelemetryPopup(false);
        });
        elements.leaderboardBody.addEventListener('click', (e) => {
            const row = closestLeaderboardRow(e.target);
            if (!row) return;
            e.stopPropagation();
            togglePinnedTelemetry(row.dataset.carKey, 'leaderboard', e);
        });
        elements.leaderboardBody.addEventListener('focusin', (e) => {
            const row = closestLeaderboardRow(e.target);
            if (!row) return;
            if (!local.telemetry.pinned) showTelemetryPopup(row.dataset.carKey, 'leaderboard', e, false);
        });
        elements.leaderboardBody.addEventListener('focusout', (e) => {
            const row = closestLeaderboardRow(e.target);
            if (!row || row.contains(e.relatedTarget)) return;
            if (local.telemetry.carKey === row.dataset.carKey) hideTelemetryPopup(false);
        });
        elements.leaderboardBody.addEventListener('keydown', (e) => {
            if (!isActivationKey(e)) return;
            const row = closestLeaderboardRow(e.target);
            if (!row) return;
            e.preventDefault(); e.stopPropagation();
            togglePinnedTelemetry(row.dataset.carKey, 'leaderboard', e);
        });
    }

    document.addEventListener('click', () => hideTelemetryPopup(true));
    window.addEventListener('resize', refreshTelemetryPopup);
}

// ─── Race-finished detection ──────────────────────────────────────────────────

function allCarsFinished(frame) {
    const allCars = (frame.races || []).flatMap((r) => r.cars || []);
    if (allCars.length === 0) return false;
    return allCars.every((car) => {
        const s = String(car.state || '').toUpperCase();
        return s === 'FINISHED' || s === 'RETIRED';
    });
}

// ─── Core event subscriptions ─────────────────────────────────────────────────

on('ws-status', (status) => {
    const map = {
        connecting:   ['connecting…',   'idle'],
        connected:    ['connected',     'ok'],
        error:        ['error',         'error'],
        reconnecting: ['reconnecting…', 'error'],
    };
    const [label, kind] = map[status] || ['unknown', 'idle'];
    setConnectionStatus(label, kind);

    if (status === 'connected' && !local.scenarioStarted) {
        local.scenarioSelectionOpen = true;
        local.scenarioStartPending = false;
        setScenarioControlsEnabled(true);
        setScenarioStatus('ready');
        scheduleScenarioPrompt();
    } else if ((status === 'error' || status === 'reconnecting') && !local.scenarioStarted) {
        cancelScenarioPrompt();
        local.scenarioSelectionOpen = true;
        setScenarioControlsEnabled(false);
        if (status === 'reconnecting') setScenarioStatus('reconnecting...');
        showScenarioModal();
    }
});

on('snapshot',       (frame)         => renderSnapshot(frame));
on('classification', (data)          => renderClassification(data));
on('state',          ()              => refreshTelemetryPopup());
on('race-control',   (data, effects) => {
    renderFlagIndicator(data, effects);
    refreshTelemetryPopup();
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
    if (elements.container) {
        try {
            await loadCircuit();
        } catch (err) {
            console.error(err);
            setSnapshotInfo('failed to load circuit: ' + err.message);
            return;
        }
        bindTelemetryInteractions();
    }
    bindScenarioButtons();
    connectWebSocket();
}

bootstrap();
