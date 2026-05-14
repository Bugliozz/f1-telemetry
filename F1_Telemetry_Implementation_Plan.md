# 🏎️ Piano di Implementazione — F1 Telemetry System

> **Legenda modelli:**  🔴 Opus (architettura, logica complessa)  ·  🟠 Sonnet (implementazione standard, integrazione)  ·  🟢 Haiku (boilerplate, config, task semplici)

---

## Fase 0 — Setup Ambiente

- [x] Inizializzare il progetto Node.js (`package.json`, dipendenze base) 🟢
- [x] Installare e configurare **Eclipse Mosquitto** (broker MQTT locale) 🟢
- [x] Installare e configurare **MongoDB** (database locale o container Docker) 🟢
- [x] Installare **Node-RED** e verificare il funzionamento base 🟢
- [x] Creare il `docker-compose.yml` per orchestrare Mosquitto + MongoDB + Node-RED 🟠
- [x] Verificare la connettività tra i tre servizi (smoke test) 🟢

---

## Fase 1 — Struttura MQTT e Comunicazione

- [x] Definire la struttura completa dei topic MQTT secondo lo schema gerarchico 🟠
  ```
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/telemetry
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/state
  f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/events
  f1/simulation/{raceId}/race-control/flags
  f1/simulation/{raceId}/race-control/classification
  ```
- [x] Configurare Mosquitto (listener, ACL, QoS policy) 🟢
- [x] Testare publish/subscribe manuale con `mosquitto_pub` / `mosquitto_sub` 🟢
- [x] Documentare la topic structure con esempi di payload JSON 🟢

---

## Fase 2 — Data Model e Schema

- [x] Definire lo schema JSON del payload telemetria (speed, rpm, tireTemp, fuel, trackPos, lap, state…) 🟠
- [x] Definire lo schema per gli eventi car-level (pit stop, fault, retirement…) 🟠
- [x] Definire lo schema per gli eventi race-control (flags, safety car…) 🟠
- [x] Definire lo schema della classifica (classification) 🟢
- [x] Creare le collection MongoDB (`telemetry`, `events`, `states`, `classifications`) con indici appropriati 🟠
- [x] Scrivere script di seed/test per popolare dati di esempio 🟢

---

## Fase 3 — Simulation Layer (Car Simulator)

- [x] Progettare l'architettura del simulatore multi-car (10 auto, 5 team) 🔴 — vedi [docs/simulator-architecture.md](docs/simulator-architecture.md)
- [x] Implementare il modello base di avanzamento lungo il circuito (`trackPos ∈ [0,1]`, gestione giri) 🔴
- [x] Implementare la variazione realistica della velocità (accelerazione, frenata, curve di Monza) 🔴
- [x] Implementare il degrado progressivo delle gomme (`tireTemp`) 🟠
- [x] Implementare il consumo carburante (`fuel`) 🟠
- [x] Implementare la generazione RPM correlata alla velocità 🟠
- [x] Implementare la **macchina a stati finiti** per ogni auto (INIT → RUNNING → PIT / FAULT / RETIRED / FINISHED) 🔴
- [x] Definire le condizioni di transizione di stato (temperatura alta → FAULT, fuel basso → PIT, ecc.) 🔴
- [x] Implementare il loop di publish MQTT a 2–5 Hz per ogni auto 🟠
- [x] Aggiungere variabilità e randomness realistica ai dati generati 🟠
- [x] Testare il simulatore con 1 auto, poi scalare a 10 🟢

---
    
## Fase 4 — Race Control

- [x] Progettare la logica di Race Control (trigger e gestione flag globali) 🔴 — vedi [docs/race-control-design.md](docs/race-control-design.md)
- [x] Implementare il **Safety Car (SC)**: riduzione velocità globale + compattamento del gruppo 🔴
- [x] Implementare il **Virtual Safety Car (VSC)**: velocità limitata uniforme + divieto sorpasso 🔴
- [x] Implementare le flag: 🟠
  - [x] 🟩 Green Flag → gara attiva
  - [x] 🟨 Yellow Flag → rallentamento
  - [x] 🟥 Red Flag → gara sospesa
  - [x] 🏁 Checkered Flag → fine gara
- [x] Implementare la logica di influenza delle flag sul comportamento delle auto 🔴
- [x] Implementare il trigger automatico/manuale degli eventi globali 🟠
- [x] Testare scenari combinati (SC durante un pit stop, red flag, ecc.) 🟠

---

## Fase 5 — Processing Layer (Node-RED Flows)

