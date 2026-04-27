# 📡 Struttura MQTT — F1 Telemetry

Documento di riferimento per la **Fase 1** del piano di implementazione.
Definisce l'albero dei topic, gli esempi di payload JSON e la policy di QoS/retain.

> Gli schemi di payload riportati qui sono **illustrativi**. Lo schema
> definitivo (con tutti i campi obbligatori e i loro tipi) verrà
> formalizzato nella **Fase 2 — Data Model**.

---

## 1. Convenzioni generali

- **Encoding payload:** JSON UTF-8.
- **Timestamp:** ISO-8601 con millisecondi e fuso `Z` (UTC).
  Esempio: `"2026-04-27T14:32:10.512Z"`.
- **Identificatori:**
  - `raceId` → numerico (es. `1`, `2`); univoco per ogni gara simulata.
  - `teamId` → slug minuscolo del team (es. `ferrari`, `mercedes`).
  - `carId` → numero macchina (es. `16`, `44`).
- **Naming dei topic:** kebab-case in minuscolo, senza spazi.
- **Wildcards consentite ai subscriber:** `+` (single level), `#` (multi level).

---

## 2. Albero dei topic

```
f1/
└── simulation/
    └── {raceId}/
        ├── teams/
        │   └── {teamId}/
        │       └── cars/
        │           └── {carId}/
        │               ├── telemetry   ← stream continuo (2–5 Hz)
        │               ├── state       ← snapshot FSM (retained)
        │               └── events      ← eventi discreti (pit, fault…)
        └── race-control/
            ├── flags             ← bandiere globali (retained)
            └── classification    ← classifica live (retained)
```

### Tabella riassuntiva

| Pattern topic | Direzione | Frequenza | QoS | Retained |
|---|---|---|---|---|
| `f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/telemetry` | simulator → broker | 2–5 Hz | **0** | no |
| `f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/state` | simulator → broker | on-change | **1** | **sì** |
| `f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/events` | simulator → broker | on-event | **1** | no |
| `f1/simulation/{raceId}/race-control/flags` | race-control → broker | on-change | **1** | **sì** |
| `f1/simulation/{raceId}/race-control/classification` | Node-RED → broker | 1 Hz | **1** | **sì** |

---

## 3. Policy di QoS — motivazioni

| QoS | Significato MQTT | Uso nel progetto |
|---|---|---|
| **0 — at most once** | Best-effort, può perdere messaggi. Latenza minima. | Telemetria ad alta frequenza: la perdita di un singolo campione è irrilevante (il successivo arriva entro 200–500 ms). |
| **1 — at least once** | Almeno una consegna, possibili duplicati. | Stati FSM, eventi car-level, flag di gara, classifica: ogni evento è "load-bearing" e non può essere perso; eventuali duplicati sono filtrabili lato consumer (Node-RED). |
| **2 — exactly once** | Costoso (4-way handshake). | **Non usato.** Il guadagno rispetto a QoS 1 non giustifica l'overhead per il throughput target (10 auto × 5 Hz). |

### Retained — quando e perché

- `state` e `flags` sono **retained**: un subscriber che si collega in
  ritardo (es. dashboard riavviata a metà gara) riceve immediatamente
  l'ultimo valore e non aspetta il prossimo cambio di stato.
- `classification` è **retained** così la dashboard mostra subito la
  classifica corrente al collegamento.
- `telemetry` ed `events` **non** sono retained: lo stream continuo
  rende inutile mantenere l'ultimo valore (telemetry) e gli eventi
  passati appartengono già allo storico su MongoDB (events).

---

## 4. Esempi di payload

### 4.1 Telemetria — `…/cars/{carId}/telemetry`

