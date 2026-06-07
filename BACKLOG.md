# Project Backlog

Track bugs, features, improvements, ideas for Enphase Controller app.

## Bugs
- Empty

## Small changes / ToDo
- Add 12-digit validation to Gateway SN login input. Prevent users entering Site ID.


## Proposed Features

- **Toggle production on/off through the Enphase Installer Cloud API**
  - *Description*: Control power production via official Enphase Installer Cloud API (v4) instead of local Envoy API.
  - *Documentation*: [Enphase Developer Portal Docs](https://developer-v4.enphase.com/docs.html)
  - *Benefits*: Backup method to toggle production, bypass local network issues, remain stable across local IQ Gateway firmware updates.

- **Dynamic Power Production & Export Limiting (Wattage Capping)**
  - *Description*: Dynamically cap/limit power production/export to specific wattage instead of full on/off toggle.
  - *Technical Feasibility*:
    - **Local Gateway (Envoy) API**: Direct control of inverter wattage not officially exposed to homeowners. Undocumented local endpoints like `/ivp/ss/dpel` and `/ivp/ss/der_settings` used by other integrations but unstable, prone to breaking on firmware 7.x/8.x.
    - **Grid Profiles**: Official limit enforcement via Grid Profiles. Static, designed for grid compliance. Set via Enphase Installer App/Portal (require Installer or Self-Installer credentials). Dynamic changes discouraged.
    - **Implementation Strategy**: Investigate as advanced installer-only option, or integrate as "virtual power limit" orchestrating Homey smart appliances to consume excess solar when exports limited.

- **Enphase IQ Battery Monitoring & Storage Profile Management**
  - *Description*: Integrate Enphase IQ Batteries. Monitor telemetry (SOC%, power flow). Configure storage modes, grid charging.
  - *Technical Feasibility*:
    - **Monitoring (Local API)**: Highly feasible. Endpoints `/ivp/ensemble/inventory` and `/ivp/ensemble/status` provide real-time battery status, SOC%, charge/discharge power (require local JWT authentication).
    - **Control (Cloud API v4)**: Cloud API v4 has endpoints: `GET`/`PUT` `/api/v4/activations/{activation_id}/battery_mode` to change storage mode (Self-Consumption, Savings, Full Backup). Write endpoints may require higher-tier developer plan (Megawatt Plan).
    - **Control (Local API)**: Restricted on new firmware (8.2.x+). Local write actions to force grid charge/modify battery profiles not supported, deprecated.
    - **Implementation Strategy**:
      1. *Phase 1*: Expose Enphase Battery as separate Homey device: `measure_battery`, `measure_power`, storage status.
      2. *Phase 2*: Add flow actions to switch storage profiles via Cloud API v4 or advise use of built-in Enphase AI profiles while managing loads via Homey flows.