# ADR 9: Centralized Pairing & Direct mDNS Scanning Fallback

## Status
Accepted

## Date
2026-06-07

## Context
Homey's built-in discovery strategy `enphase-envoy` is sometimes unreliable, slow, or fails to find Envoy gateways, particularly in complex local networks with multiple VLANs, DNS configurations, or dual-stack IPv4/IPv6 architectures.

Additionally, standard pairing required users to enter their email and password each time they paired a new device (e.g. Gateway followed by Inverters), resulting in a repetitive and frustrating user experience.

## Decision
We decided to centralize pairing operations and add a direct raw network scanning mechanism:
1. **Centralized Pairing Helper:** We created `lib/PairingHelper.js` to manage the pairing session state, credential validation, role checking (System Owner vs Maintainer), and token updates uniformly for all drivers.
2. **Global Credentials Caching:** When a user successfully logs in during pairing, the credentials (email and password) are stored in Homey's global settings. Subsequent pairing sessions fetch these cached credentials to pre-fill the form fields.
3. **Direct UDP mDNS Scanner:** To bypass the limitations of Homey Pro's built-in mDNS discovery strategy, `PairingHelper.js` executes direct raw UDP queries on port 5353 using Node's `dgram` module. It queries the `_enphase-envoy._tcp.local` PTR record in parallel on IPv4 multicast (`224.0.0.251`) and IPv6 multicast (`ff02::fb`) and auto-fills the IP and serial on the pairing screen.

## Consequences
* **Pros:**
  * Drastically improves Envoy auto-detection rates.
  * Faster pairing flow with credentials pre-filling.
  * Direct UDP queries act as an autonomous fallback when Homey's built-in service is laggy or unavailable.
* **Cons:**
  * Raw network socket usage (`dgram`) is a low-level operation bypassing standard Homey API abstractions (retained as primary strategy, UDP scan is only a fallback).
