# AGENTS.md — Enphase Enlighten Maintainer for Homey

## Project Overview
Athom Homey Pro app (**nl.creitive.enlighten**), Homey SDK v3. Local monitor/control Enphase IQ Gateway (Envoy) via local network. Fetch real-time power metrics, control production status.

> [!TIP]
> Use active **`homey-app`** agent skill for standard SDK v3, CLI commands, manifest, leak prevention, platform guidelines.

---

## Reference Sources
* [PROTOCOLS.md](docs/PROTOCOLS.md) — Detailed Enphase Gateway API specifications (solar, battery, charger, cloud).
* https://apps.developer.homey.app/ — Homey developer docs
* https://github.com/vincentwolsink/home_assistant_enphase_envoy_installer — HA Envoy installer (useful for local APIs)
* https://community.homey.app/ — Homey forums

---

## Tech Stack & Dependencies
* **Runtime:** Node.js (Homey SDK v3 compatible)
* **API Client:** ES6 JS, `node-fetch@2.7.0`
* **Security/Auth:** Enphase Cloud JWT mapped locally to Envoy session cookies.
* **Network/DNS:** Direct IP-only gateway connections. DNS wrappers and `envoy.local` resolutions are deprecated.

---

## Directory Structure
* `app.json` — Generated manifest. **DO NOT EDIT.** Edit `.homeycompose/` instead.
* `.homeycompose/` — Config composition folder.
  * `app.json` — App metadata, permissions.
  * `capabilities/` — Custom capabilities (e.g. `connected_inverters`, `last_update`, plus dynamic capabilities `measure_power.<serial>` and `inverter_status.<serial>`).
  * `discovery/` — Discovery specs.
  * `drivers/` — Composition helper templates and settings.
  * `flow/`, `locales/`, `screensavers/`, `signals/` — Flow cards, translations, and signals.
* `drivers/` — Device drivers.
  * `envoy/` — Legacy Envoy driver.
  * `gateway/` — Enphase Solar driver (telemetry, production control).
  * `inverters/` — Enphase Inverters driver (handles dynamic inverter telemetry, status, and alerts).
* `lib/` — Shared libraries.
  * `EnvoyAuth.js` — Cloud JWT auth, cloud login scraping, local token verification, cookie caching.
  * `EnvoyApi.js` — Extends `EnvoyAuth`. Telemetry, local production control, token role validation.
  * `PairingHelper.js` — Centralized pairing helper (credential cache, UDP mDNS multicast scan fallback, pairing session setup).
  * `helpers.js` — Shared helper functions.
* `BACKLOG.md` — Feature backlog, battery research.
* `docs/` — Documentation.
  * `adr/` — Architecture Decision Records (ADRs).
  * `PROTOCOLS.md` — Enphase Gateway API specifications (local and cloud).

---

## Architecture & Code Guidelines

### 1. Library Separation & Inherited Design
* **Auth vs API:** `EnvoyAuth.js` handle cloud JWT, scraping, session cookies. `EnvoyApi.js` inherit `EnvoyAuth`, handle telemetry, local production control.
* **Drivers:** Consume `EnvoyApi` through the centralized App registration manager. Never touch credentials, network/TLS agents, session cookies directly.

### 2. Centralized Polling & Device Coordination (ADR 8)
* **Central Device Manager:** Centralized background polling loops reside in the main `App` class (`EnphaseController` in `app.js`).
* **Device Registration:** Devices register with `this.homey.app.registerDevice(serial, this)` and unregister via `unregisterDevice(serial, this)` on uninitialization.
* **Coordinated Polling:** A central timer runs per Envoy serial number every 120 seconds. It queries production and inverter data in sequence using a shared `EnvoyApi` client, then dispatches the relevant telemetry to registered devices.

### 3. Network & Socket Resource Stewardship (ADR 5, 6)
* **Direct IP connections:** The integration connects directly using raw IP addresses. Unstable mDNS `envoy.local` resolutions and custom DNS resolvers are deprecated.
* **HTTPS Socket Reuse & Idle Recycler:** Use a single static global `httpsAgent` for local Envoy connections. Configured with a socket idle `timeout: 4000` (4s) to automatically close sockets and prevent Envoy socket starvation.
* **Request Timeout:** Set to `30000` (30s) for `/production.json` to handle slow internal compilation spikes; set to `15000` (15s) for other endpoints.

