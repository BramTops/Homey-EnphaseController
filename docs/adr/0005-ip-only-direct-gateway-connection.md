# ADR 5: Deprecate envoy.local in Favor of Direct IP Gateway Connections

## Status
Accepted

## Date
2026-05-29

## Context
Previously, the Homey Enphase application relied heavily on the standard multicast DNS (mDNS) hostname `envoy.local` as the fallback address for local communication with the Enphase IQ Gateway.

However, mDNS resolution is notoriously unstable across diverse residential network setups (e.g., VLAN segmentation, poor multicast routing, mesh networks, or custom DNS configurations). Standard unicast DNS servers do not know about `.local` domains, and Homey Pro's underlying Linux operating system lacks standard system-level integration for mDNS hostname resolution (i.e. `dns.lookup('envoy.local')` fails with `ENOTFOUND`).

Attempts to resolve or fall back to hostnames on the backend introduced significant code complexity, network latency, and potential polling failures.

## Decision
We decided to completely deprecate `envoy.local` as a persistent address, remove all custom DNS lookup wrappers/fallbacks, and transition to a pure Direct IP connection paradigm:

1. **Auto-Detection via Discovery Strategy ONLY:** During device pairing, we rely *exclusively* on the built-in Homey Pro discovery strategy payload. If mDNS discovery scanner captures the Envoy gateway broadcast, we extract the actual IPv4 or routeable IPv6 address directly from the payload.
2. **IP Pre-filling only:** If an IP is found via the discovery strategy, it is prefilled in the Gateway IP input box, showing a note "IP auto detected on your network". If not found, the field is left blank, showing a warning note prompting the user to input the IP address manually.
3. **Zero DNS Lookups on Backend:** We removed **all** uses of `dns.lookup` and manual hostname resolution. The `EnvoyApi` client, pairing handlers, and device settings flows operate on the raw IP addresses provided to them.
4. **Clean HTTPS Agent:** The custom `httpsAgent` inside `lib/EnvoyApi.js` was simplified by removing any custom DNS/family resolvers, leaving a clean connection agent.

## Consequences
* **Pros:**
  * Maximizes network stability by forcing direct IP-to-IP sockets, eliminating all mDNS lookup timeouts.
  * Significantly reduces code complexity by removing custom DNS resolvers, lookup fallbacks, and delayed settings sync loops.
  * Ensures compatibility with complex networks (VLANs, segmented mesh) where mDNS is blocked, by allowing manual IP configuration.
  * Hides complex network details from standard users, presenting a clean and direct pairing interface.
* **Cons:**
  * If the Envoy gateway does not have a DHCP reservation/static IP, and its IP changes, the user will have to manually update the IP setting in the Homey device settings.
