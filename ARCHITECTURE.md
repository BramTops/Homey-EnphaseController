# Homey Enphase Controller Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              HOMEY APP (app.js)                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Central Polling Manager                                                        │   │
│  │  - Manages shared EnvoyApi instances per gateway serial                        │   │
│  │  - Coordinates device registration/unregistration                             │   │
│  │  - Runs 120-second polling loop per serial                                      │   │
│  │  - Dispatches telemetry to registered devices                                   │   │
│  │  - Handles token/IP propagation across devices                                  │   │
│  │  - Grace period (30 min) before setting devices unavailable                    │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Shared State Maps                                                             │   │
│  │  - apiInstances: Map<serial, EnvoyApi>                                         │   │
│  │  - registeredDevices: Map<serial, Set<Device>>                                │   │
│  │  - pollingIntervals: Map<serial, Timer>                                       │   │
│  │  - firstFailedPollTimes: Map<serial, Date>                                    │   │
│  │  - activePolls: Set<serial> (prevent concurrent polls)                         │   │
│  │  - pendingPolls: Set<serial> (queue follow-up polls)                           │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ getApiInstance(serial, ip, credentials)
                                        │ registerDevice(serial, device)
                                        │ unregisterDevice(serial, device)
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
        ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
        │  GATEWAY DRIVER   │ │  HOMELOAD DRIVER  │ │ INVERTERS DRIVER │
        │  (drivers/gateway)│ │(drivers/homeload)│ │(drivers/inverters)│
        └───────────────────┘ └───────────────────┘ └───────────────────┘
                    │                   │                   │
                    │ onPair()          │ onPair()          │ onPair()
                    │ onRepair()        │ onRepair()        │ onRepair()
                    │                   │                   │
                    ▼                   ▼                   ▼
        ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
        │ GATEWAY DEVICE    │ │ HOMELOAD DEVICE  │ │ INVERTERS DEVICE  │
        │ (device.js)       │ │ (device.js)      │ │ (device.js)       │
        └───────────────────┘ └───────────────────┘ └───────────────────┘
                    │                   │                   │
                    │ onInit()          │ onInit()          │ onInit()
                    │ registerDevice()  │ registerDevice()  │ registerDevice()
                    │ updateTelemetry() │ updateTelemetry() │ updateTelemetry()
                    │ onSettings()      │ onSettings()      │ onSettings()
                    │                   │                   │
                    ▼                   ▼                   ▼
        ┌─────────────────────────────────────────────────────────────────────────────┐
│                              LIBRARY LAYER                                           │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  PairingHelper (lib/PairingHelper.js)                                          │   │
│  │  - setupPairingSession(): Centralized pairing logic for all drivers           │   │
│  │  - scanMdnsDirect(): Dual-stack IPv4/IPv6 mDNS fallback discovery             │   │
│  │  - Credential validation and token testing during pairing                      │   │
│  │  - Meter status and DPEL support detection                                    │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  EnvoyApi (lib/EnvoyApi.js) extends EnvoyAuth                                  │   │
│  │  - getProductionData(): Solar, grid, home power metrics                       │   │
│  │  - getInvertersData(): Individual microinverter telemetry                     │   │
│  │  - getPowerForcedOffstate(): Production control state (unmetered)             │   │
│  │  - setPowerForcedOff(): Toggle production (unmetered)                         │   │
│  │  - getDpelSettings(): Dynamic PEL configuration (metered)                    │   │
│  │  - setDpelSettings(): Set dynamic production limit (metered)                  │   │
│  │  - getMetersConfig(): Meter configuration cache                               │   │
│  │  - getMeterReadings(): Detailed import/export readings                       │   │
│  │  - checkMeterStatus(): Detect metered/gridpower/homepower availability         │   │
│  │  - Background discovery listener for IP auto-update                            │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  EnvoyAuth (lib/EnvoyAuth.js)                                                 │   │
│  │  - getToken(): Validate existing JWT or fetch new one                          │   │
│  │  - validateToken(): Local JWT expiration check                                │   │
│  │  - evaluateTokenRole(): Decode JWT to check Maintainer/Installer role          │   │
│  │  - fetchNewToken(): Dual-path token acquisition                                │   │
│  │    ├─ fetchNewTokenViaApi(): Enlighten JSON API login                         │   │
│  │    └─ fetchNewTokenViaPortal(): Entrez web scraping (auto-upgrade path)       │   │
│  │  - getSessionCookie(): Authenticate JWT with local Envoy, cache session        │   │
│  │  - Shared httpsAgent: Keep-alive TLS socket pooling, self-signed cert bypass   │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        │ HTTPS requests
                                        │ (Bearer JWT + Session Cookie)
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                       │
                    ▼                                       ▼
        ┌───────────────────┐               ┌───────────────────┐
        │ ENPHASE CLOUD     │               │ LOCAL ENVOY       │
        │ enlighten.enphase │               │ GATEWAY           │
        │ energy.com        │               │ (IP on LAN)       │
        │                   │               │                   │
        │ - /login/login.json│              │ - /auth/check_jwt │
        │ - /tokens         │               │ - /production.json│
        │ (Entrez API)      │               │ - /ivp/meters     │
        │                   │               │ - /ivp/meters/    │
        │ entrez.enphase    │               │   readings        │
        │ energy.com        │               │ - /ivp/mod/603980 │
        │ (Web Portal)      │               │   032/mode/power  │
        │ - /login_main_page│               │ - /ivp/ss/dpel    │
        │ - /login          │               │ - /api/v1/        │
        │ - /entrez_tokens  │               │   production/     │
        │                   │               │   inverters       │
        └───────────────────┘               └───────────────────┘
