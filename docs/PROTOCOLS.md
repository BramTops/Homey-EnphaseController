# Enphase Gateway API Protocols

Local (LAN) and cloud API notes for the Enphase IQ Gateway (Envoy), Ensemble storage (IQ Battery, IQ System Controller) and microinverters.

## Evidence labels

* **Established**: implemented in `lib/` and used by this app (1.5.x), or stated in Enphase's technical brief ("Accessing IQ Gateway Local APIs or Local UI with Token-Based Authentication", January 2023, gateway software 7.0.x and later; cited as "Enphase brief").
* **Observed**: seen in a third-party source on one system; not independently confirmed. Main source: `nklerk/nl.nielsdeklerk.enphase` @ `728201bf` (MIT, 2026-08-29), one D8 firmware system, 3-phase, production CT plus net-consumption CT, two IQ Batteries ("nklerk").
* **(unverified)**: carried over from earlier notes or secondary reading; no evidence in this repo or a pinned source. Do not build on it without a fixture.

Firmware naming used below (D5.x, D7.x, D8.x) comes from earlier notes.

---

## 1. Connection

* **Established:** HTTPS on port 443, self-signed certificate (certificate validation is disabled). Connect to a raw IP (IPv6 in square brackets); never `envoy.local` or other hostnames. mDNS names proved unreliable (not resolvable on Homey Pro, blocked on VLAN/mesh networks).
* **Established:** one shared keep-alive agent with a 4 s idle socket timeout. The gateway has few concurrent connection slots; idle sockets starve other clients and cause timeouts. The exact slot count (earlier notes say 4 to 8) is (unverified).
* **Established:** request timeouts 30 s for `/production.json`, 15 s for other endpoints (10 s for the cached `/ivp/meters` config read).
* **Observed (earlier maintainer measurements):** `/production.json` takes 1.6 to 9.3 s to compile on the gateway. It is the expensive call; `/ivp/meters/readings` and `/ivp/ensemble/power` are lighter (nklerk polls both every 2 s).
* **Data freshness is unresolved.** The Enphase brief says meter readings, per-inverter data and the consumption report update every 5 minutes. nklerk polls readings every 2 s and treats them as live. Prefer per-source timestamps (`readingTime`, `timestamp`, `lastReportDate`) over arrival time, and do not assume a 5-minute cadence for every endpoint.
* **Observed (nklerk):** `GET /info.xml` is unauthenticated and contains the gateway serial as `<sn>...</sn>`. Not used by this app yet.

---

## 2. Authentication

Gateway software 7.0.x and later requires a JWT for local endpoints (Enphase brief). Legacy gateways with an LCD do not.

### 2.1 Cloud JWT (established)

