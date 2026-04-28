(() => {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CIRCUIT_URL = 'assets/monza-circuit.svg';
    const WS_PATH = '/api/ws/f1';

    // Smooth-movement tuning. Each marker is animated from its previous rendered
    // position to the latest target trackPos over `segmentDuration` ms, where
    // segmentDuration is an EMA of observed inter-snapshot intervals. Clamp to
    // a sensible band so a stalled stream doesn't make cars crawl forever and
    // a burst doesn't produce visible teleporting.
    const ANIMATION_DEFAULT_DURATION = 500;
    const ANIMATION_MIN_DURATION = 100;
    const ANIMATION_MAX_DURATION = 1500;
    const ANIMATION_INTERVAL_EMA_ALPHA = 0.4;
    // Stretch the segment past the observed interval so the marker doesn't
    // reach `targetPos` before the next snapshot arrives — without this,
    // network/rAF jitter causes a visible micro-stall every snapshot.
    const ANIMATION_SEGMENT_FACTOR = 1.3;
    // Allow a bit of extrapolation past t=1 if a snapshot is late, so motion
    // stays continuous instead of freezing at the previous target.
    const ANIMATION_OVERSHOOT_CAP = 1.5;

    const TEAM_COLORS = Object.freeze({
        ferrari:  '#dc0000',
        mercedes: '#27f4d2',
        redbull:  '#1e41ff',
        mclaren:  '#ff8000',
        alpine:   '#0090ff'
    });
    const FALLBACK_COLOR = '#9ca3af';

    const STATE_CLASS = Object.freeze({
        PIT:      'car-marker--pit',
        FAULT:    'car-marker--fault',
        RETIRED:  'car-marker--retired',
        FINISHED: 'car-marker--finished'
    });

    const elements = {
        container: document.getElementById('circuit-container'),
        connection: document.getElementById('connection-status'),
        snapshot: document.getElementById('snapshot-info'),
        legend: document.getElementById('legend')
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
        rafHandle: null
    };

    function setConnectionStatus(label, kind) {
        elements.connection.textContent = label;
        elements.connection.className = 'status-pill status-pill--' + kind;
    }

    function setSnapshotInfo(text) {
        elements.snapshot.textContent = text;
    }

    function teamColor(teamId) {
        return TEAM_COLORS[teamId] || FALLBACK_COLOR;
    }

    function carKey(car) {
        return car.raceId + ':' + car.carId;
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

        const layer = document.createElementNS(SVG_NS, 'g');
        layer.setAttribute('id', 'car-markers');
        svg.appendChild(layer);

        state.svg = svg;
        state.path = path;
        state.pathLength = path.getTotalLength();
        state.markersLayer = layer;
    }

    function createMarker(car) {
        const group = document.createElementNS(SVG_NS, 'g');
        group.setAttribute('class', 'car-marker');
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

        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = (car.teamId || '?') + ' #' + car.carId;
        group.appendChild(title);

        state.markersLayer.appendChild(group);
        return {
            group,
            dot,
            label,
            teamId: car.teamId,
            prevPos: 0,
            targetPos: 0,
            renderedPos: 0,
            segmentStart: 0,
            segmentDuration: ANIMATION_DEFAULT_DURATION
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

    function applyMarkerTransform(marker, pos) {
        const wrapped = ((pos % 1) + 1) % 1;
        const point = state.path.getPointAtLength(wrapped * state.pathLength);
        marker.group.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
    }

    function updateMarker(car, now, segmentDuration) {
        const key = carKey(car);
        let marker = state.markers.get(key);
        const trackPos = clampTrackPos(car.trackPos);

        if (!marker) {
            marker = createMarker(car);
            marker.prevPos = trackPos;
            marker.targetPos = trackPos;
            marker.renderedPos = trackPos;
            marker.segmentStart = now;
            marker.segmentDuration = segmentDuration;
            state.markers.set(key, marker);
            applyMarkerTransform(marker, trackPos);
        } else {
            // Start the next segment from where we are right now (not from the
            // previous target) so frame drops or out-of-band pauses don't
            // leave the marker behind when a fresh snapshot lands.
            marker.prevPos = marker.renderedPos;
            marker.targetPos = unwrapTarget(marker.renderedPos, trackPos);
            marker.segmentStart = now;
            marker.segmentDuration = segmentDuration;
        }

        if (marker.teamId !== car.teamId) {
            marker.dot.setAttribute('fill', teamColor(car.teamId));
            marker.teamId = car.teamId;
        }

        const stateClasses = ['car-marker'];
        const stateClass = STATE_CLASS[car.state];
        if (stateClass) stateClasses.push(stateClass);
        marker.group.setAttribute('class', stateClasses.join(' '));

        if (car.teamId && !state.knownTeams.has(car.teamId)) {
            state.knownTeams.add(car.teamId);
            renderLegend();
        }
    }

    function tickAnimation() {
        const now = performance.now();
        for (const marker of state.markers.values()) {
            const duration = Math.max(1, marker.segmentDuration);
            const raw = (now - marker.segmentStart) / duration;
            const t = Math.min(ANIMATION_OVERSHOOT_CAP, Math.max(0, raw));
            const pos = marker.prevPos + (marker.targetPos - marker.prevPos) * t;
            if (pos !== marker.renderedPos) {
                marker.renderedPos = pos;
                applyMarkerTransform(marker, pos);
            }
        }
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
            }
        }
    }

    function renderSnapshot(snapshot) {
        const now = performance.now();

        if (state.lastSnapshotTime) {
            const observed = now - state.lastSnapshotTime;
            if (observed >= ANIMATION_MIN_DURATION && observed <= ANIMATION_MAX_DURATION) {
                state.snapshotInterval =
                    state.snapshotInterval * (1 - ANIMATION_INTERVAL_EMA_ALPHA) +
                    observed * ANIMATION_INTERVAL_EMA_ALPHA;
            }
        }
        state.lastSnapshotTime = now;
        const segmentDuration = state.snapshotInterval * ANIMATION_SEGMENT_FACTOR;

        const activeKeys = new Set();
        let totalCars = 0;

        for (const race of snapshot.races || []) {
            for (const car of race.cars || []) {
                if (car.carId == null || car.trackPos == null) continue;
                updateMarker(car, now, segmentDuration);
                activeKeys.add(carKey(car));
                totalCars += 1;
            }
        }

        pruneMarkers(activeKeys);
        ensureAnimationLoop();
        setSnapshotInfo(totalCars + ' car(s) — ' + new Date(snapshot.timestamp || Date.now()).toLocaleTimeString());
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
        }
    }

    function connectWebSocket() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = proto + '//' + window.location.host + WS_PATH;

        setConnectionStatus('connecting…', 'idle');
        const socket = new WebSocket(url);

        socket.addEventListener('open', () => setConnectionStatus('connected', 'ok'));
        socket.addEventListener('message', (event) => handleFrame(event.data));
        socket.addEventListener('error', () => setConnectionStatus('error', 'error'));
        socket.addEventListener('close', () => {
            setConnectionStatus('reconnecting…', 'error');
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
        connectWebSocket();
    }

    bootstrap();
})();
