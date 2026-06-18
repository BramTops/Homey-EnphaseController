# ADR 7: Individual Microinverter Telemetry & Monitoring

## Status
Accepted

## Date
2026-06-07

## Context
Homeowners want to monitor individual Enphase microinverters to track panel-level power generation, check active operational statuses, and quickly identify underperforming or offline panels. 

The Envoy gateway exposes microinverter telemetry locally at `/api/v1/production/inverters`, which requires local JWT session token authentication.

## Decision
We decided to implement a dedicated `inverters` driver in Homey:
1. **Dynamic Capability Registration:** Instead of asking the user to manually pair a separate Homey device for each solar panel (which would clutter the Homey UI and flow list for systems with 10 to 40+ panels), we represent all microinverters under a single "Enphase Inverters" device. During initialization, the device reads the list of inverter serials from the store and dynamically adds `measure_power.<serial>` and `inverter_status.<serial>` capabilities.
2. **Alerts Engine:** The driver evaluates two conditions locally:
   - **Underperformance:** When average power drops to zero at the end of the day, it compares the daily peak energy of each panel against the median peak of all panels. If a panel's peak is below the median by a user-configured threshold (default 15%), an underperformance alert is raised.
   - **Stale/Offline:** If a panel has not reported telemetry in a user-configured window (default 24 hours), a stale/offline alert is raised.
3. **Repair Screen:** An interactive repair session displays the real-time status of each inverter, their current and peak power, operational status, active alerts, and provides settings to adjust thresholds or manually clear alerts.

## Consequences
* **Pros:**
  * Clean UI: Multi-panel systems are represented as a single device in the Homey dashboard.
  * Real-time anomaly detection alerts the homeowner to dirty, shaded, or failing panels.
  * Configurable alert thresholds via repair screen.
* **Cons:**
  * Requires dynamic capabilities, which may take a few seconds to register during the first run.