```

## Data Flow

### 1. Pairing Flow
```
User initiates pairing → Driver.onPair() → PairingHelper.setupPairingSession()
    ↓
mDNS discovery (built-in + direct UDP fallback) → Auto-fill IP/Serial
    ↓
User enters credentials → PairingHelper login handler
    ↓
Create temp EnvoyApi → fetchNewToken() (dual-path: API + Portal)
    ↓
getSessionCookie() → Verify local Envoy connection
    ↓
getInvertersData() → Discover microinverter serials
    ↓
checkMeterStatus() → Detect metered/gridpower/homepower
    ↓
testProductionLimiting() → DPEL write test (if metered + maintainer)
    ↓
Store device data (token, role, meter status, inverter list)
    ↓
list_devices() → Save credentials globally to Homey settings
```

### 2. Polling Flow (120-second interval)
```
App.pollGateway(serial) triggered
    ↓
Check if poll already active (activePolls Set) → Queue if busy
    ↓
Get shared EnvoyApi instance (or create new one)
    ↓
Determine registered device types (gateway, homeload, inverters)
    ↓
Fetch telemetry based on device types:
    ├─ hasGateway/homeload → getProductionData()
    │   └─ hasInverters → getInvertersData()
    │
    ├─ If maintainer → getPowerForcedOffstate()
    │   └─ If metered + maintainer → getDpelSettings()
    ↓
Dispatch to devices:
    ├─ Gateway device → updateTelemetry(prodData, powerForcedOff, pelSettings)
    ├─ Homeload device → updateTelemetry(prodData)
    └─ Inverters device → updateTelemetry(invertersData)
    ↓
Set devices available
    ↓
On error: Track first failure time → 30-min grace period before unavailable
```

### 3. Authentication Flow
```
EnvoyApi.getToken()
    ↓
validateToken() → Check JWT expiration locally
    ↓
If expired/missing → fetchNewToken()
    ↓
Dual-path execution:
    ├─ Path A: fetchNewTokenViaApi()
    │   └─ POST enlighten.enphaseenergy.com/login/login.json
    │   └─ POST entrez.enphaseenergy.com/tokens
    │   └─ Evaluate role (isMaintainer?)
    │
    └─ Path B: fetchNewTokenViaPortal()
        └─ GET entrez.enphaseenergy.com/login_main_page (CSRF)
        └─ POST entrez.enphaseenergy.com/login (credentials)
        └─ GET entrez.enphaseenergy.com/entrez_tokens (site discovery)
        └─ POST entrez.enphaseenergy.com/entrez_tokens (JWT generation)
        └─ Evaluate role (isMaintainer?)
    ↓
Select best token (prefer Maintainer role)
    ↓
onTokenUpdated callback → Propagate to all devices with matching serial
    ↓
getSessionCookie(token) → POST local Envoy /auth/check_jwt
    ↓
Cache session cookie (prevent eviction tug-of-war)
```

### 4. Token/IP Propagation Flow
```
EnvoyApi token updated (via onTokenUpdated callback)
    ↓
App propagates to all devices with matching serial:
    ├─ Gateway devices → setStoreValue('enphase_token', newToken)
    ├─ Envoy legacy devices → setStoreValue('enphase_token', newToken)
    ├─ Inverters devices → setStoreValue('enphase_token', newToken)
    └─ Homeload devices → setStoreValue('enphase_token', newToken)
    ↓
Update device roles via updateRole(isMaintainer)
    ↓
Dynamic capability add/remove based on role (PEL capabilities)
```

```
EnvoyApi IP updated (via discovery listener)
    ↓
