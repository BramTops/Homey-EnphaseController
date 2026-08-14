# ADR 8: Centralized Polling & Device Coordination

## Status
Accepted

## Date
2026-06-07

## Context
In Homey, the standard driver pattern is for each device instance to poll the underlying API independently. 

For the Enphase integration, a user might pair multiple devices for a single Envoy gateway (e.g., an Enphase Gateway device, an Enphase Home device, and an Enphase Inverters device). If all these devices poll the Envoy local API independently, it would double or triple the HTTP request rate. Since the Envoy is an embedded system with tight resource limits (see ADR 6), redundant concurrent polls cause socket starvation, high CPU loads, and request timeouts.

Additionally, handling credentials validation, local session token/cookie refreshment, and network error grace periods across multiple independent devices leads to duplicate code and race conditions.

## Decision
We decided to centralize all background polling loops in the main `App` class (`EnphaseController` in `app.js`):
1. **Central Device Manager:** The App manages maps of active shared `EnvoyApi` client instances, registered devices, and active polling timers.
2. **Device Registration:** When a device (Gateway, Home, or Inverters) initializes, it calls `this.homey.app.registerDevice(serial, this)`. When deleted or uninitialized, it calls `unregisterDevice(serial, this)`.
3. **Coordinated Polling:** A single central timer runs per Envoy serial number (every 120 seconds). When triggered, it queries both production and inverter data in a single sequence using a shared `EnvoyApi` client, and then dispatches the relevant telemetry data back to all registered devices for that serial.
4. **Unified Error Handling:** The App tracks polling failures. A 30-minute grace period prevents marking devices offline for transient errors. If credentials validation fails, the App clears the cached tokens across all registered devices.

## Consequences
* **Pros:**
  * Drastically reduces network traffic and API queries on the Envoy gateway.
  * Eliminates concurrent API requests and socket collision from the same App.
  * Centralizes session cookie (JWT) management and error recovery.
* **Cons:**
  * Tight coupling between the App lifecycle and the device update loops.
