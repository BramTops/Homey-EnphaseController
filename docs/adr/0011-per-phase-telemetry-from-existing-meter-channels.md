# ADR 11: Per-Phase Telemetry from Existing Meter Channels

## Status
Accepted

## Date
2026-08-16

## Context
Owners of 3-phase installations want to see how solar production and household load are distributed across L1, L2 and L3. Uneven phase loading matters in practice: an EV charger or heat pump on a single phase can push that phase towards its fuse limit while the other two sit idle, and the aggregate figure the app shows today hides this entirely.

Two candidate sources exist on the gateway.

**`/ivp/livedata/status`** returns aggregate and per-phase values for PV, grid, load and storage in milliwatts. It was documented in `docs/ENPHASETECHNICALBRIEF.md` but deliberately never implemented, on the assumption that it required activating the MQTT live stream (`/ivp/livedata/stream/`) and that keeping that stream alive would put the kind of permanent load on the gateway that ADR 0006 exists to avoid.

That assumption was tested against a live IQ Gateway Metered (3-phase, firmware D8.3.5289) on 2026-08-16. Findings:

* `sc_stream` reports `disabled` and the response carries the notice *"Last available status data shown. Live stream not enabled."*, yet the payload is **not** frozen. Polling every 15 seconds showed `last_update` advancing by exactly 15 seconds each time, with per-phase values moving. What the stream toggle controls is the MQTT push, not the refresh of the underlying snapshot.
* The endpoint is cheap: 0.16–0.18 s per call at 3.6 kB, against 1.06–2.04 s for `/production.json` on the same gateway. The ADR 0006 concern about slow endpoints does not apply to it.

So the endpoint was viable. It was nonetheless rejected, for a different reason: **the data is redundant.**

`/ivp/meters/readings` — which this app already fetches on every poll to enrich lifetime import/export figures — returns a `channels[]` array per meter, one entry per phase, each carrying `activePower`, `voltage`, `current`, `pwrFactor` and cumulative energy. Compared side by side at the same moment:

| | `/ivp/livedata/status` | `/ivp/meters/readings` |
|---|---|---|
| PV total | 5035 W | 5035 W |
| PV per phase | 1888 / 242 / 2904 W | 1888 / 237 / 2910 W |
| Grid total | −4606 W | −4591 W |
| Grid per phase | −1707 / −110 / −2790 W | −1702 / −103 / −2786 W |

The residual differences are polling-timing artefacts. Everything `/ivp/livedata/status` offers is already arriving in a payload we parse and then discard.

The one value livedata reports that the meters endpoint does not is home `load`. On systems without a total-consumption CT the Envoy derives it as production + net-consumption; doing the same arithmetic per phase reproduced livedata's figure to within one polling interval (444 W derived against 428 W reported).

## Decision
1. **Reject `/ivp/livedata/status`.** Not because of gateway load, but because it duplicates data already retrieved. Adding it would mean a second endpoint, a second parser and a second failure mode for no new information.
2. **Extract per-phase values from the existing `/ivp/meters/readings` response.** `EnvoyApi.extractPhases()` maps `channels[]` to `activePower` and `voltage` per phase, and `getProductionData()` returns `solarpowerPhases`, `gridpowerPhases`, `homepowerPhases` and `phaseCount` alongside the existing aggregates. Zero additional requests.
3. **Derive home load per phase** as production + net-consumption when no total-consumption meter is enabled, matching the Envoy's own aggregate behaviour. Derived entries are flagged with `derived: true`.
4. **Expose the values as opt-in sub-capabilities.** The Enphase Solar device gains `measure_power.l1/l2/l3` (solar per phase); the Enphase Home device gains `measure_power.l1/l2/l3` (grid), `measure_power.home_l1/l2/l3` (household load) and `measure_voltage.l1/l2/l3`. Capabilities are added and removed dynamically, following the pattern established in ADR 0007 for per-inverter capabilities.
5. **Gate behind a device setting** (`phase_capabilities`, default off). Most installations are single-phase and would otherwise gain six empty tiles. The capabilities are also suppressed when the meter reports fewer than two channels, so enabling the setting on a single-phase system is harmless.

## Consequences
* **Pros:**
  * Per-phase visibility for 3-phase owners at no additional gateway cost — no new endpoint, no new request, no change to the polling interval, and nothing that touches the socket discipline of ADR 0006.
  * Phase voltage becomes available as a by-product, useful for spotting grid voltage rise that throttles inverter output.
  * Falls back cleanly: if `/ivp/meters/readings` fails, the existing `/production.json` path still supplies aggregates and the phase fields are simply null.
* **Cons:**
  * Per-phase values update at the standard 120-second poll interval. `/ivp/livedata/status` could deliver a faster refresh; if a use case ever justifies sub-minute phase data, that endpoint remains the route and the measurements above document its cost.
  * Home load per phase is arithmetic rather than measured on systems without a total-consumption CT. It agrees with the gateway's own derivation, but it is not an independent measurement.
  * Users on 3-phase systems must find and enable a setting. This is a deliberate trade against cluttering the far larger single-phase population.
