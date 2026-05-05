**Piano: Race Modes a 5 Giri**

**Summary**
- Portare la gara a `5` giri impostando `totalLaps` di default e `TOTAL_LAPS` in Docker a `5`.
- Lasciare solo due modalità selezionabili: `balanced` e `red-flag` rinominata in UI come modalità “Failure likely”; rimuovere `checkered` dal modal e dal comando Node-RED.
- Aggiungere un indicatore di avanzamento gara nel pannello Race Control: giro corrente su 5 e barra percentuale.

**Key Changes**
- Ricalibrare `balanced` per 5 giri:
  - probabilità piccola ma non nulla di guasto: `engineFailureProbPerTick: 1e-5`;
  - fault non immediati: `faultGraceS: 60`;
  - overheat possibile sui 5 giri: `wearPerLap: 0.06`, `tireOverheatThresholdC: 138`, `tireOverheatTicksRequired: 8`;
  - bassa probabilità di interruzione: `retirementScProbability: 0.08`, `multiFaultVscThreshold: 3`, `massIncidentThreshold: 3`.
- Ricalibrare `red-flag` come modalità probabilistica ad alto rischio:
  - nessun guasto nei primi giri: `faultGraceS: 300`;
  - alta probabilità dopo il giro 3: `engineFailureProbPerTick: 0.0012`;
  - overheat possibile: `wearPerLap: 0.08`, `tireOverheatThresholdC: 142`, `tireOverheatTicksRequired: 8`;
  - fallimento probabile ma non scriptato: `retirementScProbability: 0.35`, `multiFaultVscThreshold: 2`, `massIncidentThreshold: 3`.
- Non cambiare i topic MQTT o gli schema payload; il progress UI userà `leaderLap`, `trackPos` del leader quando disponibile, e una costante client `5`.

**Test Plan**
- Aggiungere un test simulato senza MQTT reale per entrambe le modalità.
- Per `balanced`:
  - seed nominale: deve arrivare a Checkered al giro 5 senza Red Flag;
  - seed eventful: può produrre fault/ritiro/SC o Yellow, ma deve comunque terminare senza Red Flag.
- Per `red-flag`:
  - eseguire più seed deterministici e verificare che il primo fault sia dopo la grace window, che la Red Flag avvenga con `leaderLap` 3 o 4, e che non ci siano fault al primo giro.
  - fare anche una piccola simulazione Monte Carlo per confermare che la maggioranza dei run fallisce dopo il giro 3, senza diventare una mattanza iniziale.
- Eseguire i test esistenti rilevanti: `npm run test:conditions`, `npm run test:race-control`, `npm run test:mqtt-sim`, più il nuovo test race modes.

**Assumptions**
- Mantengo l’ID tecnico `red-flag` per ridurre il rischio sui flussi esistenti, ma lo mostro in dashboard come modalità di fallimento probabile.
- La modalità failure resta probabilistica, come scelto, quindi può raramente arrivare al traguardo; i test useranno seed deterministici per verificare il comportamento atteso.
