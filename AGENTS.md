# AGENTS.md — Enphase Enlighten Maintainer for Homey

## Project Overview
Athom Homey Pro app (**nl.creitive.enlighten**), Homey SDK v3. Local monitor/control Enphase IQ Gateway (Envoy) via local network. Fetch real-time power metrics, control production status.

> [!TIP]
> Use active **`homey-app`** agent skill for standard SDK v3, CLI commands, manifest, leak prevention, platform guidelines.

---

## Reference Sources
* https://apps.developer.homey.app/ — Homey developer docs
* https://github.com/vincentwolsink/home_assistant_enphase_envoy_installer — HA Envoy installer (useful for local APIs)
* https://community.homey.app/ — Homey forums

---

## Tech Stack & Dependencies
* **Runtime:** Node.js (Homey SDK v3 compatible)
* **API Client:** ES6 JS, `node-fetch@2.7.0`
* **Security/Auth:** Enphase Cloud JWT mapped locally to Envoy session cookies.
* **Network/DNS:** Custom HTTPS agent, custom DNS resolver force IPv4 for `.local` and `envoy` addresses.

---

## Directory Structure
* `app.json` — Generated manifest. **DO NOT EDIT.** Edit `.homeycompose/` instead.
* `.homeycompose/` — Config composition folder.
  * `app.json` — App metadata, permissions.
  * `drivers/envoy/driver.compose.json` — Driver capabilities, discovery, pairing.
  * `capabilities/` — Custom capabilities (e.g. `connected_inverters`, `last_update`).
  * `discovery/` — Discovery specs.
* `drivers/` — Device drivers.
  * `envoy/`
    * `driver.js` — Pairing/discovery lifecycle, settings validation.
    * `device.js` — Capabilities, polling, production control.
* `lib/` — Shared libraries.
  * `EnvoyAuth.js` — Cloud JWT auth, cloud login scraping, local token verification, cookie caching.
  * `EnvoyApi.js` — Extends `EnvoyAuth`. Telemetry, local production control.
* `BACKLOG.md` — Feature backlog, battery research.
* `docs/adr/` — Architecture Decision Records (ADRs).

---

## Architecture & Code Guidelines

### 1. Library Separation & Inherited Design
* **Auth vs API:** `EnvoyAuth.js` handle cloud JWT, scraping, session cookies. `EnvoyApi.js` inherit `EnvoyAuth`, handle telemetry, local production control.
* **Drivers:** Consume `EnvoyApi`. Never touch credentials, network/TLS agents, session cookies.

### 2. Network & Socket Resource Stewardship
* **HTTPS Socket Reuse:** Use single static global `httpsAgent` (defined in `EnvoyAuth`) for local Envoy connections. Prevent socket exhaustion.
* **KeepAlive:** `httpsAgent` use keepAlive, short timeout (4s) to recycle idle sockets.

### 3. Memory Leak Prevention
* **Timers:** No global `setInterval`/`setTimeout`. Use `this.homey.setInterval` / `this.homey.setTimeout`.
* **Cleanup:** Clear all timers/listeners in `onUninit()` / `onDeleted()`.

### 4. Exception Safety & Resilience
* **Try/Catch:** Wrap network requests, background polling in try/catch block. Avoid crashes.
* **401 Retry:** Local Envoy 401 response → clear session cookie, fetch new cookie via JWT, retry request once.
* **JWT Persistence:** Do NOT delete cloud JWT on local failures (401, 503, timeout). Only wipe JWT if Cloud login API return credential/validation errors.
* **Grace Period:** Wait 30 minutes polling errors before call `setUnavailable()`.

### 5. Manifest Updates
* Root `app.json` generated. Edit `.homeycompose/` configs only.

### 6. ADRs
* Record architecture decisions in `docs/adr/XXXX-title.md` (sequentially numbered) using standard ADR structure (Status, Date, Context, Decision, Consequences).

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

## Commands

> [!IMPORTANT]
> **NO GIT**: Do not run any git commands (e.g., `git status`, `git diff`).

* `npm install` — Dependencies
* `npm run lint` — Linter
* `npx homey app run` / `validate` / `install` / `build` — Standard Homey CLI tools.

Enphase brand color: #F37321