```json
{
  "timestamp": "2026-04-27T14:32:10.512Z",
  "raceId": 1,
  "teamId": "ferrari",
  "carId": 16,
  "lap": 12,
  "trackPos": 0.4731,
  "speed": 287.4,
  "rpm": 11800,
  "gear": 7,
  "throttle": 0.92,
  "brake": 0.0,
  "drs": true,
  "tireTemp": {
    "fl": 102.1, "fr": 99.8,
    "rl": 105.3, "rr": 104.7
  },
  "fuel": 38.2
}
```

| Campo | Tipo | Note |
|---|---|---|
| `trackPos` | `float [0,1]` | posizione normalizzata sul giro corrente |
| `speed` | `float` | km/h |
| `rpm` | `int` | giri motore |
| `gear` | `int [0..8]` | 0 = folle, 8 = retro |
| `throttle`, `brake` | `float [0,1]` | input pedali |
| `drs` | `bool` | DRS attivo (sensore digitale) |
| `tireTemp.{fl,fr,rl,rr}` | `float` | °C per ogni gomma |
| `fuel` | `float` | kg residui |

### 4.2 Stato auto — `…/cars/{carId}/state`

```json
{
  "timestamp": "2026-04-27T14:35:01.000Z",
  "raceId": 1,
  "teamId": "ferrari",
  "carId": 16,
  "state": "PIT",
  "previousState": "RUNNING",
  "reason": "low-fuel"
}
```

Valori di `state` (FSM definita in Fase 3):
`INIT` · `RUNNING` · `PIT` · `FAULT` · `RETIRED` · `FINISHED`

### 4.3 Evento auto — `…/cars/{carId}/events`

```json
{
  "timestamp": "2026-04-27T14:35:07.221Z",
  "raceId": 1,
  "teamId": "ferrari",
  "carId": 16,
  "type": "pit-stop",
  "details": {
    "duration": 2.4,
    "tyreCompound": "soft",
    "fuelAdded": 25.0
  }
}
```

Valori comuni di `type`: `pit-entry`, `pit-stop`, `pit-exit`, `fault`,
`retirement`, `lap-completed`, `sector-completed`, `overtake`.

### 4.4 Flag di gara — `…/race-control/flags`

```json
{
  "timestamp": "2026-04-27T14:40:12.000Z",
  "raceId": 1,
  "flag": "SC",
  "active": true,
  "sector": null,
  "reason": "debris on track"
}
```

Valori di `flag`: `GREEN` · `YELLOW` · `RED` · `CHECKERED` · `SC` · `VSC`.
Quando una flag torna a `GREEN` il messaggio precedente viene
sovrascritto (retained), quindi i subscriber vedono sempre lo stato
corrente di gara.

### 4.5 Classifica — `…/race-control/classification`

```json
{
  "timestamp": "2026-04-27T14:42:00.000Z",
  "raceId": 1,
  "lap": 14,
  "leaderLap": 14,
  "standings": [
    { "position": 1, "carId": 16, "teamId": "ferrari",  "lap": 14, "gap": 0.000 },
    { "position": 2, "carId": 44, "teamId": "mercedes", "lap": 14, "gap": 1.327 },
    { "position": 3, "carId": 1,  "teamId": "redbull",  "lap": 14, "gap": 4.118 }
  ]
}
```

`gap` è espresso in secondi rispetto al leader; auto doppiate hanno
`lap` minore del `leaderLap`.

---

## 5. Esempi di subscription

```bash
# Tutta la telemetria della gara 1
mosquitto_sub -h localhost -p 1883 \
  -t 'f1/simulation/1/teams/+/cars/+/telemetry'

# Solo la Ferrari #16
mosquitto_sub -h localhost -p 1883 \
  -t 'f1/simulation/1/teams/ferrari/cars/16/#'

# Tutto il race-control (flag + classifica)
mosquitto_sub -h localhost -p 1883 \
  -t 'f1/simulation/1/race-control/#'

# Tutto il sotto-albero del progetto (debug)
mosquitto_sub -h localhost -p 1883 -t 'f1/#' -v
```