App propagates to all devices with matching serial:
    ├─ Gateway devices → setSettings({ envoy_ip: newIp })
    ├─ Envoy legacy devices → setSettings({ envoy_ip: newIp })
    ├─ Inverters devices → setSettings({ envoy_ip: newIp })
    └─ Homeload devices → setSettings({ envoy_ip: newIp })
```

### 5. Production Control Flow

#### Unmetered Gateways (Legacy)
```
User toggles onoff capability → Gateway device listener
    ↓
Check isMaintainer permission
    ↓
api.setPowerForcedOff(forceOff)
    ↓
PUT /ivp/mod/603980032/mode/power
    ↓
Cloud override detection → Re-apply if Envoy resets
```

#### Metered Gateways with DPEL (ADR 0003)
```
User toggles onoff capability → Gateway device listener
    ↓
Check isMaintainer + isMetered + productionLimiting
    ↓
Remap to DPEL commands:
    ├─ ON → setDpelSettings({ enable: false }) → Normal production
    └─ OFF → setDpelSettings({ enable: true, limit_value_W: 0 }) → No production
    ↓
POST /ivp/ss/dpel with dynamic_pel_settings payload
```

#### Custom Solar Production Mode
```
User sets target_power (Watts) → Homey UI
    ↓
Gateway device listener (target_power_mode must be 'homey')
    ↓
api.setDpelSettings({ enable: true, export_limit: false, limit_value_W: value })
    ↓
POST /ivp/ss/dpel
```

### 6. Inverter Alerts Flow
```
Inverters device receives telemetry → updateTelemetry()
    ↓
validateTelemetry() → Check serial count mismatch
    ↓
processInverterReadings() → Energy integration, daily peaks
    ↓
evaluateAlerts():
    ├─ Sunset trigger: Power drops to 0 → evaluateUnderperformance()
    │   └─ Compare daily peaks to median → Raise alerts if under threshold
    │
    └─ Stale detection: lastReportDate > stale_timeout
        └─ Raise offline alert
    ↓
raiseAlert() → Deduplicate → trigger flow card → update status capability
```

## Key Design Patterns

### 1. Shared API Instance Pattern
- One EnvoyApi per gateway serial (shared across Gateway, Homeload, Inverters devices)
- Prevents multiple auth sessions, reduces token churn
- Centralized token/IP propagation via callbacks

### 2. Centralized Polling Coordinator
- App-level polling manager coordinates all devices per serial
- Prevents concurrent polls (activePolls Set)
- Queues pending polls if busy
- 30-minute grace period before marking unavailable

### 3. Dual-Path Token Acquisition
- API path: Fast, reliable, but may return System Owner role
- Portal path: Slower (scraping), but can upgrade to Maintainer role
- Automatic selection based on privilege tier

### 4. Dynamic Capability Management
- Gateway: Add/remove PEL capabilities based on role + metered status
- Homeload: Add/remove homepower capabilities based on availability
- Inverters: Dynamic capabilities per serial (measure_power.<serial>, inverter_status.<serial>)

### 5. Memory Leak Prevention
- Use this.homey.setInterval/clearInterval (not global timers)
- Cleanup discovery listeners in destroy()
- Clear timers in onUninit()/onDeleted()

### 6. Exception Safety
- Try/catch around all network requests
- 401 retry with fresh session cookie
- JWT persistence on local failures (only clear on cloud credential errors)
- Graceful degradation (fallback to inverters data if EIM missing)

## Architecture Decision Records (ADRs)

### ADR 0001: 401 Retry with Fresh Session Cookie
- Problem: Local Envoy evicts session cookies periodically
- Solution: On 401, force-refresh session cookie and retry once
- Impact: Prevents transient auth failures from causing device unavailability

### ADR 0002: Dual-Path Token Acquisition
- Problem: API tokens often lack Maintainer privileges for production control
- Solution: Try API first, then portal scraping, select highest privilege
- Impact: Enables production control for installer accounts without manual token swap

### ADR 0003: PEL Remapping for Metered Gateways
- Problem: powerForcedOff contactor blocks battery/contactor communications
- Solution: Remap onoff to DPEL on metered gateways (0W limit for OFF, disable for ON)
- Impact: Safe production shutdown without disabling battery systems

### ADR 0004: Shared httpsAgent with Keep-Alive
- Problem: Socket exhaustion from frequent TLS handshakes
- Solution: Shared https.Agent with keepAlive, 4s idle timeout
- Impact: Reduced latency, prevented socket exhaustion

### ADR 0005: Centralized Pairing Helper
- Problem: Duplicate pairing logic across drivers
- Solution: PairingHelper.setupPairingSession() with driver-specific overrides
- Impact: Consistent UX, reduced code duplication, easier maintenance
