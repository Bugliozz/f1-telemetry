# 🏎️ Piano di Implementazione — F1 Telemetry System

> **Legenda modelli:**  🔴 Opus (architettura, logica complessa)  ·  🟠 Sonnet (implementazione standard, integrazione)  ·  🟢 Haiku (boilerplate, config, task semplici)

---

## Fase 0 — Setup Ambiente

- [ ] Inizializzare il progetto Node.js (`package.json`, dipendenze base) 🟢
- [ ] Installare e configurare **Eclipse Mosquitto** (broker MQTT locale) 🟢
- [ ] Installare e configurare **MongoDB** (database locale o container Docker) 🟢
- [ ] Installare **Node-RED** e verificare il funzionamento base 🟢
- [ ] Creare il `docker-compose.yml` per orchestrare Mosquitto + MongoDB + Node-RED 🟠
- [ ] Verificare la connettività tra i tre servizi (smoke test) 🟢

---

## Fase 1 — Struttura MQTT e Comunicazione

- [ ] Definire la struttura completa dei topic MQTT secondo lo schema gerarchico 🟠
  ```
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/telemetry
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/state
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/events
  f1/simulation/{raceId}/race-control/flags
  f1/simulation/{raceId}/race-control/classification
  ```
- [ ] Configurare Mosquitto (listener, ACL, QoS policy) 🟢
- [ ] Testare publish/subscribe manuale con `mosquitto_pub` / `mosquitto_sub` 🟢
- [ ] Documentare la topic structure con esempi di payload JSON 🟢

---

## Fase 2 — Data Model e Schema

- [ ] Definire lo schema JSON del payload telemetria (speed, rpm, tireTemp, fuel, trackPos, lap, state…) 🟠
- [ ] Definire lo schema per gli eventi car-level (pit stop, fault, retirement…) 🟠
- [ ] Definire lo schema per gli eventi race-control (flags, safety car…) 🟠
- [ ] Definire lo schema della classifica (classification) 🟢
- [ ] Creare le collection MongoDB (`telemetry`, `events`, `states`, `classifications`) con indici appropriati 🟠
- [ ] Scrivere script di seed/test per popolare dati di esempio 🟢

---

## Fase 3 — Simulation Layer (Car Simulator)

- [ ] Progettare l'architettura del simulatore multi-car (10 auto, 5 team) 🔴
- [ ] Implementare il modello base di avanzamento lungo il circuito (`trackPos ∈ [0,1]`, gestione giri) 🔴
- [ ] Implementare la variazione realistica della velocità (accelerazione, frenata, curve di Monza) 🔴
- [ ] Implementare il degrado progressivo delle gomme (`tireTemp`) 🟠
- [ ] Implementare il consumo carburante (`fuel`) 🟠
- [ ] Implementare la generazione RPM correlata alla velocità 🟠
- [ ] Implementare la **macchina a stati finiti** per ogni auto (INIT → RUNNING → PIT / FAULT / RETIRED / FINISHED) 🔴
- [ ] Definire le condizioni di transizione di stato (temperatura alta → FAULT, fuel basso → PIT, ecc.) 🔴
- [ ] Implementare il loop di publish MQTT a 2–5 Hz per ogni auto 🟠
- [ ] Aggiungere variabilità e randomness realistica ai dati generati 🟠
- [ ] Testare il simulatore con 1 auto, poi scalare a 10 🟢

---

## Fase 4 — Race Control

- [ ] Progettare la logica di Race Control (trigger e gestione flag globali) 🔴
- [ ] Implementare il **Safety Car (SC)**: riduzione velocità globale + compattamento del gruppo 🔴
- [ ] Implementare il **Virtual Safety Car (VSC)**: velocità limitata uniforme + divieto sorpasso 🔴
- [ ] Implementare le flag: 🟠
  - [ ] 🟩 Green Flag → gara attiva
  - [ ] 🟨 Yellow Flag → rallentamento
  - [ ] 🟥 Red Flag → gara sospesa
  - [ ] 🏁 Checkered Flag → fine gara
- [ ] Implementare la logica di influenza delle flag sul comportamento delle auto 🔴
- [ ] Implementare il trigger automatico/manuale degli eventi globali 🟠
- [ ] Testare scenari combinati (SC durante un pit stop, red flag, ecc.) 🟠

---

