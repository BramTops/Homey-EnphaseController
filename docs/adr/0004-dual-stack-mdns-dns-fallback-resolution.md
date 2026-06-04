# ADR 4: Dual-Stack DNS Fallback Resolution & Early Verification

## Status
Accepted

## Date
2026-05-28

## Context
In ADR 2, we forced an IPv4-only DNS resolution (`opts.family = 4`) for `.local` and `envoy` domains. This was done to bypass Node.js's architectural constraints when resolving multicast DNS (mDNS) addresses to unrouteable IPv6 link-local addresses (starting with `fe80::`), which do not include the interface scope identifier (`%eth0`, `%en0`) required by Node's socket layer.

However, in some modern home network configurations (e.g. dual-stack environments or routers configured primarily with IPv6), the router/mDNS responder may publish a routeable global unicast IPv6 address (e.g. starting with `2a02:`) or unique local address (ULA, starting with `fd00::`) for the Envoy gateway (`envoy.local`), but *no* IPv4 record at all. In such cases, forcing IPv4-only resolution causes lookup requests to throw `getaddrinfo ENOTFOUND envoy.local` immediately, completely blocking local connections even though a valid, fully routeable IPv6 address is reachable on the network.

Furthermore, we previously only validated cloud JWT credentials (`fetchNewToken()`) during pairing and settings changes. We did not perform local connectivity checks (which fetch local session cookies from the gateway via `auth/check_jwt`). This meant that network configuration or DNS lookup issues were only discovered *after* a device had been added and status polling failed in the background.

## Decision
We decided to:
1.  **Refine DNS Resolution (`customLookup` in `lib/EnvoyApi.js`):** Implement a smart, two-phase fallback lookup:
    *   **Phase 1 (IPv4 Preferential):** Perform an IPv4 lookup first. If an IPv4 address is found, use it (maintaining the rock-solid IPv4 preference from ADR 2).
    *   **Phase 2 (Routeable IPv6 Fallback):** If Phase 1 fails (throws `ENOTFOUND`), fall back to performing an IPv6 lookup.
    *   **Routeability Validation:** For any resolved IPv6 address:
        *   If the address is link-local (starts with `fe80`), reject the lookup with a descriptive error because it cannot be routed without interface scopes in Node.js.
        *   If the address is routeable (e.g., global unicast or ULA), allow it to pass through to the request.
2.  **Enforce Connection Checking during Setup:**
    *   **Pairing (`driver.js`):** Run a local validation check (`api.getSessionCookie(token, true)`) during the `login` pairing handler.
    *   **Settings Updates (`device.js`):** Run the same check during settings verification when credentials or IP settings change.
    *   Any failures in these checks block saving or adding the device, surfacing the exact connection error to the user immediately.

## Consequences
*   **Pros:**
    *   **Maximized Network Compatibility:** Restores connection capabilities to systems operating on IPv6-only or dual-stack networks without A (IPv4) records.
    *   **Early Fault Detection:** Prevents users from adding a device or saving settings that are locally unreachable, improving the UX and clarifying system status immediately.
    *   **Preserved Safeguards:** Maintains the safety override from ADR 2 that prevents timeouts and connection errors caused by unrouteable link-local addresses.
*   **Cons:**
    *   Slightly increased latency when DNS resolution fails (requiring two successive DNS lookups instead of one), though this only occurs once during pairing/settings updates or during initial connection setup.
