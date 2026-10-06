# AGENTS.md — Enphase Controller for Homey

Athom Homey Pro app (**nl.creitive.enlighten**), SDK v3. Monitors/controls an Enphase IQ Gateway (Envoy) over the local network: solar production, grid, home consumption, individual microinverters, production on/off.

Use the **`homey-app`** skill for SDK v3, manifest and platform conventions.

## Reference
* [docs/PROTOCOLS.md](docs/PROTOCOLS.md) — Enphase gateway API (local + cloud) notes.
* https://github.com/vincentwolsink/home_assistant_enphase_envoy_installer — useful reference for local APIs.

## Layout
* `app.json` — **Generated. Never edit.** Edit `.homeycompose/` (app metadata, capabilities, flow cards, locales, driver templates/settings, discovery) instead. Root `locales/` is also generated.
* `app.js` — Central polling loop and device registration manager.
* `drivers/` — One folder per driver. Devices never talk to the gateway directly; they register with the app and consume `EnvoyApi` through it.
* `lib/EnvoyAuth.js` — Cloud JWT login, local token verification, session-cookie cache.
* `lib/EnvoyApi.js` — Extends `EnvoyAuth`. Telemetry, local production control, token role validation.
* `lib/PairingHelper.js` — Shared pairing logic (credential cache, mDNS scan, session setup).
* `docs/PROTOCOLS.md`, `BACKLOG.md`, `CHANGELOG.md`, `.homeychangelog.json`.

## Code rules
* **Credentials/transport:** Device and driver code never touches credentials, TLS agents or session cookies. That stays in `lib/`.
* **Gateway addressing:** Runtime connections use IP only (no hostname/`envoy.local`/DNS). Pairing auto-detects IP and serial (Homey mDNS discovery → direct UDP mDNS scan → reuse from an already-paired device) and always keeps manual IP/serial input as a fallback.
* **Timers:** Only `this.homey.setInterval` / `this.homey.setTimeout`. Clear all timers/listeners in `onUninit()` / `onDeleted()`.
* **Errors:** Wrap network requests and polling in try/catch; polling must never crash the app.
* **401:** Clear the session cookie, fetch a new one via the JWT, retry once.
* **JWT:** Never delete the cloud JWT on local failures (401, 503, timeout). Only wipe it when the cloud login API rejects the credentials.
* **Availability:** Wait 30 minutes of continuous polling errors before `setUnavailable()`.
* **Localization:** All user-visible strings in English and Dutch.

## Pairing views
* Include `<meta name="color-scheme" content="light dark">` in `<head>` and `color-scheme: light dark;` in `:root`. Without it, Edge/Chrome webviews force-invert colors and light text becomes illegible in dark mode.
* No generic `ul`/`li` for custom lists (warnings, logs). Homey's global stylesheet gives every `li` a 78px height and light text color. Use flexbox `div` classes (e.g. `.warning-item`).

## Store compliance
* **Brand name:** "Enphase Controller".
* **README.txt / README.nl.txt:** Plain text, no markdown/headers/lists/URLs, max 2 paragraphs.
* **Changelogs** (`CHANGELOG.md`, `.homeychangelog.json`): non-technical, outcome-focused, 3–6 words per line, no jargon/variables/config details. `.homeychangelog.json`: no `- ` prefixes, items separated by ` \n`, both `en` and `nl`.

## Workflow
* Proactively flag uncommitted/unpushed changes, especially when starting a new task.
* `npm run lint` — ESLint. `npm run version` — sync `.homeycompose/app.json` version from `package.json`. Homey CLI: `npx homey app run | validate | build`.