## Fase 5 — Processing Layer (Node-RED Flows)

- [ ] Progettare l'architettura dei flow Node-RED (flow diagram) 🔴
- [ ] Creare il flow di **subscription** ai topic telemetria (wildcard `+`) 🟠
- [ ] Creare il flow di **parsing e normalizzazione** dei messaggi MQTT 🟠
- [ ] Creare il flow di **calcolo della classifica** in tempo reale (basato su trackPos + lap) 🔴
- [ ] Creare il flow di **event detection** (anomalie, soglie superate) 🟠
- [ ] Creare il flow di **scrittura su MongoDB** (telemetria, eventi, stati, classifica) 🟠
- [ ] Creare il flow di **gestione race control** (ricezione flag → broadcast agli effetti) 🟠
- [ ] Creare il flow di **invio dati alla dashboard** (WebSocket / dashboard nodes) 🟠
- [ ] Ottimizzare i flow per gestire il throughput di 10 auto a 2–5 Hz 🔴
- [ ] Testare end-to-end: simulatore → MQTT → Node-RED → MongoDB 🟠

---

## Fase 6 — Persistence Layer (MongoDB)

- [ ] Implementare l'inserimento bulk della telemetria (ottimizzazione write) 🟠
- [ ] Implementare query per analisi storica (tempi sul giro, andamento fuel/tire) 🟠
- [ ] Creare indici per query frequenti (`raceId`, `carId`, `timestamp`, `lap`) 🟢
- [ ] Implementare TTL o capping per gestione volume dati 🟢
- [ ] Verificare consistenza dati tra MQTT payload e documenti MongoDB 🟢

---

## Fase 7 — Dashboard e Visualizzazione

- [ ] Creare/reperire la grafica SVG del circuito di **Monza** 🟠
- [ ] Implementare il rendering delle auto come marker dinamici sull'SVG 🔴
- [ ] Implementare l'**interpolazione fluida** tra posizioni successive (smooth movement client-side) 🔴
- [ ] Implementare il pannello **classifica in tempo reale** 🟠
- [ ] Implementare il pannello **stato auto** (colori per stato FSM) 🟠
- [ ] Implementare il pannello **eventi di gara** (log live) 🟠
- [ ] Implementare indicatori **flag attiva** (SC, VSC, bandiere) 🟠
- [ ] Collegare la dashboard ai dati via WebSocket da Node-RED 🟠
- [ ] Testare la fluidità con 10 auto in movimento simultaneo 🟠
- [ ] Ottimizzare le performance di rendering (requestAnimationFrame, throttling) 🔴

---

## Fase 8 — Integrazione e Test End-to-End

- [ ] Test completo: avvio gara → svolgimento → eventi → fine gara 🟠
- [ ] Verificare tutti gli scenari di stato (FAULT, PIT, RETIRED, FINISHED) 🟠
- [ ] Verificare il comportamento sotto Safety Car e VSC 🟠
- [ ] Stress test: verificare stabilità con tutte le auto a 5 Hz 🟠
- [ ] Verificare la persistenza corretta su MongoDB durante tutta la gara 🟢
- [ ] Bug fixing e tuning parametri di simulazione 🟠

---

## Fase 9 — Documentazione e Delivery

- [ ] Scrivere il README del progetto con istruzioni di setup e avvio 🟢
- [ ] Documentare l'architettura con diagrammi (C4 / componenti) 🟠
- [ ] Documentare la struttura MQTT con esempi 🟢
- [ ] Documentare il data model MongoDB 🟢
- [ ] Preparare screenshot/screen recording della dashboard in funzione 🟢
- [ ] Preparare la presentazione finale del progetto 🟠

---

## Riepilogo Effort per Modello

| Modello | Simbolo | Tipo di task | N° task |
|---------|---------|-------------|---------|
| **Opus** | 🔴 | Architettura, logica complessa, algoritmi core, FSM, ottimizzazione | ~14 |
| **Sonnet** | 🟠 | Implementazione standard, integrazione, flow, UI components | ~33 |
| **Haiku** | 🟢 | Config, boilerplate, setup, query semplici, documentazione base | ~16 |

---

> **Nota:** Le assegnazioni ai modelli sono indicative. Task 🟠 con contesto molto ampio possono beneficiare di 🔴. Task 🟠 molto ripetitivi possono scendere a 🟢 se ben promptati.
