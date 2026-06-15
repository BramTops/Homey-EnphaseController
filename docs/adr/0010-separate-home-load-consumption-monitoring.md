# ADR 10: Separate Home Load (Consumption) Monitoring

## Status
Accepted

## Date
2026-06-15

## Context
Homey users with metered Enphase IQ Gateways (Envoy) have physical current transformer (CT) clamps measuring total household consumption (home load).
However, representing solar production and household consumption under a single "Solar" device in Homey bloats the interface and makes it difficult for the user to integrate Enphase Home data into the Homey Energy Dashboard cleanly.

To track total home consumption, Homey expects a dedicated device (class `sensor`) that has the Homey "tracks total home energy consumption" setting enabled (`cumulative: true`).

## Decision
We decided to implement a separate driver called `homeload` (user-facing name: "Enphase Home"):
1. **Isolated Consumption Device:** The `homeload` driver creates a separate `sensor` device that registers capabilities for `measure_power` (current consumption in Watts), `meter_power` (total consumption in kWh), `meter_power_today` (daily reset consumption in kWh), and `last_update`.
2. **Total Home Energy Dashboard Integration:** Configure `"energy": { "cumulative": true }` in `driver.compose.json` to natively register the device as a household consumption tracker in Homey.
3. **Interactive Pairing Warnings:** Since consumption telemetry is only available on metered gateways with consumption CT clamps installed and active, the pairing screen fetches the gateway's meter status. If the gateway is not metered or consumption clamps are missing, the UI presents a warnings panel, but permits the user to bypass the warning and pair the device anyway.
4. **Coordinated Polling and Independence:** The device registers with the central App orchestrator, which fetches `/production.json` once per polling interval and distributes consumption data to the Home device, sharing connection/auth properties with other devices but operating fully independently if needed.

## Consequences
* **Pros:**
  * Clean segregation of solar generation and household consumption.
  * Native integration with Homey's energy dashboard (cumulative tracking).
  * Robust, warning-safe pairing flow that informs users of missing clamps without blocking pairing.
  * Shared polling prevents extra network requests to local gateway.
* **Cons:**
  * Requires user to pair a separate device if they want to track home consumption.
