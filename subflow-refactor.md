# Refactor in Subflow — F1 Telemetry (tab 01-07)

Scomposizione dei flow di gara in subflow. **Approccio conservativo**: ogni subflow
e un *trasformatore puro* (lavora solo su `msg`). L'IO (`mqtt`, `mongodb`, `websocket`),
i nodi `link` e i `catch` restano sul tab. Lavoriamo **un subflow alla volta**.

File interessato: `node-red/data/flows.json`

---

## Note / vincoli tecnici (leggere prima)

- **`flow` context = per-istanza dentro un subflow.** Sposto in subflow solo function
  che NON condividono `flow.get/set` con altri nodi del tab. Le cache stateful
  (telemetria, classification, dashboard snapshot) **restano sul tab**.
- **`node.status()`** di una function dentro subflow appare sul nodo interno, non
  sull'istanza nel tab (si perde il pallino di stato sul canvas del tab).
- **Errori non catturati** dentro un subflow risalgono al `catch` del tab padre,
  quindi la gestione errori esistente (`catch -> SF Flow Error Sink`) continua a funzionare.
- **Convenzione:** l'istanza riusa l'`id` della function originale (così i wire
  esistenti restano validi); la logica va in un nuovo nodo interno al subflow.

---

## Subflow da creare

### 1. SF - Normalize MQTT  (tab 02)
Wrappa `fn-parse-normalize-mqtt`. Solo node-context, sicuro. **1 in -> 2 out** (ok / errore).
- [x] Implementato
- [x] Verificato (deploy + messaggio MQTT normalizzato)

### 2. SF - Detect Telemetry Events  (tab 03)
Wrappa `fn-detect-telemetry-events`. Le sue chiavi `flow` sono private al nodo, sicuro.
**1 in -> 2 out** (event envelopes / mqtt events).
- [x] Implementato
- [x] Verificato (evento derivato generato: es. tire-overheat / low-fuel)

### 3. SF - Race Control Flag Handler  (tab 04)
Wrappa `fn-handle-race-control-flag`. Nessun lettore in-tab del suo `flow`, sicuro.
**1 in -> 4 out** (dashboard / persistence / effects / errori).
- [x] Implementato
- [x] Verificato (flag YELLOW/RED -> effetti + persistenza)

### 4. SF - Encrypt Secure Flag  (tab 05)
Wrappa `fn-encrypt-secure-flag`. Usa `global`/`env`, niente `flow`, sicuro.
**1 in -> 2 out** (secure out / errore).
- [x] Implementato
- [x] Verificato (comando dashboard -> topic secure cifrato)

### 5. SF - Decrypt Secure Flag  (tab 05)
Wrappa `fn-decrypt-secure-flag`. Usa `global`/`env`, niente `flow`, sicuro.
**1 in -> 2 out** (clear flag out / errore).
- [x] Implementato
- [x] Verificato (topic secure -> flag in chiaro su race-control/flags)

### 6. (opzionale) SF - Dashboard Command Parser  (tab 07)
Wrappa i 3 parser comandi (`fn-dashboard-race-control-command`,
`fn-dashboard-start-scenario-command`, `fn-dashboard-stop-race-command`) in un unico
subflow. Sono pure transform. L'input (websocket) fa fan-out interno ai 3 parser.
**1 in -> 4 out** (flag-action / start-action / stop-action / errori-merge).
- [x] Implementato
- [x] Verificato (comandi flag/start/stop dalla dashboard)

---

## Restano sul tab (NON subflow)

- Tab 01 MQTT Ingestion: solo `mqtt in` + `catch`, niente da estrarre.
- Tab 03: cache telemetria + classification (stato `flow` condiviso).
- Tab 06 MongoDB: function "Prepare ... doc" (singole, basso valore).
- Tab 07: cache car state/telemetry + dashboard snapshot (stato `flow` condiviso).
- Tutti i `catch`, `link in/out`, `mqtt`, `mongodb`, `websocket`, `inject`.

---

## Chiusura

- [x] Tutti i subflow sopra implementati e verificati
- [x] `flows.json` valido (parse OK) e deploy senza errori in Node-RED
- [x] Backup pre-refactor conservato
- [x] Rimossi file temporanei di lavoro
