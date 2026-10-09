# AGENTS.md — Enphase Controller for Homey

Athom Homey Pro app (**nl.creitive.enlighten**), SDK v3. 
Monitors/controls an Enphase Inverters (PV), Battery, and grid trough the Envoy gateway over local network.

Use the **`homey-app`** skill for SDK v3, manifest and platform conventions.

## Reference
* [docs/PROTOCOLS.md](docs/PROTOCOLS.md) — Enphase gateway API (local + cloud) notes.
* https://github.com/vincentwolsink/home_assistant_enphase_envoy_installer — useful reference for local APIs.

## Rules
* Everything in `drivers/envoy/` en `drivers/gateway/` and `drivers/homeload/` is deprecated. Do not look at or modify.
* Architecture, credential/session handling, gateway addressing, polling, availability and pairing discovery are documented in comments in `app.js` and `lib/`. These rules apply across many files and have no single home:
* Generated files: `app.json` and root `locales/` are generated. Never edit. Edit `.homeycompose/` (app metadata, capabilities, flow cards, locales, driver templates/settings, discovery) instead.
* Timers: Clear all timers/listeners in `onUninit()` / `onDeleted()`. (Lint enforces `this.homey.setTimeout` / `setInterval`.)
* Errors: Wrap network requests and polling in try/catch; polling must never crash the app.
* Pairing views: Include `<meta name="color-scheme" content="light dark">` in `<head>` and `color-scheme: light dark;` in `:root`; without it, Edge/Chrome webviews force-invert colors and light text becomes illegible in dark mode. No generic `ul`/`li` for custom lists (warnings, logs): Homey's global stylesheet gives every `li` a 78px height and light text color, so use flexbox `div` classes (e.g. `.warning-item`).
* Store compliance: Brand name is "Enphase Controller". `README.txt` / `README.nl.txt` / `README.fr.txt` / `README.de.txt`: plain text, no markdown/headers/lists/URLs, max 3 paragraphs. Changelog rules are in the comment at the top of `CHANGELOG.md` (also covers `.homeychangelog.json`).

## Workflow
* Proactively flag uncommitted/unpushed changes, especially when starting a new coding task.
* `npm run version` syncs the `.homeycompose/app.json` version from `package.json`. Run it after bumping the version.
