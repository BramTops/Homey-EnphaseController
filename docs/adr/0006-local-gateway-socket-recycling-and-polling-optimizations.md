# ADR 6: Local Gateway Socket Recycling & Polling Optimizations

## Status
Accepted

## Date
2026-05-29

## Context
When performing local status polling of the Enphase IQ Gateway (Envoy), the application executes two sequential HTTP requests every polling cycle: `/mode/power` followed immediately by `/production.json`.

To avoid CPU-heavy SSL/TLS handshake loops on the gateway's limited processor, we previously implemented HTTP Keep-Alive. However, standard Node.js Keep-Alive behavior holds the TCP socket open indefinitely in the background pool. Because the Envoy is an embedded gateway with a very small maximum concurrent connection limit (typically 4 to 8 slots), holding sockets open indefinitely creates two major problems:
1. **Socket Starvation:** Sockets are kept occupied even when inactive, preventing other integrations (such as the official Enphase Homey app, Home Assistant, or home automation scripts) from connecting.
2. **Gateway CPU Overloading:** Querying the slow `/production.json` endpoint (which takes 1.6s to 9.3s to compile internally) every 60 seconds places a significant processing load on the Envoy, occasionally leading to request timeouts.

Furthermore, the Envoy gateway only refreshes its internal power metrics and inverter telemetry every 5 minutes. Polling every 60 seconds is redundant because the underlying data is static for 5-minute windows.

## Decision
We decided to optimize both connection lifetimes and polling frequencies:
1. **Idle Socket Recycler:** We configured a socket idle `timeout: 4000` (4 seconds) on our custom `https.Agent`. Sockets remain hot and are reused for sequential requests *during* a poll, but are automatically closed and destroyed by Node's agent pool 4 seconds after the poll is completed.
2. **Generous Request Timeout:** We increased the fetch timeout specifically for the heavy `/production.json` endpoint to `30000` (30 seconds) to absorb slow internal Envoy compilation spikes. Other endpoints were raised to `15000` (15 seconds).
3. **Polling Reduction:** We doubled the background status polling interval from `60000` (60 seconds) to `120000` (120 seconds / 2 minutes).

## Consequences
* **Pros:**
  * **Zero Coexistence Conflicts:** Sockets are released quickly, allowing our integration to play perfectly with other smart home systems querying the gateway.
  * **Eliminated Timeouts:** Slow `/production.json` compiles are allowed to finish successfully instead of aborting at a tight 10-second limit.
  * **50% CPU Load Reduction:** Querying every 2 minutes cuts request overhead on the Envoy in half while keeping Homey's UI highly accurate relative to the Envoy's 5-minute internal update cycle.
* **Cons:**
  * In the event that the Envoy resets its production state due to its hourly cloud sync, Homey will take up to 2 minutes (instead of 1 minute) to detect and re-apply the user's manual override state. This is an entirely acceptable latency trade-off.
