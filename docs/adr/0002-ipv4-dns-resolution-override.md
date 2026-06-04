# ADR 2: Local IPv4 DNS Resolution Override

## Status
Superseded by [ADR 5](0005-ip-only-direct-gateway-connection.md)

## Date
2026-05-26

## Context
> [!WARNING]
> The DNS resolution mechanism described below was completely deprecated, removed, and superseded by [ADR 5](0005-ip-only-direct-gateway-connection.md). We no longer use hostnames (`envoy.local`) or custom DNS lookup overrides, and instead connect directly using raw IP addresses.

When attempting to connect to the Enphase IQ Gateway (Envoy) via its local IP or local hostname (e.g. `envoy.local` or `envoy`), standard Node.js network requests using `fetch` or `https` utilize the default system DNS lookup. 

In dual-stack home networks (which support both IPv4 and IPv6), the gateway or router may publish both A (IPv4) and AAAA (IPv6) records for the device. Node.js's default lookup mechanism frequently returns IPv6 link-local addresses for `.local` mDNS hostnames. Due to Node.js's architectural constraints with link-local addresses (which require interface scope specifiers like `%eth0` or `%en0` to be appended to the IP address to be routeable), requests to the IPv6 address fail with timeouts, connection errors (`EHOSTUNREACH`), or handshake failures.

## Decision
We decided to enforce IPv4-only resolution for local gateway requests within our API client `lib/EnvoyApi.js`:
1. **Custom DNS Lookup Function:** We implemented a `customLookup` function that wraps the native `dns.lookup`.
2. **Local Domain Filtering:** The custom lookup intercepts all queries where the hostname ends in `.local` (common for multicast DNS) or equals `'envoy'`.
3. **IPv4 Enforcement:** For these matched hostnames, we explicitly set `options.family = 4` to force Node's DNS resolver to only retrieve and return the IPv4 address.
4. **HTTPS Agent Integration:** We created a custom `https.Agent` configured with `rejectUnauthorized: false` (to bypass self-signed certificate warnings on the Envoy) and passed this `customLookup` as the custom lookup resolver. This HTTPS agent is supplied to all local HTTP `fetch` calls.

```javascript
const customLookup = (hostname, options, callback) => {
  const opts = Object.assign({}, options);
  if (typeof opts.family === 'undefined' && (hostname.endsWith('.local') || hostname === 'envoy')) {
    opts.family = 4;
  }
  return dns.lookup(hostname, opts, callback);
};
```

## Consequences
* **Pros:**
  * Ensures rock-solid local HTTP connections to Enphase Envoy on modern home routers and dual-stack (IPv4/IPv6) networks.
  * Eliminates random 10-second request timeouts and connection errors caused by unrouteable IPv6 link-local addresses.
  * Operates entirely within the application layer without requiring users to configure specialized static network routes or disable IPv6 on their Homey Pro or router.
* **Cons:**
  * If a user's network is strictly IPv6-only, local connections will fail (though this is extremely rare in residential environments hosting smart home devices).