- [x] Progettare l'architettura dei flow Node-RED (flow diagram) 🔴 - vedi [docs/node-red-flow-architecture.md](docs/node-red-flow-architecture.md)
- [x] Creare il flow di **subscription** ai topic telemetria (wildcard `+`) 🟠
- [x] Creare il flow di **parsing e normalizzazione** dei messaggi MQTT 🟠
- [x] Creare il flow di **calcolo della classifica** in tempo reale (basato su trackPos + lap) 🔴
- [x] Creare il flow di **event detection** (anomalie, soglie superate) 🟠
- [x] Creare il flow di **scrittura su MongoDB** (telemetria, eventi, stati, classifica) 🟠
- [x] Creare il flow di **gestione race control** (ricezione flag → broadcast agli effetti) 🟠
- [x] Creare il flow di **invio dati alla dashboard** (WebSocket / dashboard nodes) 🟠
- [x] Ottimizzare i flow per gestire il throughput di 10 auto a 2–5 Hz 🔴
- [x] Testare end-to-end: simulatore → MQTT → Node-RED → MongoDB 🟠

### Fase 5.bis — Crittografia (opzionale, requisito di consegna)

> Requisito: alcune regole Node-RED devono trasmettere dati cifrati con operazioni di encrypt/decrypt. Sotto-flow da innestare nei flow esistenti.

- [x] Scegliere il payload sensibile da cifrare (es. eventi `race-control/flags`, comandi PIT, classifica finale) 🟠
- [x] Definire algoritmo e modalità (consigliato **AES-256-GCM** con IV random per messaggio) 🟠
- [x] Gestire la chiave simmetrica via env var del container Node-RED (no hardcoding) 🟢
- [x] Implementare il nodo `function` di **encrypt** lato publisher (output: `{iv, ciphertext, tag}` base64) 🟠
- [x] Implementare il nodo `function` di **decrypt** lato subscriber con verifica del tag GCM 🟠
- [x] Aggiungere un topic dedicato per i payload cifrati (es. `f1/simulation/{raceId}/secure/...`) 🟢
- [x] Testare round-trip encrypt → MQTT → decrypt e fallimento controllato con chiave errata 🟢
- [x] Documentare nel report quali flow usano crittografia e perché 🟢

---

## Fase 6 — Persistence Layer (MongoDB)

- [x] Implementare l'inserimento bulk della telemetria (ottimizzazione write) 🟠
- [x] Implementare query per analisi storica (tempi sul giro, andamento fuel/tire) 🟠
- [x] Creare indici per query frequenti (`raceId`, `carId`, `timestamp`, `lap`) 🟢
- [x] Implementare TTL o capping per gestione volume dati 🟢
- [x] Verificare consistenza dati tra MQTT payload e documenti MongoDB 🟢

---

## Fase 7 — Dashboard e Visualizzazione

- [x] Creare/reperire la grafica SVG del circuito di **Monza** 🟠
- [x] Implementare il rendering delle auto come marker dinamici sull'SVG 🔴
- [x] Implementare l'**interpolazione fluida** tra posizioni successive (smooth movement client-side) 🔴
- [x] Implementare il pannello **classifica in tempo reale** 🟠
- [x] Implementare il pannello **stato auto** (colori per stato FSM) 🟠
- [x] Implementare il pannello **eventi di gara** (log live) 🟠
- [x] Implementare indicatori **flag attiva** (SC, VSC, bandiere) 🟠
- [x] Collegare la dashboard ai dati via WebSocket da Node-RED 🟠
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

### Report PDF (in inglese, richiesto dalla consegna)

- [ ] Scrivere il **report PDF in inglese** con: scenario, architettura, protocolli, flow Node-RED, funzioni, motivazioni di ogni scelta 🟠
- [ ] Nel report, dichiarare esplicitamente l'**eterogeneità dei sensori** simulati: 🟢
  - **Analogici (continui)**: speed, rpm, tireTemp, fuel, trackPos
  - **Digitali (discreti / on-off)**: pit-lane sensor (in/out), DRS (on/off), transponder di settore, flag detector
- [ ] Documentare nel report la sezione **crittografia** (algoritmo, chiavi, flow coinvolti) 🟢

### UML e diagrammi

- [ ] **Component diagram** dei moduli (simulator, broker, Node-RED, MongoDB, dashboard) 🟠
- [ ] **Sequence diagram** dei flussi MQTT chiave (telemetry publish → Node-RED → DB; race-control flag broadcast; encrypt/decrypt) 🟠
- [ ] **State diagram** della FSM auto (INIT → RUNNING → PIT / FAULT / RETIRED / FINISHED) 🟠
- [ ] **Deployment diagram** con i container Docker e le porte esposte 🟢

### Codice e dump

- [ ] Scrivere il README con istruzioni di setup e avvio (`docker compose up`) 🟢
- [ ] Esportare i **flow Node-RED** in JSON e committarli nel repo 🟢
- [ ] Generare il **dump MongoDB** (`mongodump`) e includerlo nel pacchetto di consegna 🟢
- [ ] Documentare la struttura MQTT con esempi di payload 🟢
- [ ] Documentare il data model MongoDB (schema collection + indici) 🟢

### Presentazione

- [ ] Preparare screenshot/screen recording della dashboard in funzione 🟢
- [ ] Preparare la presentazione finale del progetto 🟠

---



