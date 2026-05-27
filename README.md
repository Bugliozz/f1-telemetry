# F1 Telemetry System

Real-time distributed telemetry simulation for a Formula 1 race at Monza, built with Node-RED, MQTT (Eclipse Mosquitto) and MongoDB.

## Architecture

```
simulator ──MQTT──► mosquitto ──MQTT──► node-red ──► mongodb
                       │                   │
                   WebSocket           dashboard
                  (port 9002)         (port 1881)
```

| Component | Image / Build | Port (host) | Role |
|-----------|--------------|-------------|------|
| mosquitto | `eclipse-mosquitto:2.0.18` | 1884 (MQTT), 9002 (WS) | Message broker |
| mongodb | `mongo:7.0` | 27018 | Persistence |
| node-red | `./node-red` | 1881 | Processing & dashboard |
| simulator | `./simulator` | — | Race data source |

**10 cars**, 5 teams, telemetry at 2–5 Hz. Race control events (Safety Car, VSC, flags) broadcast to all cars in real time.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) ≥ 24
- `docker compose` v2 (included in Docker Desktop)
- `openssl` (to generate the encryption key — available on macOS/Linux; on Windows use Git Bash or WSL)

## Quick Start

### 1. Clone

```bash
git clone <repo-url>
cd f1-telemetry
```

### 2. Create the environment file

```bash
cp .env.example .env.delivery
```

Then edit `.env.delivery` and fill in the two variables:

```env
# 32 random bytes encoded in base64 (used for AES-256-GCM flag encryption)
F1_TELEMETRY_CRYPTO_KEY_B64=$(openssl rand -base64 32)

# Secret used by Node-RED to encrypt its credentials file
NODE_RED_CREDENTIAL_SECRET=choose-any-long-random-string
```

> **Windows (PowerShell):** run `openssl rand -base64 32` in Git Bash or WSL to get the key.

### 3. Start everything

```bash
docker compose up --build
```

All four services start in dependency order (Mosquitto and MongoDB come up first, then Node-RED and the simulator).

To run in the background:

```bash
docker compose up --build -d
```

### 4. Open the dashboard

| URL | Description |
|-----|-------------|
| <http://localhost:1881/dashboard> | Race dashboard (Monza track, live car positions) |
| <http://localhost:1881> | Node-RED editor |

### 5. Stop

```bash
docker compose down
```

To also remove persistent volumes (MongoDB data, Mosquitto logs):

```bash
docker compose down -v
```

## MQTT Topic Structure

```
f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/telemetry
f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/state
f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/events
f1/simulation/{raceId}/race-control/flags
f1/simulation/{raceId}/race-control/classification
f1/simulation/{raceId}/secure/race-control/flags   ← AES-256-GCM encrypted
```

Connect any MQTT client to `localhost:1884` to inspect live traffic:

```bash
mosquitto_sub -h localhost -p 1884 -t "f1/#" -v
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `F1_TELEMETRY_CRYPTO_KEY_B64` | Base64-encoded 32-byte key for AES-256-GCM flag encryption |
| `NODE_RED_CREDENTIAL_SECRET` | Node-RED credential store secret |

Simulator behaviour can be tuned via the `environment` section in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TOTAL_LAPS` | `5` | Number of laps per race |
| `TICK_MS` | `250` | Simulation tick interval (ms) |
| `RACE_ID` | `1` | Race identifier |
| `RESET_RACE_ON_START` | `true` | Clear previous race data on startup |
| `LOG_LEVEL` | `info` | Simulator log verbosity |

## Car State Machine

```
INIT → RUNNING → PIT → RUNNING
              ↓
           FAULT → RETIRED
              ↓
           FINISHED
```

## Project Structure

```
f1-telemetry/
├── docker-compose.yml
├── .env.example            ← template — copy to .env.delivery
├── mosquitto/
│   └── config/             ← mosquitto.conf, acl.conf
├── mongo/
│   └── init/               ← DB initialisation scripts
├── node-red/
│   ├── Dockerfile
│   └── data/
│       ├── flows.json      ← Node-RED flows
│       └── public/         ← dashboard static assets
├── simulator/              ← Node.js race simulator
│   ├── Dockerfile
│   ├── index.js
│   └── scripts/            ← test & utility scripts
└── schemas/                ← JSON schemas for MQTT payloads
```

## Troubleshooting

**Services fail to start** — check that ports 1881, 1884, 9002, 27018 are free on the host.

**Node-RED shows "flows paused"** — open the editor at `http://localhost:1881`, click Deploy, then restart the simulator container:
```bash
docker compose restart simulator
```

**Crypto key error** — ensure `F1_TELEMETRY_CRYPTO_KEY_B64` decodes to exactly 32 bytes:
```bash
echo "<your-key>" | base64 -d | wc -c   # must print 32
```

**Reset race state** — stop all containers, then restart:
```bash
docker compose down && docker compose up -d
```
