# AGENTS.md — Enphase Enlighten Maintainer for Homey

## Project Overview
Athom Homey Pro app (**nl.creitive.enlighten**), Homey SDK v3. Local monitor/control Enphase IQ Gateway (Envoy) via local network. Fetch real-time power metrics (solar production, home consumption, grid import/export), monitor individual microinverters, and control solar production status.

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
* `app.js` — Main app code (central background polling loop, device registration manager).
* `app.json` — Generated manifest. **DO NOT EDIT.** Edit `.homeycompose/` instead.
* `.homeycompose/` — Config composition folder.
  * `app.json` — App metadata, permissions.
  * `capabilities/` — Custom capabilities (e.g. `connected_inverters`, `last_update`, plus dynamic capabilities `measure_power.<serial>` and `inverter_status.<serial>`).
  * `discovery/` — Discovery specs.
  * `drivers/` — Composition helper templates and settings.
  * `flow/`, `locales/`, `screensavers/`, `signals/` — Flow cards, translations, and signals.
* `drivers/` — Device drivers.
  * `gateway/` — Enphase Solar driver (telemetry, production control).
  * `homeload/` — Enphase Home driver (home consumption monitoring).
  * `inverters/` — Enphase Solar inverters driver (handles dynamic inverter telemetry, status, and alerts).
* `lib/` — Shared libraries.
  * `EnvoyAuth.js` — Cloud JWT auth, cloud login scraping, local token verification, cookie caching.
  * `EnvoyApi.js` — Extends `EnvoyAuth`. Telemetry, local production control, token role validation.
  * `PairingHelper.js` — Centralized pairing helper (credential cache, UDP mDNS multicast scan fallback, pairing session setup).
  * `helpers.js` — Shared helper functions.
* `BACKLOG.md` — Feature backlog, battery research.
* `CHANGELOG.md` & `.homeychangelog.json` — Release changelogs.
* `docs/` — Documentation.
  * `adr/` — Architecture Decision Records (ADRs).
  * `PROTOCOLS.md` — Enphase Gateway API specifications (local and cloud).

---

## Architecture & Code Guidelines

### 1. Library Separation & Inherited Design
* **Auth vs API:** `EnvoyAuth.js` handle cloud JWT, scraping, session cookies. `EnvoyApi.js` inherit `EnvoyAuth`, handle telemetry, local production control.
* **Drivers:** Consume `EnvoyApi` through the centralized App registration manager. Never touch credentials, network/TLS agents, session cookies directly.

### 2. Architecture Decision Records (ADRs)
* Refer to the relative file paths in [docs/adr/](docs/adr/) for detailed architecture guidelines and technical decisions.

### 3. Memory Leak Prevention
* **Timers:** No global `setInterval`/`setTimeout`. Use `this.homey.setInterval` / `this.homey.setTimeout`.
* **Cleanup:** Clear all timers/listeners in `onUninit()` / `onDeleted()`.

### 4. Exception Safety & Resilience
* **Try/Catch:** Wrap network requests, background polling in try/catch block. Avoid crashes.
* **401 Retry:** Local Envoy 401 response → clear session cookie, fetch new cookie via JWT, retry request once.
* **JWT Persistence:** Do NOT delete cloud JWT on local failures (401, 503, timeout). Only wipe JWT if Cloud login API returns credential/validation errors.
* **Grace Period:** Wait 30 minutes polling errors before calling `setUnavailable()`.

### 5. Manifest Updates
* Root `app.json` generated. Edit `.homeycompose/` configs only.

### 6. Dark Mode & Color Scheme Support in Pairing Wizards
* **Forced Dark Mode Prevention:** Web browsers (like Edge and Chrome) attempt to auto-invert colors on webviews that do not explicitly declare dark mode support. This can cause light text in dark mode to be inverted to illegible dark text.
* **Declarations:** Always include `<meta name="color-scheme" content="light dark">` in the HTML head and set `color-scheme: light dark;` in the CSS `:root` block to signal native dark mode compatibility and prevent forced color inversion.
* **List Elements Layouts:** Avoid using generic `ul` and `li` tags for custom inline lists (e.g. warnings, logs) in pairing wizards, as Homey's global stylesheet applies 78px height and default light text colors to all list items (designed for device listings). Use flexbox-based `div` layout classes (like `.warning-item`) instead.

---

## Git & Workflow Guidelines
* **Commit & Push Policy:** NEVER commit or push changes unless explicitly asked to by the user.
* **Work Progress Signal:** Proactively signal that there are uncommitted or unpushed changes, especially when starting a new task.

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