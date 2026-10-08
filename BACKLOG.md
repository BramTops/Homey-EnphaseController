# Project Backlog

Track bugs, features, improvements, ideas for Enphase Controller app.

## Bugs
- Empty

## Small changes / ToDo
- Add 12-digit validation to Gateway SN login input. Prevent users entering Site ID.

### Follow-ups from 2.0 review
- Distinct artwork for the Solar, Grid and Battery drivers; new Solar and deprecated Gateway share the name "Enphase Solar".
- Grid shows no home power when the system has no home consumption meter (same as Home load).
- Battery absence is only proven by a definitive inventory answer; a 404 on `/ivp/ensemble/power` alone leaves "battery present?" unknown (home power stays empty without a consumption meter).
- New drivers keep credential checks in device/driver code (copied from legacy); move into a single `lib/` helper, and stop returning the JWT/password to pairing views.
- New drivers' settings forms require email/password; check whether `poll_interval` can be saved alone.
- Prune `apiInstances` when the last device of a serial is removed; socket reuse on the fast tier; limiter slot is released at response headers (body streams after).
- Dead code: `notifyDeprecatedEnvoyDriver` wrapper and its setting/timeline key; pre-existing unused locale keys (`pair.start.discovery_badge`, `pair.start.warning_no_consumption`, `driver.envoy.status.*`).
- `scanMdnsDirect` can return link-local (fe80) addresses.
- Solar device (`drivers/solar/device.js`) edge cases:
  - Repair when the device never registered, the new serial conflicts and validation fails: restore picks the new serial; self-heals at the 5-minute recheck.
  - Restore after a rejected settings edit may run the DPEL write probe on a gateway that was already working.
  - Role change while `unverified` can leave PEL capabilities missing until the next role/metered change.
  - Only one 15 s quick retry; `destroyed`/flag init in `onInit` happens after the capability-add awaits; an unverified device shows no message.
  - `user_email`/`password` app settings are not rolled back on a rejected repair.


## Proposed Features

- **Toggle production on/off through the Enphase Installer Cloud API**
  - *Description*: Control power production via official Enphase Installer Cloud API (v4) instead of local Envoy API.
  - *Documentation*: [Enphase Developer Portal Docs](https://developer-v4.enphase.com/docs.html)
  - *Benefits*: Backup method to toggle production, bypass local network issues, remain stable across local IQ Gateway firmware updates.

- **Enphase IQ Battery Control and Compatibility**
  - *Current knowledge (July 2026)*:
    - **Local monitoring is feasible**: The authenticated IQ Gateway endpoints `/ivp/ensemble/inventory`, `/ivp/ensemble/status`, and `/ivp/ensemble/power` expose aggregate and per-battery state of charge, charge/discharge power, temperature, communication state, operating state, and last-report time. Exact fields vary by battery generation and Gateway firmware.
    - **Cloud monitoring is available**: Enphase API v4 exposes device inventory, latest telemetry, site-level battery telemetry, battery lifetime data, and supported device-level battery telemetry. Cloud monitoring requires a separate OAuth 2.0 access token and API key; the local Gateway JWT used by this app is not sufficient.
    - **Local control is no longer dependable**: Starting with IQ Gateway firmware `8.2.4225`, local REST writes for storage mode, reserve state of charge, and charge-from-grid are rejected or ignored. Keep local tariff and battery-setting endpoints as research references only; do not build user-facing control around them.
    - **Official cloud control exists**: Enphase added `GET`/`PUT /api/v4/activations/{activation_id}/battery_mode` in 2025 for battery mode and charge/discharge settings. Availability depends on account role, API product/access controls, region, and system configuration. It requires OAuth/API-key infrastructure that this app does not currently have.
    - **Regional restrictions apply**: Charge-from-grid and some storage profiles may be unavailable because of local regulation, tariff, installer configuration, or missing IQ System Controller hardware.
  - *Shipped in 2.0*: A local, aggregate, read-only Battery device reports charge level, signed power, and charged/discharged energy. Energy totals fall back to estimates when gateway counters are unavailable. The Energy Flow widget also visualizes battery readings.
  - *Remaining work*:
    1. Collect anonymized fixtures for IQ Battery 3/3T, 5P, and newer generations across European and North American systems; confirm optional fields, freshness, and sign conventions.
    2. Add battery Flow triggers/conditions only where Homey does not already provide equivalent cards.
    3. Investigate cloud control, OAuth 2.0, activation lookup, API-plan requirements, licensing, and App Store suitability before offering storage-mode, reserve, or grid-charge actions.
  - *References*: [Enphase API release notes](https://developer-v4.enphase.com/docs/release_notes), [Enphase API FAQ](https://developer-v4.enphase.com/docs/faq), [Home Assistant Enphase firmware limitation](https://www.home-assistant.io/integrations/enphase_envoy/#no-battery-controls)

- **Enphase IQ EV Charger Monitoring & Control**
  - *Current knowledge (July 2026)*:
    - **Cloud monitoring is supported**: Enphase API v4 provides EVSE details through `GET /api/v4/systems/{system_id}/devices`, current operating mode through `GET /api/v4/systems/{system_id}/latest_telemetry`, and device history through `GET /api/v4/systems/{system_id}/{serial_no}/evse_telemetry` and `.../evse_lifetime`. EV charger monitoring is included in the Watt developer plan, subject to its rate limits.
    - **Gateway REST support is not established**: No verified local IQ Gateway REST endpoint currently provides EV charger monitoring or control. Do not assume the charger appears in `/ivp/ensemble/*`.
    - **Cloud control is restricted**: EV Charger Control is listed for Enphase Partner access; VPP control is intended for approved aggregators, utilities, and other grid-services partners. It is not a general homeowner API.
    - **IQ EV Charger 2 supports partner integrations**: Enphase documents OCPP 1.6J/2.0.1 and local Modbus/TCP. Local EMS access still requires Enphase partner onboarding, owner authorization, OAuth token provisioning, and charger configuration; it is not an open, zero-configuration LAN API.
  - *Implementation plan*:
    1. **Cloud monitoring proof of concept**: Validate OAuth authorization, charger discovery, telemetry fields, update frequency, and rate-limit fit with a real charger.
    2. **Read-only Homey device**: Expose connection/fault state, operating mode, charging power, session/lifetime energy, and last update. Add charging-started, charging-stopped, fault, and disconnected Flow triggers.
    3. **Control feasibility gate**: Contact Enphase about Partner EV Charger Control and public Homey App Store distribution before designing pause/resume, current-limit, schedule, or charging-mode actions.
    4. **Local IQ EV Charger 2 research**: Evaluate Modbus/TCP only after Enphase confirms partner onboarding and supplies the register map and provisioning flow. Keep OCPP out of scope unless the app gains a suitable cloud service.
  - *References*: [Enphase API release notes](https://developer-v4.enphase.com/docs/release_notes), [Enphase developer plans](https://developer-v4.enphase.com/developer-plans), [Enphase installer plans](https://developer-v4.enphase.com/installer-plans), [IQ EV Charger 2 partner integrations](https://enphase.com/en-gb/download/iq-ev-charger-2-partner-integrations)