**Path A: Enlighten JSON API** (also the Enphase brief's programmatic flow)
1. `POST https://enlighten.enphaseenergy.com/login/login.json`, form fields `user[email]`, `user[password]` -> JSON with `session_id`.
2. `POST https://entrez.enphaseenergy.com/tokens`, JSON `{ "session_id", "serial_num", "username" }` -> plain-text JWT.

**Path B: Entrez portal scraping** (this app only; used when path A returns no installer/maintainer role; fragile because it parses HTML)
1. `GET https://entrez.enphaseenergy.com/login_main_page` -> cookies and CSRF token (`name="_csrf"`).
2. `POST https://entrez.enphaseenergy.com/login` (no redirect following), form `username`, `password`, `_csrf`, `authFlow=entrezSession`. Take updated cookies and CSRF token from the response.
3. `GET https://entrez.enphaseenergy.com/entrez_tokens` -> map the serial to its `Site` name in the dropdown; fall back to the serial itself (the GET can fail with 500 on plain owner accounts).
4. `POST https://entrez.enphaseenergy.com/entrez_tokens`, form `serialNum`, `Site`, `_csrf` -> JWT inside the `<textarea id="*JWT*">`.

The app tries A first and keeps that token when it carries a maintainer/installer role; otherwise it also tries B and prefers B only if B yields the higher role. Role comes from the JWT payload (`enphaseUser` or `roles` equal to `installer`/`maintainer`).

Other Enphase-documented ways to get a token: the web UI at `https://entrez.enphaseenergy.com`, or, when logged in to Enlighten, a browser GET of `https://enlighten.enphaseenergy.com/entrez-auth-token?serial_num=<serial>`, which returns the token and its expiry as an epoch timestamp (Enphase brief). Neither is used by the app.

**Token lifetime (Enphase brief):** System Owner tokens are valid for 1 year; Installer tokens for 12 hours. An installer who is also a system owner (self-installer) gets a 12-hour token from the web UI; the programmatic flow above is the alternative. The app relies only on the JWT `exp` claim.

### 2.2 Local session (established)
1. `GET https://<ip>/auth/check_jwt` with `Authorization: Bearer <JWT>` -> HTTP 200 and a `set-cookie` session cookie.
2. Send the Bearer header and the cached cookie on every local request. Cache the cookie: the gateway keeps few sessions, so re-running `check_jwt` per request evicts others.
3. On HTTP 401: drop the cached cookie, repeat step 1, retry the request once.
4. Never discard the JWT because of a local failure (401, 503, timeout). Only a cloud login rejection invalidates the credentials.

nklerk sends only the Bearer header (no cookie) and reads work (observed). Whether writes work without the cookie is (unverified).

---

## 3. Solar and meter telemetry (local)

### 3.1 `GET /ivp/meters` - CT configuration (established)
```json
[
  { "eid": 704643328, "state": "enabled", "measurementType": "production",
    "phaseMode": "split", "phaseCount": 2, "meteringStatus": "normal", "statusFlags": [] },
  { "eid": 704643584, "state": "enabled", "measurementType": "net-consumption",
    "phaseMode": "split", "phaseCount": 2, "meteringStatus": "normal", "statusFlags": [] }
]
```
* `state` `"enabled"` means the CT is active; `"disabled"` means installed but inactive.
* `measurementType`: `production`, `net-consumption`, `total-consumption`, or generic `consumption` (older firmware, D5.x and earlier per earlier notes). A generic `consumption` CT is ambiguous between grid and home; it needs configuration evidence.
* Production and consumption CTs can be enabled together. A storage CT may also be listed (storage meter with lifetime counters) (unverified; mentioned in the Enphase brief only as "storage" readings, hardware dependent).
* The config can change when an installer enables/disables a CT, so it should be refreshed rather than cached forever.

### 3.2 `GET /ivp/meters/readings` - CT measurements (established)
Array of meters matched by `eid`; each has `activePower` (W, signed), `actEnergyDlvd` / `actEnergyRcvd` (cumulative Wh), `voltage`, `current`, `freq`, `timestamp`, plus a `channels` array with the same fields per phase/line (Enphase brief sample).
* `actEnergyDlvd` = delivered (import for the net-consumption meter); `actEnergyRcvd` = received (export for the net-consumption meter).
* Net-consumption `activePower`: **+ import, - export**. Used by this app. nklerk also uses + = import but its own source comment says it was never verified against a clear import/export event, so treat the sign as plausible, not proven.
* Production meter `activePower` can be slightly negative at night; clamp to 0.

### 3.3 `GET /production.json` - aggregate (established)
```json
{
  "production":  [ { "type": "inverters", "activeCount": 12, "wNow": 3450, "whLifetime": 4567890, "readingTime": 1718467200 },
                   { "type": "eim", "wNow": 3452, "whLifetime": 4568100, "readingTime": 1718467200 } ],
  "consumption": [ { "type": "total-consumption", "wNow": 850, "whLifetime": 9876540, "readingTime": 1718467200 },
                   { "type": "net-consumption", "wNow": -2600, "whLifetime": 5308440, "readingTime": 1718467200 } ],
  "storage":     [ { "type": "acb", "wNow": 0, "whLifetime": 0, "percentFull": 0 } ]
}
```
Units: `wNow` W, `whLifetime` Wh.
* **Metered** (production CT): `production` has an `eim` entry; prefer it when enabled and `whLifetime > 0`. **Unmetered**: only the `inverters` entry (sum of reporting microinverters); `consumption` is absent, zero or a placeholder.
* **Consumption CT modes:** *total-consumption* (CT on the load side; always >= 0, net grid = load - solar) and *net-consumption* (CT on the mains; + import, - export, load = net + solar).
* **Firmware variations (handled by checking both `measurementType` and `type`):** older firmware names the consumption entries by `type` (`total-consumption`, `net-consumption`); D7.x/D8.x entries may all use `type: "eim"` and be told apart by `measurementType`.
* `storage` here is the legacy AC Battery shape. For IQ Battery use `/ivp/ensemble/*` (section 5).

### 3.4 `GET /api/v1/production/inverters` - microinverters (established)
```json
[ { "serialNumber": "121935144671", "lastReportDate": 1654171836, "devType": 1, "lastReportWatts": 15, "maxReportWatts": 38 } ]
```
Per-inverter last report and maximum reported watts; `lastReportDate` is epoch seconds. Updates every 5 minutes (Enphase brief).

### 3.5 Other local endpoints in the Enphase brief (not used by the app)
* `GET /ivp/livedata/status` - live meter data in **milliwatts**: `meters.soc`, `enc_agg_soc`, `enc_agg_energy`, `acb_agg_soc`, `backup_soc`, `main_relay_state`, `gen_relay_state`, and `pv` / `storage` / `grid` / `load` / `generator` blocks with `agg_p_mw`, `agg_s_mva` (and per-phase `_ph_a/b/c_`). In the brief's sample, `pv` 329549 and `load` 108749 give `storage.agg_p_mw` = -220800: storage **negative while charging, positive while discharging**, which matches the raw `/ivp/ensemble/power` sign below. Also returns MQTT/connection state and counters.
* `GET /ivp/meters/reports/consumption` - active/reactive/apparent power and cumulative energy of the load circuits (`cumulative` plus per-line `lines`, `reportType` `net-consumption`). Updates every 5 minutes.

---

## 4. Production control (local)

### 4.1 Power toggle (established)
* `GET` / `PUT https://<ip>/ivp/mod/603980032/mode/power`. GET returns `{ "powerForcedOff": false }`.
* PUT, `Content-Type: application/x-www-form-urlencoded`, JSON-text body: force off `{"length":1,"arr":[1]}`, normal `{"length":1,"arr":[0]}`.
* The app only reads or writes it with an installer/maintainer token.
* **Hourly re-enable (observed by earlier maintainers; not Enphase-documented):** the gateway syncs with Enphase Cloud at the top of each hour and the cloud default (production enabled) overwrites the local forced-off state. Poll the state and re-apply when the target is OFF.

### 4.2 Dynamic production/export limit, DPEL (established, undocumented by Enphase)
* `GET` / `POST https://<ip>/ivp/ss/dpel`. Requires an installer/maintainer token and a metered gateway; not functional on unmetered systems.
* POST JSON body: `{ "dynamic_pel_settings": { "enable", "export_limit", "limit_value_W", "slew_rate", "enable_dynamic_limiting": false }, "filename": "site_settings", "version": "00.00.01" }`. `export_limit` true limits net grid export; false limits absolute solar production. `limit_value_W` and `slew_rate` are sent as decimal numbers.
* The app uses a 0 W production limit as "off" on metered gateways instead of `powerForcedOff`. The reason (forced-off also opens the production contactor and is believed to cut battery/contactor communications) is an earlier maintainer finding, (unverified).
* Stability on firmware 7.x/8.x is (unverified); the app test-writes DPEL at pairing and restores the previous values.
* `/ivp/ss/der_settings` and `/ivp/ss/pcs_settings` (grid-profile limits) are listed in earlier notes but never called by the app: (unverified).

---

## 5. Storage: IQ Battery and Ensemble (local read)

Source for the two endpoints below: **observed in nklerk/nl.nielsdeklerk.enphase @728201bf on one D8 system** (two batteries, one IQ System Controller). Field lists are what that source reads or what its fixtures contain; other batteries, generations and firmware may differ.

### 5.1 `GET /ivp/ensemble/power` - live battery power (observed)
* Per-device list under the key `devices`, or the literal key **`devices:`** (with the colon) on the observed firmware. Handle both.
* Fixture keys per device: `serial_num`, `real_power_mw`, `apparent_power_mva`, `soc` (percent).
* **Unit:** `real_power_mw` is **milliwatts** (`-469000` = -469 W). Divide by 1000 for W.
* **Sign (raw): positive = discharging, negative = charging.** Confirmed by nklerk against the Enlighten live view once (raw -842 W = "charging 0.9 kW"); consistent with the Enphase brief's `livedata` sample (section 3.5).
* Not established: a watts-only field for older firmware. nklerk falls back to `realPower` and assumes watts (a guess, no real fixture). Earlier notes also list `real_power_w` under the *inventory* endpoint with the same sign, but no source shows it: (unverified).
* Aggregation: nklerk sums power over devices and averages `soc` unweighted. No per-battery capacity is read from this endpoint.

### 5.2 `GET /ivp/ensemble/inventory` - device inventory (observed)
Array of groups `{ "type": "...", "devices": [...] }`.
* `type: "ENCHARGE"` (IQ Battery) devices: `serial_num`, `percentFull` (state of charge, percent), `reported_enc_grid_state` (seen: `grid-tied`).
* `type: "ENPOWER"` (IQ System Controller) devices: `mains_oper_state` (seen: `closed`; `open` means off-grid), `Enpwr_grid_mode` (seen: `multimode-ongrid`).
* nklerk derives grid-tie status from ENPOWER first, then ENCHARGE; the off-grid values it tests for (`open`, `off-grid`/`island`) were not seen live.
* **`percentFull` vs `soc` disagree in nklerk's own fixtures** (power `soc` 58 / 55 vs inventory `percentFull` 41 / 38 for the same two serials). Either they were captured at different times or the sources differ. Which is authoritative is unproven; do not mix them inside one aggregate.
* `part_num` (battery model, e.g. `830-00001-r01`; wanted to tell battery models apart) and `encharge_capacity` (per-unit capacity): not read by nklerk; (unverified on our hardware; used by pyenphase). Handle them as optional until a real fixture confirms them.
* Other fields from earlier notes, not read by nklerk (unverified): `installed`, `temperature`, `operating`, `communicating`, `device_status`, `last_rpt_date`.

### 5.3 Other storage endpoints (all unverified: listed in earlier notes, never called by the app)
* `GET /ivp/ensemble/status` - aggregate state: `agg_soc`, operating and grid state.
* `GET` / `POST /ivp/ensemble/dry_contacts` and `/ivp/ss/dry_contact_settings` - relays on the System Controller.
* `GET` / `PUT /admin/lib/tariff.json` - storage `mode` (`self-consumption`, `savings`, `backup`), `charge_from_grid`, `reserve_soc`.
* `GET` / `PUT` / `DELETE /admin/lib/acb_config.json` - legacy AC Battery (ACB) sleep/config.

### 5.4 Firmware limit on local battery writes
From IQ Gateway firmware 8.2.4225, local writes for storage mode, reserve SoC and charge-from-grid are rejected or ignored (BACKLOG research, July 2026, citing Home Assistant's `enphase_envoy` documentation). Treat local tariff/battery-setting endpoints as research references only; control goes through the cloud API (section 7).

---

## 6. IQ EV Charger

Summary of the July 2026 research recorded in `BACKLOG.md`; none of it is verified against a real charger.
* **No local gateway REST API** for EV charger status or control is established. Do not assume it appears under `/ivp/ensemble/*`.
* **Cloud monitoring (Enphase API v4):** `GET /api/v4/systems/{system_id}/devices`, `GET /api/v4/systems/{system_id}/latest_telemetry`, `GET /api/v4/systems/{system_id}/{serial_no}/evse_telemetry` and `.../evse_lifetime`. Included in the Watt developer plan, subject to rate limits.
* **Control is partner-restricted** (EV Charger Control / VPP control are not a general homeowner API).
* **IQ EV Charger 2:** OCPP 1.6J/2.0.1 and local Modbus/TCP exist but need Enphase partner onboarding, owner authorization and charger configuration.
* Earlier notes listed `activations/{activation_id}/ev_charger/status|control` endpoints; no source supports them and BACKLOG does not repeat them. Disproven/unsupported, dropped.

---

## 7. Enphase Cloud API v4

Separate from the gateway JWT: needs an API key and OAuth 2.0 user authorization. Base URL `https://api.enphaseenergy.com/api/v4`.
* Monitoring: device inventory, latest and lifetime telemetry, site-level battery telemetry.
* Battery mode: `GET` / `PUT /api/v4/activations/{activation_id}/battery_mode` (added 2025). Earlier notes show a body `{ "battery_mode": "self-consumption" | "savings" | "backup", "reserve_soc": 20 }`; the exact schema is (unverified).
* Availability of reads and writes depends on the developer plan (earlier notes: reads on the Watt plan, writes on higher plans: unverified), account role, region and system configuration. Charge-from-grid and some profiles may be blocked by regulation, tariff or missing System Controller hardware.