### 4. Hourly Cloud Sync Discrepancy Handling (ADR 3)
* **Discrepancy Detection:** Envoy gateways synchronize local settings with Enphase Cloud hourly, which overrides and re-enables production.
* **Enforced Re-application:** If Homey's target production state is OFF but Envoy reports production enabled, the driver automatically re-sends the `setPowerForcedOff(true)` command.

### 5. Dynamic Inverters Driver & Alerts (ADR 7)
* **Single Device Wrapper:** All microinverters are managed under one "Enphase Inverters" device. Capabilities `measure_power.<serial>` and `inverter_status.<serial>` are registered dynamically at runtime.
* **Alert Engine:** Compares panel peak energy against the median peak of all panels (default underperformance threshold is 15%). Flags panels as stale/offline if they do not report telemetry in a configured window (default 24 hours).
* **Repair Screen:** An interactive session displays inverter telemetry, active alerts, and allows configuration adjustments.

### 6. Centralized Pairing & UDP Scanner Fallback (ADR 9)
* **Pairing Helper:** `lib/PairingHelper.js` manages credential validation, token updates, and connection checks.
* **Credentials Caching:** Enlighten email/password are stored in Homey's global settings, pre-filling future pairing flows.
* **mDNS UDP Scanner:** Bypasses Homey's discovery lag by executing direct raw UDP queries on port 5353 using dual-stack IPv4/IPv6 multicast.

### 7. Memory Leak Prevention
* **Timers:** No global `setInterval`/`setTimeout`. Use `this.homey.setInterval` / `this.homey.setTimeout`.
* **Cleanup:** Clear all timers/listeners in `onUninit()` / `onDeleted()`.

### 8. Exception Safety & Resilience
* **Try/Catch:** Wrap network requests, background polling in try/catch block. Avoid crashes.
* **401 Retry:** Local Envoy 401 response → clear session cookie, fetch new cookie via JWT, retry request once.
* **JWT Persistence:** Do NOT delete cloud JWT on local failures (401, 503, timeout). Only wipe JWT if Cloud login API returns credential/validation errors.
* **Grace Period:** Wait 30 minutes polling errors before calling `setUnavailable()`.

### 9. Manifest Updates
* Root `app.json` generated. Edit `.homeycompose/` configs only.

### 10. ADRs
* Record architecture decisions in `docs/adr/XXXX-title.md` (sequentially numbered) using standard ADR structure (Status, Date, Context, Decision, Consequences).

### 11. Dark Mode & Color Scheme Support in Pairing Wizards
* **Forced Dark Mode Prevention:** Web browsers (like Edge and Chrome) attempt to auto-invert colors on webviews that do not explicitly declare dark mode support. This can cause light text in dark mode to be inverted to illegible dark text.
* **Declarations:** Always include `<meta name="color-scheme" content="light dark">` in the HTML head and set `color-scheme: light dark;` in the CSS `:root` block to signal native dark mode compatibility and prevent forced color inversion.
* **List Elements Layouts:** Avoid using generic `ul` and `li` tags for custom inline lists (e.g. warnings, logs) in pairing wizards, as Homey's global stylesheet applies 78px height and default light text colors to all list items (designed for device listings). Use flexbox-based `div` layout classes (like `.warning-item`) instead.

---

## Publication & Store Compliance

### 1. App Identity & README
* **Brand Name**: `"Enphase Controller"`.
* **README.txt**: Plain text only. No markdown, headers, lists, URLs. Max 2 paragraphs.

### 2. Changelogs (`CHANGELOG.md` & `.homeychangelog.json`)
* **Tone**: Non-technical, user-focused (outcome over implementation).
* **Format**: Max 3-6 words per line. No jargon, variables, config details.
* **`.homeychangelog.json` specific**:
  - No bullet prefixes (`- `).
  - Use ` \n` to separate items.
  - Provide English (`en`) and Dutch (`nl`) versions.

---

## Communication Style
* Always communicate using **caveman lite** mode as defined in `.agents/skills/caveman/SKILL.md` (no filler/hedging, keep articles and full sentences, professional but tight).

---

## Commands

* `npm install` — Dependencies
* `npm run lint` — Linter
* `npx homey app run` / `validate` / `install` / `build` — Standard Homey CLI tools.