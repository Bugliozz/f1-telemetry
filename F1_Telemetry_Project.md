**Real-Time Distributed Telemetry System Simulation**

**for a Formula 1 Race with Dynamic Track Visualization (Monza)**

using Node-RED, MQTT (Eclipse Mosquitto) and MongoDB

*Innovative Telecommunication Systems*

# **1. Introduction and Application Scenario**

The project involves the design and implementation of a distributed system for simulating a Formula 1 race, with particular focus on telecommunication aspects, real-time data stream management, and event-driven architectures.

The modeled scenario reproduces a realistic context in which multiple cars continuously generate telemetry data during a race. Such data is transmitted via MQTT protocol to a central broker (Eclipse Mosquitto), processed by Node-RED, and stored in MongoDB for analysis and visualization.

The simulation comprises 5 teams with 2 cars each, for a total of 10 cars. The system also includes a race control component capable of managing global events (flags and safety car) that dynamically influence the behavior of the cars.

A distinctive element of the project is the interactive dashboard that represents the Monza circuit and displays in real time the smooth movement of cars along the track.

# **2. Project Objectives**

The project aims to:

- Simulate a multi-car race in a distributed environment
- Implement a real-time telemetry system based on MQTT
- Design a scalable MQTT topic structure
- Model the dynamic behavior of cars through states and events
- Integrate Node-RED as the orchestration and processing engine
- Use MongoDB for data persistence
- Build an interactive dashboard with smooth car tracking
- Represent realistic race control scenarios (SC, VSC, flags)

# **3. System Architecture**

The architecture is divided into four logical layers.

## **3.1 Simulation Layer (Car Layer)**

Each car is modeled as a data source that periodically generates telemetry information.

The simulated quantities include:

- Position along the circuit (trackPos ∈ [0,1])
- Speed
- Engine RPM
- Tire temperature
- Remaining fuel
- Car state

The update frequency ranges between 2 and 5 Hz, sufficient to ensure a smooth perception of movement.

## **3.2 Communication Layer (Network Layer)**

Communication occurs via the MQTT protocol using Eclipse Mosquitto as the broker.

Topic structure designed for scalability:

f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/telemetry

f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/state

f1/simulation/{raceId}/teams/{teamId}/cars/{carId}/events

f1/simulation/{raceId}/race-control/flags

f1/simulation/{raceId}/race-control/classification

This structure enables:

- Isolation per race (raceId)
- Hierarchical organization by team and car
- Support for MQTT wildcards
- High system scalability

## **3.3 Processing Layer (Node-RED)**

Node-RED represents the control center of the system.

Main functionalities:

- Subscription to MQTT topics
- Parsing and normalization of data
- Calculation of car states
- Race logic management
- Event and anomaly detection
- Classification update
- Sending data to the dashboard
- Writing to MongoDB

## **3.4 Persistence Layer (MongoDB)**

MongoDB is used for data storage:

- Historical telemetry
- Race events
- Car states
- Classifications

The document model is consistent with the JSON format of MQTT messages.

# **4. Data Model**

Example payload:

{

  "raceId": "monza2026",

  "teamId": "team01",

  "carId": "car01",

  "timestamp": "2026-04-03T14:22:10Z",

  "lap": 12,

  "trackPos": 0.438,

  "speed": 276,

  "rpm": 11840,

  "tireTemp": 97,

  "fuel": 31.4,

  "state": "RUNNING"

}

# **5. Initial System State**

At simulation startup:

- All cars are in the INIT state
- Initial position aligned on the starting grid (trackPos ≈ 0)
- Fuel at maximum
- Nominal tire temperature
- No active events

The system transitions to the race state (RUNNING) upon the occurrence of the green flag.

# **6. Car State Model**

Each car is described by a finite state machine:

- INIT
- RUNNING
- PIT
- FAULT
- RETIRED
- FINISHED

Transitions are determined by conditions on the data:

- High temperature → FAULT
- Low fuel → warning / PIT
- Pit lane entry → PIT
- Persistent zero speed → RETIRED
- Race completion → FINISHED

# **7. Race Dynamics Simulation**

The race dynamics are modeled through:

- Continuous advancement along the circuit (trackPos)
- Speed variation
- Progressive tire degradation
- Fuel consumption
- Lap management

The system enables real-time classification calculation based on the position along the circuit.

# **8. Race Events and Race Control**

## **8.1 Car Events**

- Pit stop
- Failures
- Overheating
- Low fuel
- Retirement

## **8.2 Global Events (Race Control)**

The system implements realistic race conditions:

**Safety Car (SC)**

- Global speed reduction
- Pack compaction

**Virtual Safety Car (VSC)**

- Uniform limited speed
- Overtaking ban

- Green flag → race active
- Yellow flag → slowdown and restrictions
- Red flag → race suspended
- Checkered flag → end of race

These events directly influence the behavior of the cars.

# **9. Visualization and Dashboard**

The dashboard represents:

- The Monza circuit via static graphics (SVG)
- Cars as dynamic markers
- Real-time classification
- Car states
- Race events

**Car Movement**

The movement is implemented smoothly through:

- Continuous updates (2–5 Hz)
- Interpolation between successive positions
- Dynamic client-side rendering

This enables a realistic and continuous visualization of the track.

# **10. Telecommunication Aspects**

The project integrates:

- Publish/subscribe architecture
- Real-time stream management
- Scalability through hierarchical topics
- MQTT QoS
- Distributed systems
- Separation between edge and control center

Possible extensions:

- Latency simulation
- Packet loss
- Jitter

# **11. Expected Results**

The final system enables:

- Real-time monitoring of a simulated race
- Smooth visualization of car movement
- State and event management
- Observation of race control effects
- Historical data analysis on MongoDB

# **12. Conclusion**

The project represents a complete application case in the context of innovative telecommunication systems.

The integration of Node-RED, Mosquitto, and MongoDB enables the creation of a scalable distributed system, while the Formula 1 race simulation provides a realistic and technically significant context.

The presence of a structured state model, global race events, and smooth car visualization contributes to making the system coherent, demonstrable, and aligned with the course objectives.