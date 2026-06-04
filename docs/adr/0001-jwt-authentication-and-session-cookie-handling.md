# ADR 1: Local JWT Authentication and Session Cookie Handling

## Status
Accepted

## Date
2026-05-26

## Context
With the introduction of Enphase Envoy D7 and D8 firmware (7.x/8.x+), Enphase changed the security model for local Envoy gateway endpoints. Traditional HTTP Basic authentication (`admin` + password) and simple local API tokens were deprecated. 

To perform control actions locally (such as calling the `/ivp/mod/603980032/mode/power` endpoint to toggle power production), the client must authenticate using modern token-based authorization. However, simply using a Bearer token in the `Authorization` header is insufficient for write commands; the gateway requires a multi-step session check.

## Decision
We decided to implement a dual-token authentication flow in `lib/EnvoyApi.js`:
1. **Cloud Auth (Token Fetching):** We authenticate with the Enphase Cloud Enlighten API (`https://enlighten.enphaseenergy.com/login/login.json`) using the user's email and password to retrieve a `session_id`.
2. **Entrez Token:** We call Enphase's Entrez token service (`https://entrez.enphaseenergy.com/tokens`) providing the `session_id` and the gateway's serial number to generate a signed JSON Web Token (JWT).
3. **Local JWT Check & Cookie Generation:** We send this JWT to the local gateway at `https://<envoy_ip>/auth/check_jwt` via a GET request. If valid, the gateway responds with a `set-cookie` header containing a local session cookie.
4. **Combined Request Auth:** For all subsequent requests to local `/ivp/` endpoints, the API client passes **both** the Bearer token in the `Authorization` header and the session cookie in the `Cookie` header.
5. **Local JWT Expiration Check:** To avoid triggering rate-limited requests to Enphase Cloud, we locally parse the base64-encoded JWT payload and verify the `exp` (expiration) timestamp. Since the Entrez cloud-issued token is valid for 6 to 12 months, we reuse the stored token until it expires before requesting a new one.

## Consequences
* **Pros:**
  * Allows secure, authorized write actions directly on modern Enphase firmware (D7/D8).
  * Highly efficient; minimizes external Enphase Cloud HTTP calls by caching the token locally and checking expiration client-side.
  * Avoids login lockouts from Enphase cloud services.
* **Cons:**
  * Higher latency on initial setup or token renewal due to the multi-step handshake.
  * Requires internet access for the Homey Pro during initial pairing or whenever the token needs renewal (every ~6-12 months).
  * Requires storing the user's Enphase credentials (email/password) on the Homey Pro to facilitate automatic background token renewals when expiration occurs.
