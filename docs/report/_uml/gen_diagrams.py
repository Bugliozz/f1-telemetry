# -*- coding: utf-8 -*-
"""Generate PlantUML sequence diagrams for the 19 F1-telemetry events."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))

HEADER = """@startuml
skinparam dpi 150
skinparam shadowing false
skinparam sequenceMessageAlign center
skinparam maxMessageSize 220
skinparam sequence {
  ArrowColor #2c3e50
  LifeLineBorderColor #95a5a6
  ParticipantBorderColor #2c3e50
  ParticipantBackgroundColor #ecf0f1
  ActorBackgroundColor #ecf0f1
}
hide footbox
title %TITLE%
"""

# Common participant blocks ------------------------------------------------
CAR_ACTORS = '''participant "conditions.js\\nevaluate()" as C
participant "fsm.js\\ntransition()" as F
participant "Car.tick()" as CAR
participant "MQTT\\nPublisher" as P
queue ".../cars/{id}/events\\n(Broker, QoS1)" as B
participant "Node-RED\\ningest" as N
database "MongoDB\\nevents" as M
participant "Dashboard\\n(WebSocket)" as D'''

FLAG_ACTORS = '''participant "triggers.js\\nevaluateTriggers()" as T
participant "flag-state.js\\nchangeFlag()" as FF
participant "RaceController" as RC
participant "MQTT\\nPublisher" as P
queue ".../race-control/flags\\n(retained, QoS1)" as B
participant "Node-RED" as N
database "MongoDB\\nrace_control" as M
participant "Dashboard" as D'''

DERIVED_ACTORS = '''participant "Car telemetry\\n(5 Hz sample)" as TEL
participant "SF-Detect\\nTelemetry Events" as DET
queue ".../cars/{id}/events\\n(Broker, QoS1)" as B
participant "Node-RED\\ningest" as N
database "MongoDB\\nevents" as M
participant "Dashboard" as D'''

TAIL_CAR = '''P -> B : publish event
B -> N : deliver
N -> M : store event document
N -> D : dashboard/event frame'''

TAIL_FLAG = '''RC -> P : flag{...,active:true} (retained)
P -> B : publish
B -> N : deliver
N -> M : append race_control history
N -> D : dashboard/race-control frame'''

TAIL_DERIVED = '''DET -> B : republish car event (derived:true)
B -> N : deliver
N -> M : store event document
N -> D : dashboard/event frame'''

EVENTS = {}

# --- A.1 Car lifecycle events (simulator) --------------------------------
EVENTS["ev01_state-change"] = ("state-change event", CAR_ACTORS, '''C -> CAR : trigger (any FSM cause)
CAR -> F : transition(fsm, trigger)
F --> CAR : {from, to, reason, changed:true}
note over CAR : umbrella event emitted on\\nEVERY accepted FSM transition;\\nalso publishes retained state msg
CAR -> P : event{type:"state-change",\\ndetails:{from,to,reason}}
''' + TAIL_CAR)

EVENTS["ev02_pit-entry"] = ("pit-entry event", CAR_ACTORS, '''CAR -> C : evaluate(RUNNING, obs)
C -> C : isTireServiceDue(wear>=0.60)\\n&& isPitEntryWindow(trackPos>=0.95)
C --> CAR : trigger = tire-service
CAR -> F : transition(RUNNING, tire-service)
F --> CAR : to = PIT
CAR -> P : event{type:"pit-entry",\\ndetails:{lap}}
''' + TAIL_CAR)

EVENTS["ev03_pit-stop"] = ("pit-stop event", CAR_ACTORS, '''note over CAR : in PIT, crosses pit-box\\nposition (trackPos≈0.985)
CAR -> CAR : reset tyre temp, pick a\\nDIFFERENT compound, wear:=0
CAR -> P : event{type:"pit-stop",\\ndetails:{duration 2.0-3.5s,\\ntyreCompound, service:tire-change,\\nrefuelling:false}}
''' + TAIL_CAR)

EVENTS["ev04_pit-exit"] = ("pit-exit event", CAR_ACTORS, '''CAR -> C : evaluate(PIT, obs)
C -> C : isPitTimeElapsed(2.0-3.5s)\\n&& pitExitReached
C --> CAR : trigger = pit-out
CAR -> F : transition(PIT, pit-out)
F --> CAR : to = RUNNING
CAR -> P : event{type:"pit-exit",\\ndetails:{lap}}
''' + TAIL_CAR)

EVENTS["ev05_fault"] = ("fault event", CAR_ACTORS, '''CAR -> C : evaluate(RUNNING|PIT, obs)
C -> C : tire-overheat (max>180C x3 ticks)\\nOR engine-failure (rng<1e-4 per tick)
C --> CAR : trigger = tire-overheat | engine-failure
note over CAR : internal-error (exception in tick)\\nalso forces FAULT from any state
CAR -> F : transition(*, trigger) -> FAULT
CAR -> CAR : onEnterFault() starts 5s diagnose timer
CAR -> P : event{type:"fault",\\ndetails:{reason}}
''' + TAIL_CAR)

EVENTS["ev06_retirement"] = ("retirement event", CAR_ACTORS, '''CAR -> C : evaluate(FAULT, obs)
C -> C : isFaultUnrecoverable(diagnose>=5s)\\n(every fault is unrecoverable)
C --> CAR : trigger = unrecoverable
note over CAR : manual-retire (Race Control)\\nretires from any non-terminal state
CAR -> F : transition(FAULT, unrecoverable)\\n-> RETIRED (absorbing)
CAR -> P : event{type:"retirement",\\ndetails:{reason}}
''' + TAIL_CAR + '''
note over T0 : retirements feed Race Control\\nSC / RED-flag triggers''')

# ev06 references a participant T0 that does not exist; fix below
EVENTS["ev06_retirement"] = ("retirement event", CAR_ACTORS, '''CAR -> C : evaluate(FAULT, obs)
C -> C : isFaultUnrecoverable(diagnose>=5s)\\n(every fault is unrecoverable)
C --> CAR : trigger = unrecoverable
note over CAR : manual-retire (Race Control)\\nretires from any non-terminal state
CAR -> F : transition(FAULT, unrecoverable)\\n-> RETIRED (absorbing)
CAR -> P : event{type:"retirement",\\ndetails:{reason}}
''' + TAIL_CAR + '''
note over N : retirements also feed Race Control\\nSC / RED-flag triggers''')

EVENTS["ev07_lap-completed"] = ("lap-completed event", CAR_ACTORS, '''note over CAR : trackPos wraps past the\\nstart/finish line -> lap++
CAR -> CAR : lapTime = now - lapStartTime
CAR -> P : event{type:"lap-completed",\\ndetails:{lap, lapTime}}
''' + TAIL_CAR + '''
note over N : leader lap count feeds the\\nCHECKERED-flag trigger''')

EVENTS["ev08_sector-completed"] = ("sector-completed event", CAR_ACTORS, '''note over CAR : crosses a sector boundary\\nS1 0-0.33 / S2 0.33-0.66 / S3 0.66-1.0
CAR -> CAR : sectorTime = now - sectorStartTime
CAR -> P : event{type:"sector-completed",\\ndetails:{sector, sectorTime, sectorName}}
''' + TAIL_CAR)

EVENTS["ev09_overtake"] = ("overtake event (reserved)", '''participant "classify fn\\n(Node-RED)" as CL
queue ".../race-control/classification\\n(retained)" as B
participant "Dashboard\\nleaderboard" as D
participant "event.schema.json\\n+ Mongo validator" as S''')

# overtake needs custom body (3 args expected); store as 4-tuple handled below
EVENTS["ev09_overtake"] = ("overtake event (reserved)", '''participant "classify fn\\n(Node-RED)" as CL
queue ".../race-control/classification\\n(retained)" as B
participant "Dashboard\\nleaderboard" as D
control "event.schema.json\\n+ Mongo validator" as S''', '''note over S : "overtake" is a DEFINED event type\\n(schema enum + Mongo validator) but is\\nNOT currently emitted by any producer.
CL -> CL : sort cars by progress (lap+trackPos)\\nrecompute standings every snapshot
CL -> B : classification{standings[]} (retained)
B -> D : leaderboard re-renders;\\nposition swaps are shown implicitly
note over CL, D : EXTENSION POINT: comparing two\\nconsecutive standings would let the\\nclassifier publish an explicit\\n{type:"overtake"} car event''')

# --- A.2 Race Control flags ----------------------------------------------
EVENTS["ev10_GREEN"] = ("GREEN flag", FLAG_ACTORS, '''T -> T : start-of-race race-start\\nOR clearance: elapsed>=minDuration\\n&& faultCount==0 (hazard cleared)
T --> RC : {flag:GREEN, reason:race-start|clearance-after-...}
RC -> FF : changeFlag(current, GREEN)
FF --> RC : changed:true
''' + TAIL_FLAG + '''
note over N : GREEN with reason race-start also\\ndrives cars INIT -> RUNNING''')

EVENTS["ev11_YELLOW"] = ("YELLOW flag (local)", FLAG_ACTORS, '''T -> T : faultCount == 1\\n(single car stopped on track)
note over T : fallback caution, active only when\\nthe VSC threshold is set above 1
T --> RC : {flag:YELLOW, sector:S, reason:car-fault-on-track}
RC -> FF : changeFlag(GREEN, YELLOW, {sector})
FF --> RC : changed:true (YELLOW is the\\nonly flag carrying a sector)
''' + TAIL_FLAG)

EVENTS["ev12_RED"] = ("RED flag", FLAG_ACTORS, '''T -> T : count(FAULT + RETIRED) >= 3\\n(massIncidentThreshold)
T --> RC : {flag:RED, reason:mass-incident:N-cars}
RC -> FF : changeFlag(*, RED)
FF --> RC : changed:true
''' + TAIL_FLAG + '''
note over N : race suspended; needs a MANUAL\\nGREEN to restart; Node-RED pauses the\\nstationary-running detector while RED''')

EVENTS["ev13_SC"] = ("Safety Car (SC) flag", FLAG_ACTORS, '''T -> T : new retirement AND\\nrng() < retirementScProbability\\n(default 0 -> off unless configured)
T --> RC : {flag:SC, reason:debris-retirement:car-N}
RC -> FF : changeFlag(GREEN|YELLOW, SC)
FF --> RC : changed:true
''' + TAIL_FLAG + '''
note over T : auto-clears to GREEN after\\nscMinDurationS (30s) if no car in FAULT''')

EVENTS["ev14_VSC"] = ("Virtual Safety Car (VSC) flag", FLAG_ACTORS, '''T -> T : faultCount >= multiFaultVscThreshold\\n(default threshold = 1)
T --> RC : {flag:VSC, reason:fault-on-track | multi-fault:N}
RC -> FF : changeFlag(GREEN|YELLOW, VSC)
FF --> RC : changed:true
''' + TAIL_FLAG + '''
note over T : auto-clears to GREEN after\\nvscMinDurationS (20s) if no car in FAULT''')

EVENTS["ev15_CHECKERED"] = ("CHECKERED flag", FLAG_ACTORS, '''T -> T : leaderLap >= totalLaps\\n(HIGHEST priority trigger)
T --> RC : {flag:CHECKERED, reason:leader-finished}
RC -> FF : changeFlag(*, CHECKERED)
FF --> RC : changed:true (absorbing state)
''' + TAIL_FLAG + '''
note over N : cars in RUNNING/PIT -> FINISHED\\n(race-end); no further flag transitions''')

# --- A.3 Derived telemetry events (Node-RED) -----------------------------
EVENTS["ev16_tire-overheat"] = ("derived: tire-overheat", DERIVED_ACTORS, '''TEL -> DET : telemetry sample {tireTemp{fl,fr,rl,rr}}
DET -> DET : hottestTire().value >= 170 C ?
DET -> DET : dedup window 10 s per car/reason
DET -> DET : build event{type:"fault",\\ndetails:{reason:tire-overheat, corner,\\ntireTemp, threshold:170,\\nsource:node-red-event-detection}}
''' + TAIL_DERIVED)

EVENTS["ev17_low-fuel"] = ("derived: low-fuel", DERIVED_ACTORS, '''TEL -> DET : telemetry sample {fuel, state}
DET -> DET : fuel <= 5 kg AND state not in\\n{PIT, RETIRED, FINISHED} ?
DET -> DET : dedup window 30 s
DET -> DET : build event{type:"state-change",\\ndetails:{from:state, to:PIT, reason:low-fuel}}
''' + TAIL_DERIVED)

EVENTS["ev18_stationary-running"] = ("derived: stationary-running", DERIVED_ACTORS, '''TEL -> DET : telemetry sample {speed, state}
DET -> DET : state==RUNNING AND speed <= 1 km/h\\nheld for >= 5000 ms AND race not RED
DET -> DET : dedup window 10 s
DET -> DET : build event{type:"retirement",\\ndetails:{reason:stationary-running,\\ndurationMs, speed, threshold:1}}
''' + TAIL_DERIVED)

EVENTS["ev19_track-position-jump"] = ("derived: track-position-jump", DERIVED_ACTORS, '''TEL -> DET : telemetry sample {lap, trackPos}
DET -> DET : delta = (lap+trackPos) - previous
DET -> DET : delta > 0.20 (forward jump) OR\\ndelta < -0.05 (backstep),\\nexcluding the lap-0 race restart
DET -> DET : dedup window 10 s
DET -> DET : build event{type:"fault",\\ndetails:{reason:track-position-jump,\\ndelta, previousLap, currentLap, ...}}
''' + TAIL_DERIVED)


def main():
    for key, spec in EVENTS.items():
        title, actors, body = spec
        puml = HEADER.replace("%TITLE%", title) + actors + "\n" + body + "\n@enduml\n"
        path = os.path.join(HERE, key + ".puml")
        with open(path, "w", encoding="utf-8") as f:
            f.write(puml)
    print("wrote %d puml files" % len(EVENTS))


if __name__ == "__main__":
    main()
