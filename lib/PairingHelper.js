'use strict';

const dgram = require('dgram');
const net = require('net');
const EnvoyApi = require('./EnvoyApi');

// Shared pairing logic for all drivers: saved-credential cache, gateway discovery (mDNS) and pairing session setup.

/**
 * Direct mDNS scanning fallback via raw UDP sockets to bypass Homey's built-in discovery limitations.
 * Performs dual-stack IPv4 and IPv6 queries in parallel to support diverse network setups.
 * Fallback only: Homey's discovery strategy stays primary, but it can be slow or miss the gateway on VLAN,
 * mesh and dual-stack networks.
 */
function scanMdnsDirect(log, error, homey) {
  return new Promise((resolve) => {
    log('Starting direct dual-stack mDNS scan fallback...');

    let clientV4;
    let clientV6;
    let resolved = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        if (homey) {
          homey.clearTimeout(timer);
        } else {
          clearTimeout(timer);
        }
        timer = null;
      }
      if (clientV4) {
        try {
          clientV4.close();
        } catch (e) {}
      }
      if (clientV6) {
        try {
          clientV6.close();
        } catch (e) {}
      }
    };

    const handleMessage = (msg, rinfo, family) => {
      try {
        const cleanStr = msg.toString('ascii').replace(/[^a-zA-Z0-9\-_=. \s]/g, '.');
        log(`Direct mDNS scan [${family}] received response from [${rinfo.address}]:${rinfo.port}`);

        const serialMatch = cleanStr.match(/\b\d{12}\b/);
        if (serialMatch) {
          const serial = serialMatch[0];
          const ip = rinfo.address;
          log(`Direct mDNS scan [${family}] resolved: IP="${ip}", Serial="${serial}"`);
          resolved = true;
          cleanup();
          resolve({ ip, serial });
        }
      } catch (err) {
        error(`Error parsing direct mDNS [${family}] response:`, err.message);
      }
    };

    // Construct standard PTR query for _enphase-envoy._tcp.local
    const serviceName = '_enphase-envoy._tcp.local';
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // Questions count = 1

    const labels = serviceName.split('.');
    const parts = [];
    for (const label of labels) {
      const buf = Buffer.alloc(1 + label.length);
      buf.writeUInt8(label.length, 0);
      buf.write(label, 1);
      parts.push(buf);
    }
    const qname = Buffer.concat([...parts, Buffer.from([0])]);
    const qtypeClass = Buffer.alloc(4);
    qtypeClass.writeUInt16BE(12, 0); // QTYPE = PTR (12)
    qtypeClass.writeUInt16BE(1, 2); // QCLASS = IN (1)

    const query = Buffer.concat([header, qname, qtypeClass]);

    // Setup IPv4 client (Multicast IP: 224.0.0.251)
    try {
      clientV4 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      clientV4.on('message', (msg, rinfo) => handleMessage(msg, rinfo, 'IPv4'));
      clientV4.on('error', (err) => {
        error('Direct mDNS IPv4 socket error:', err.message);
      });
      clientV4.bind(0, () => {
        try {
          clientV4.send(query, 0, query.length, 5353, '224.0.0.251');
        } catch (err) {
          error('Failed to send direct IPv4 mDNS query:', err.message);
        }
      });
    } catch (err) {
      error('Failed to create udp4 socket:', err.message);
    }

    // Setup IPv6 client (Multicast IP: ff02::fb)
    try {
      clientV6 = dgram.createSocket({ type: 'udp6', reuseAddr: true });
      clientV6.on('message', (msg, rinfo) => handleMessage(msg, rinfo, 'IPv6'));
      clientV6.on('error', (err) => {
        error('Direct mDNS IPv6 socket error:', err.message);
      });
      clientV6.bind(0, () => {
        try {
          clientV6.send(query, 0, query.length, 5353, 'ff02::fb');
        } catch (err) {
          error('Failed to send direct IPv6 mDNS query:', err.message);
        }
      });
    } catch (err) {
      error('Failed to create udp6 socket:', err.message);
    }

    const timerCallback = () => {
      if (!resolved) {
        log('Direct mDNS scan timeout.');
        cleanup();
        resolve(null);
      }
    };

    if (homey) {
      timer = homey.setTimeout(timerCallback, 2500);
    } else {
      // eslint-disable-next-line homey-app/global-timers
      timer = setTimeout(timerCallback, 2500);
    }
  });
}

const SERIAL_REGEX = /^\d{12}$/;
const MIGRATION_SNAPSHOT_PREFIX = 'migration_snapshot_';
// The snapshot holds plaintext credentials, so an abandoned migration must not keep them indefinitely.
const MIGRATION_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Driver ids that count as a legacy solar (production control) device for the new solar driver conflict rule.
const LEGACY_SOLAR_DRIVER_IDS = ['envoy', 'gateway'];
// Legacy cumulative grid/home driver: coexisting with the new grid driver double counts energy (warning only).
const LEGACY_GRID_DRIVER_IDS = ['homeload'];

/**
 * Enumerate every paired device of every app driver (no hard-coded driver list), including devices that are not
 * (yet) registered for polling. Never throws.
 * @param {Object} homey
 * @returns {Array<{driverId: string, device: Object}>}
 */
function listPairedDevices(homey) {
  const result = [];
  let drivers = {};
  try {
    drivers = homey.drivers.getDrivers() || {};
  } catch (err) {
    return result;
  }
  for (const [driverId, driver] of Object.entries(drivers)) {
    try {
      for (const device of driver.getDevices()) {
        result.push({ driverId, device });
      }
    } catch (err) {
      // Driver not ready or without devices: skip.
    }
  }
  return result;
}

/**
 * Read the reusable gateway settings of one paired device. Device settings can be empty for credentials (pairing
 * only stores serial/IP on the device), so the global credential cache fills the gaps.
 * @returns {Object} { serial, ip, email, password, token, isMaintainer, sourceDriverId }
 */
function readDeviceGatewayInfo(homey, { driverId, device }) {
  const settings = device.getSettings() || {};
  const store = (key) => {
    try {
      return device.getStoreValue(key);
    } catch (err) {
      return undefined;
    }
  };

  let email = settings.user_email || '';
  let password = settings.password || '';
  const cachedEmail = homey.settings.get('user_email') || '';
  const cachedPassword = homey.settings.get('password') || '';
  if (!email && !password) {
    email = cachedEmail;
    password = cachedPassword;
  } else if (email && !password && cachedEmail.toLowerCase() === email.toLowerCase()) {
    password = cachedPassword;
  }

  return {
    serial: settings.envoy_serial || '',
    ip: settings.envoy_ip || '',
    email,
    password,
    token: store('enphase_token') || null,
    isMaintainer: !!store('is_maintainer'),
    sourceDriverId: driverId,
  };
}

/** Pick the most useful paired device for a serial: credentials first, then token, then maintainer role. */
function findBestDeviceInfo(homey, serial) {
  let best = null;
  let bestScore = -1;
  for (const entry of listPairedDevices(homey)) {
    let info;
    try {
      info = readDeviceGatewayInfo(homey, entry);
    } catch (err) {
      continue;
    }
    if (info.serial !== serial) continue;
    const score = (info.password ? 4 : 0) + (info.token ? 2 : 0) + (info.isMaintainer ? 1 : 0);
    if (score > bestScore) {
      best = info;
      bestScore = score;
    }
  }
  return best;
}

/**
 * True when a stored snapshot is older than the retention period. A snapshot without `savedAt` (should not happen)
 * is aged by its `createdAt`, or stamped with the current time on first read when its age is unknown.
 */
function isMigrationSnapshotExpired(homey, key, snapshot) {
  let { savedAt } = snapshot;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
    savedAt = typeof snapshot.createdAt === 'number' && Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : Date.now();
    try {
      Promise.resolve(homey.settings.set(key, { ...snapshot, savedAt })).catch(() => {});
    } catch (err) {
      // Stamp is best effort.
    }
  }
  return Date.now() - savedAt > MIGRATION_SNAPSHOT_MAX_AGE_MS;
}

function removeMigrationSnapshotKey(homey, key) {
  try {
    Promise.resolve(homey.settings.unset(key)).catch(() => {});
  } catch (err) {
    // Nothing to remove.
  }
}

function readMigrationSnapshot(homey, serial) {
  try {
    const key = `${MIGRATION_SNAPSHOT_PREFIX}${serial}`;
    const snapshot = homey.settings.get(key);
    if (snapshot && typeof snapshot === 'object' && snapshot.serial === serial) {
      if (isMigrationSnapshotExpired(homey, key, snapshot)) {
        removeMigrationSnapshotKey(homey, key);
        return null;
      }
      return snapshot;
    }
  } catch (err) {
    // Unreadable snapshot is treated as absent.
  }
  return null;
}

/**
 * Remove every expired `migration_snapshot_<serial>` app setting (call once at app start). Synchronous, never throws.
 * @param {Object} homey
 * @returns {void}
 */
function pruneMigrationSnapshots(homey) {
  try {
    if (!homey || !homey.settings || typeof homey.settings.getKeys !== 'function') return;
    for (const key of homey.settings.getKeys() || []) {
      if (typeof key !== 'string' || !key.startsWith(MIGRATION_SNAPSHOT_PREFIX)) continue;
      try {
        const snapshot = homey.settings.get(key);
        if (!snapshot || typeof snapshot !== 'object' || isMigrationSnapshotExpired(homey, key, snapshot)) {
          removeMigrationSnapshotKey(homey, key);
        }
      } catch (err) {
        // Skip an unreadable entry.
      }
    }
  } catch (err) {
    // Pruning is best effort.
  }
}

/**
 * Find reusable settings for a gateway serial across all paired app devices (driver-independent), falling back to
 * the migration snapshot saved by prepareGatewayMigration() when no paired device exists on that serial.
 * Backend use only: the result contains the password and token, never send it to a view, log or notification.
 * @param {Object} homey
 * @param {string} serial - 12-digit gateway serial
 * @returns {Promise<{ip: string, email: string, password: string, token: string|null,
 *   isMaintainer: boolean, sourceDriverId: string, source: 'device'|'snapshot'}|null>}
 */
async function findPairedGateway(homey, serial) {
  if (!SERIAL_REGEX.test(serial || '')) return null;

  const device = findBestDeviceInfo(homey, serial);
  if (device) {
    return {
      ip: device.ip,
      email: device.email,
      password: device.password,
      token: device.token,
      isMaintainer: device.isMaintainer,
      sourceDriverId: device.sourceDriverId,
      source: 'device',
    };
  }

  const snapshot = readMigrationSnapshot(homey, serial);
  if (snapshot) {
    return {
      ip: snapshot.ip || '',
      email: snapshot.email || '',
      password: snapshot.password || '',
      token: snapshot.token || null,
      isMaintainer: !!snapshot.isMaintainer,
      sourceDriverId: snapshot.sourceDriverId || '',
      source: 'snapshot',
    };
  }

  return null;
}

/**
 * Save a backend-only settings snapshot of a paired device before the user removes it (removal-first migration).
 * Stored in app settings `migration_snapshot_<serial>`; kept until discardGatewayMigration() (the solar device calls
 * it from onAdded after a successful pairing). Never logged, never in realtime/widget payloads.
 * @returns {Promise<{saved: boolean, reason?: 'invalid_serial'|'no_device'|'no_credentials',
 *   createdAt?: number, sourceDriverId?: string, hasToken?: boolean}>}
 */
async function prepareGatewayMigration(homey, serial) {
  if (!SERIAL_REGEX.test(serial || '')) return { saved: false, reason: 'invalid_serial' };

  const device = findBestDeviceInfo(homey, serial);
  if (!device) return { saved: false, reason: 'no_device' };
  if (!device.email || !device.password) return { saved: false, reason: 'no_credentials' };

  const createdAt = Date.now();
  await homey.settings.set(`${MIGRATION_SNAPSHOT_PREFIX}${serial}`, {
    version: 1,
    serial,
    ip: device.ip,
    email: device.email,
    password: device.password,
    token: device.token,
    isMaintainer: device.isMaintainer,
    sourceDriverId: device.sourceDriverId,
    createdAt,
    savedAt: createdAt,
  });
  return {
    saved: true,
    createdAt,
    sourceDriverId: device.sourceDriverId,
    hasToken: !!device.token,
  };
}

/** Remove the migration snapshot for a serial (explicit discard, or after successful pairing). */
async function discardGatewayMigration(homey, serial) {
  if (!SERIAL_REGEX.test(serial || '')) return;
  try {
    await homey.settings.unset(`${MIGRATION_SNAPSHOT_PREFIX}${serial}`);
  } catch (err) {
    // Nothing to discard.
  }
}

/** Non-secret status of the migration snapshot for a serial. */
function getMigrationStatus(homey, serial) {
  const snapshot = SERIAL_REGEX.test(serial || '') ? readMigrationSnapshot(homey, serial) : null;
  if (!snapshot) return { exists: false };
  return {
    exists: true,
    createdAt: snapshot.createdAt || null,
    sourceDriverId: snapshot.sourceDriverId || '',
    hasToken: !!snapshot.token,
  };
}

/**
 * Same-serial legacy solar (`envoy` / `gateway`) device, if any. Read-only drivers and other serials never
 * conflict. Waits for the legacy driver to finish init so the check is reliable during app start.
 * @param {Object} homey
 * @param {string} serial
 * @param {Object} [options]
 * @param {boolean} [options.throwOnError=false] - Rethrow when a legacy driver cannot be enumerated instead of
 *   reporting "no conflict" (callers that must fail closed, or keep their previous state, set this).
 * @returns {Promise<{driverId: string, device: Object}|null>}
 */
async function findLegacySolarConflict(homey, serial, options = {}) {
  // The helper declaration follows this exported conflict check for readability.
  // eslint-disable-next-line no-use-before-define
  return findDeviceOnSerial(homey, LEGACY_SOLAR_DRIVER_IDS, serial, !!options.throwOnError);
}

async function findDeviceOnSerial(homey, driverIds, serial, throwOnError = false) {
  if (!serial) return null;
  for (const driverId of driverIds) {
    try {
      const driver = homey.drivers.getDriver(driverId);
      if (!driver) continue;
      if (typeof driver.ready === 'function') {
        await driver.ready();
      }
      for (const device of driver.getDevices()) {
        if ((device.getSettings() || {}).envoy_serial === serial) {
          return { driverId, device };
        }
      }
    } catch (err) {
      // Driver not present or not ready: no conflict can be proven (unless the caller must fail closed).
      if (throwOnError) throw err;
    }
  }
  return null;
}

/**
 * Pairing variant of the conflict check that fails closed: when a legacy driver cannot be enumerated the conflict
 * cannot be ruled out, so pairing stops with a localized (generic) error instead of continuing.
 */
async function findLegacySolarConflictOrThrow(homey, serial, errorPrefix, error) {
  try {
    return await findLegacySolarConflict(homey, serial, { throwOnError: true });
  } catch (err) {
    error('Legacy solar conflict check failed, blocking pairing:', err.message);
    throw new Error(homey.__(`${errorPrefix}.error.auth_failed`, { message: err.message }));
  }
}

/** Distinct paired gateways as non-secret { serial, ip } pairs (for the multi-gateway chooser). */
function listPairedGateways(homey) {
  const seen = new Map();
  for (const entry of listPairedDevices(homey)) {
    try {
      const settings = entry.device.getSettings() || {};
      if (SERIAL_REGEX.test(settings.envoy_serial || '') && !seen.has(settings.envoy_serial)) {
        seen.set(settings.envoy_serial, { serial: settings.envoy_serial, ip: settings.envoy_ip || '' });
      }
    } catch (err) {
      // Skip unreadable device.
    }
  }
  return [...seen.values()];
}

/**
 * Backend-side credential resolution for "reuse saved account" logins: the view never receives the password.
 * Only returns credentials when the typed email (if any) matches the saved account.
 */
async function resolveSavedCredentials(homey, serial, typedEmail) {
  const saved = await findPairedGateway(homey, serial);
  if (saved && saved.email && saved.password) {
    if (typedEmail && typedEmail.toLowerCase() !== saved.email.toLowerCase()) return null;
    return saved;
  }

  // No paired device or snapshot on this serial: the global account cache (offered as source 'cache' by the
  // findPairedGateway session handler) is the remaining source. No token or IP comes with it.
  const cachedEmail = homey.settings.get('user_email') || '';
  const cachedPassword = homey.settings.get('password') || '';
  if (!cachedEmail || !cachedPassword) return null;
  if (typedEmail && typedEmail.toLowerCase() !== cachedEmail.toLowerCase()) return null;
  return {
    ip: '',
    email: cachedEmail,
    password: cachedPassword,
    token: null,
    isMaintainer: false,
    sourceDriverId: '',
    source: 'cache',
  };
}

/**
 * Register the `getSerial` session handler (used by pairing and by repair views).
 * View -> backend: `Homey.emit('getSerial', { ip })`.
 * Returns `{ serial: string|null, reason: null|'unreadable'|'unsupported'|'invalid_ip' }`; `serial` is exactly 12 digits
 * or null. Reads the unauthenticated gateway info through EnvoyApi.getGatewaySerial(ip); never throws to the view.
 */
function registerGetSerialHandler(context, session) {
  const { log, error } = context;
  session.setHandler('getSerial', async (data) => {
    const ip = data && typeof data.ip === 'string' ? data.ip.trim() : '';
    // IP literals only: runtime connections never use hostnames.
    if (!ip || net.isIP(ip) === 0) {
      return { serial: null, reason: 'invalid_ip' };
    }
    try {
      const result = await EnvoyApi.getGatewaySerial(ip);
      if (result && SERIAL_REGEX.test(result.serial || '')) {
        log(`Serial read from gateway at ${ip}: ${result.serial}`);
        return { serial: result.serial, reason: null };
      }
      return { serial: null, reason: (result && result.reason) || 'unreadable' };
    } catch (err) {
      error('Reading gateway serial failed:', err.message);
      return { serial: null, reason: 'unreadable' };
    }
  });
}

/**
 * Production-control capability probe (DPEL test write with immediate restore). Only runs for drivers that opt in
 * with `allowProductionLimitProbe`; read-only drivers never write production settings.
 * @returns {Promise<boolean>} True if dynamic production limiting is supported
 */
async function probeProductionLimiting(api, log, error) {
  log('Testing dynamic production limiting (DPEL) support during pairing verification...');
  try {
    const originalSettings = await api.getDpelSettings();
    log('Envoy active settings fetched. Sending test write request...');
    await api.setDpelSettings({
      enable: true,
      export_limit: true,
      limit_value_W: 10000,
    });
    log('Dynamic production limiting (DPEL) test write succeeded.');

    // Restore original settings immediately
    const originalEnable = !!(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.enable);
    const originalExportLimit = !(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.export_limit === false);
    const originalLimit = originalSettings && originalSettings.dynamic_pel_settings && typeof originalSettings.dynamic_pel_settings.limit_value_W === 'number'
      ? originalSettings.dynamic_pel_settings.limit_value_W
      : 0;

    log(`Restoring original settings: enable=${originalEnable}, exportLimit=${originalExportLimit}, limit=${originalLimit}W...`);
    await api.setDpelSettings({
      enable: originalEnable,
      export_limit: originalExportLimit,
      limit_value_W: originalLimit,
    });
    log('Original settings restored.');
    return true;
  } catch (err) {
    error('DPEL test write failed. Dynamic production limiting is not supported on this gateway:', err.message);

    // Attempt to restore original settings if the error occurred after a successful write
    try {
      const originalSettings = await api.getDpelSettings();
      if (originalSettings && originalSettings.dynamic_pel_settings) {
        const originalEnable = !!originalSettings.dynamic_pel_settings.enable;
        const originalExportLimit = originalSettings.dynamic_pel_settings.export_limit !== false;
        const originalLimit = originalSettings.dynamic_pel_settings.limit_value_W || 0;
        await api.setDpelSettings({
          enable: originalEnable,
          export_limit: originalExportLimit,
          limit_value_W: originalLimit,
        });
      }
    } catch (restoreErr) {
      // ignore
    }
    return false;
  }
}

/**
 * Configure standard pairing session handlers for Envoy/Gateway/Inverter/Solar/Grid/Battery drivers.
 * @param {Object} context - Object containing homey, log, error, discovery strategy, and device-specific options
 * @param {Homey.PairSession} session - The pairing session
 * @param {Object} options - Custom overrides
 * @param {string} [options.deviceNameKey='driver.gateway.name'] - Locale key of the default device name
 * @param {string} [options.deviceIdSuffix=''] - Suffix for the device data id (`<serial>_<suffix>`)
 * @param {string} [options.errorPrefix='driver.gateway'] - Locale prefix for `<prefix>.error.*` messages
 * @param {boolean} [options.allowProductionLimitProbe=false] - Run the production-control probe (DPEL test write
 *   with restore) during login. Only solar-control pairing (and the legacy envoy/gateway drivers) enable it.
 * @param {boolean} [options.blockLegacySolar=false] - Reject same-serial legacy `envoy`/`gateway` devices before any
 *   probe and again before device creation. Only the `solar` driver enables it.
 * @param {boolean} [options.probeBattery=false] - Run the read-only `api.probeGateway()` and return `battery` in the
 *   login result. Only the `battery` driver enables it.
 * @param {string} [options.reuseKey=''] - Driver id, used for logging only.
 *
 * View <-> backend protocol (all handlers registered here; views call `Homey.emit(name, payload, cb)`).
 * None of the replies contain a password or token.
 *
 * - `get_discovered_ip` {} -> { ip, serial, candidates: [{ serial, ip }] }
 *     Discovery (Homey mDNS, direct UDP mDNS scan, then any paired device on any driver). `candidates` lists the
 *     distinct paired gateways (non-secret) for a chooser when more than one gateway is paired.
 *     Backend -> view event `discovery_update` { ip, serial } fires for live discovery results.
 * - `getSerial` { ip } -> { serial: '12 digits'|null, reason: null|'unreadable'|'unsupported'|'invalid_ip' }
 *     Reads the serial from the gateway at that IP (EnvoyApi.getGatewaySerial). Manual input stays the fallback.
 * - `findPairedGateway` { serial } ->
 *     { found: boolean, source: 'device'|'snapshot'|'cache'|null, ip, email, hasPassword, hasToken, isMaintainer,
 *       sourceDriverId, blocked: null|'legacy_solar', legacyDriverId, snapshotExists, legacyGrid }
 *     `found` is true for a paired device or migration snapshot on that serial; `source: 'cache'` (found false) means
 *     only the global account cache exists (email + hasPassword). `blocked` is set only when `blockLegacySolar`.
 *     `legacyGrid` is true when a legacy `homeload` device exists on that serial (grid views show a double-counting
 *     warning; never blocks).
 * - `migration` { action: 'prepare'|'discard'|'status', serial } ->
 *     prepare: { saved: boolean, reason?: 'invalid_serial'|'no_device'|'no_credentials', createdAt, hasToken }
 *     discard: { discarded: true }    status: { exists: boolean, createdAt, hasToken }
 * - `get_cached_credentials` {} -> { user_email, password }   (legacy handler, kept for the inverters view only)
 * - `login` { user_email, password, envoy_serial, envoy_ip, reuse_saved? } ->
 *     { success: true, isMaintainer, isMetered, hasGridpower, hasHomepower, productionLimiting, battery? }
 *   or { success: false, blocked: 'legacy_solar', legacyDriverId, message } (blockLegacySolar, before any probe).
 *     `reuse_saved: true` with an empty password makes the backend take password (and token) from
 *     findPairedGateway for that serial if the typed email matches the saved one; otherwise the usual
 *     "fields required" error. `battery` ({ hasBattery: true|false|null, warning: 'none'|'unknown'|null }) is present
 *     only with `probeBattery`: 'none' = no battery detected, 'unknown' = detection failed (never blocks pairing).
 *     Errors are thrown with a localized message (`<errorPrefix>.error.*`).
 * - `list_devices` -> [device] (re-checks the legacy solar conflict before device creation when `blockLegacySolar`).
 */
function setupPairingSession(context, session, options = {}) {
  const { homey, log, error } = context;
  const {
    deviceNameKey = 'driver.gateway.name',
    deviceIdSuffix = '',
    errorPrefix = 'driver.gateway',
    allowProductionLimitProbe = false,
    blockLegacySolar = false,
    probeBattery = false,
    reuseKey = '',
  } = options;

  log(`Pairing session started (shared helper${reuseKey ? `, ${reuseKey}` : ''})...`);
  let pairedDeviceData = null;

  // Register active mDNS discovery listener for real-time frontend auto-detection updates
  const discoveryStrategy = context.getDiscoveryStrategy();
  let discoveryResultListener = null;

  if (discoveryStrategy) {
    log('Pair session: registering result listener to feed pairing screen...');

    discoveryResultListener = (result) => {
      if (!result) return;
      log('Pair session: received live discovery advertisement:', JSON.stringify(result));

      const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
      log(`Pair session: parsed live advertisement: IP="${ip}", Serial="${serial}"`);

      if (ip || serial) {
        log(`Pair session discovery update: IP="${ip}", Serial="${serial}"`);
        session.emit('discovery_update', {
          ip,
          serial,
        }).catch((err) => {
          error('Failed to emit discovery update to pairing screen:', err.message);
        });
      }
    };

    discoveryStrategy.on('result', discoveryResultListener);

    // Also trigger direct IPv6 multicast query to speed up detection if Homey's client is laggy
    scanMdnsDirect(log, error, homey).then((directResult) => {
      if (directResult && directResult.ip && directResult.serial) {
        log(`Direct scan auto-fill: IP="${directResult.ip}", Serial="${directResult.serial}"`);
        session.emit('discovery_update', {
          ip: directResult.ip,
          serial: directResult.serial,
        }).catch((err) => {
          error('Failed to emit direct discovery update:', err.message);
        });
      }
    }).catch((err) => {
      error('Direct scan failed:', err.message);
    });
  }

  // Clean up dynamic discovery listener when pairing session closes
  session.setHandler('disconnect', async () => {
    log('Pairing session disconnected.');
    if (discoveryStrategy && discoveryResultListener) {
      discoveryStrategy.removeListener('result', discoveryResultListener);
      log('Removed dynamic pairing discovery result listener.');
    }
  });

  // Handler to send the auto-discovered parameters to the HTML view
  session.setHandler('get_discovered_ip', async () => {
    log('Performing auto-detection for Envoy IP using discovery strategy...');

    let discoveredIp = '';
    let discoveredSerial = '';
    let discoveryResults = {};

    try {
      if (discoveryStrategy) {
        discoveryResults = discoveryStrategy.getDiscoveryResults();
        log('Raw getDiscoveryResults:', JSON.stringify(discoveryResults));
      } else {
        log('Discovery strategy is not available (returned null).');
      }
    } catch (err) {
      error('Failed to retrieve discovery strategy or results:', err.message);
    }

    for (const result of Object.values(discoveryResults)) {
      if (result) {
        log('Discovered mDNS entry:', JSON.stringify(result));
        const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
        if (ip || serial) {
          discoveredIp = ip;
          discoveredSerial = serial;
          log(`Auto-detection resolved: IP="${discoveredIp}", Serial="${discoveredSerial}"`);
          break;
        }
      }
    }

    // Fallback: If not found via built-in discovery, run direct mDNS scan
    if (!discoveredIp && !discoveredSerial) {
      const directResult = await scanMdnsDirect(log, error, homey);
      if (directResult) {
        discoveredIp = directResult.ip;
        discoveredSerial = directResult.serial;
      }
    }

    // Fallback 2: reuse IP/serial from any already paired device (all drivers, no hard-coded list)
    const candidates = listPairedGateways(homey);
    if (!discoveredIp && !discoveredSerial) {
      const known = candidates.find((candidate) => candidate.ip);
      if (known) {
        discoveredIp = known.ip;
        discoveredSerial = known.serial;
        log(`Reusing settings from a paired device: IP="${discoveredIp}", Serial="${discoveredSerial}"`);
      }
    }

    return {
      ip: discoveredIp || '',
      serial: discoveredSerial || '',
      candidates,
    };
  });

  // Handler to retrieve cached credentials from global settings (legacy; new views use findPairedGateway instead)
  session.setHandler('get_cached_credentials', async () => {
    const email = homey.settings.get('user_email') || '';
    const password = homey.settings.get('password') || '';
    return {
      user_email: email,
      password,
    };
  });

  // Serial read from the gateway itself (validated as 12 digits) so users cannot enter a Site ID
  registerGetSerialHandler(context, session);

  // Non-secret reuse information for a serial. Secrets stay in the backend (see resolveSavedCredentials).
  session.setHandler('findPairedGateway', async (data) => {
    const serial = data && typeof data.serial === 'string' ? data.serial.trim() : '';
    const reply = {
      found: false,
      source: null,
      ip: '',
      email: '',
      hasPassword: false,
      hasToken: false,
      isMaintainer: false,
      sourceDriverId: '',
      blocked: null,
      legacyDriverId: '',
      snapshotExists: false,
      legacyGrid: false,
    };
    if (!SERIAL_REGEX.test(serial)) return reply;

    try {
      if (blockLegacySolar) {
        const conflict = await findLegacySolarConflict(homey, serial);
        if (conflict) {
          reply.blocked = 'legacy_solar';
          reply.legacyDriverId = conflict.driverId;
        }
      }

      reply.snapshotExists = getMigrationStatus(homey, serial).exists;
      reply.legacyGrid = !!(await findDeviceOnSerial(homey, LEGACY_GRID_DRIVER_IDS, serial));

      const saved = await findPairedGateway(homey, serial);
      if (saved) {
        reply.found = true;
        reply.source = saved.source;
        reply.ip = saved.ip;
        reply.email = saved.email;
        reply.hasPassword = !!saved.password;
        reply.hasToken = !!saved.token;
        reply.isMaintainer = saved.isMaintainer;
        reply.sourceDriverId = saved.sourceDriverId;
      } else {
        // Only the global account cache is left: offer the email, keep the password in the backend.
        const cachedEmail = homey.settings.get('user_email') || '';
        const cachedPassword = homey.settings.get('password') || '';
        if (cachedEmail && cachedPassword) {
          reply.source = 'cache';
          reply.email = cachedEmail;
          reply.hasPassword = true;
        }
      }
    } catch (err) {
      error('Looking up a reusable gateway failed:', err.message);
    }
    return reply;
  });

  // Removal-first migration helpers (snapshot of the old device settings, never sent to the view)
  session.setHandler('migration', async (data) => {
    const action = data && data.action;
    const serial = data && typeof data.serial === 'string' ? data.serial.trim() : '';
    try {
      if (action === 'prepare') {
        const result = await prepareGatewayMigration(homey, serial);
        log(`Migration snapshot prepare for ${serial}: ${result.saved ? 'saved' : result.reason}`);
        return result;
      }
      if (action === 'discard') {
        await discardGatewayMigration(homey, serial);
        log(`Migration snapshot for ${serial} discarded.`);
        return { discarded: true };
      }
      if (action === 'status') {
        return getMigrationStatus(homey, serial);
      }
    } catch (err) {
      error('Migration action failed:', err.message);
      return { saved: false, reason: 'error', exists: false };
    }
    return { saved: false, reason: 'unknown_action', exists: false };
  });

  // Handler to authenticate and verify roles
  session.setHandler('login', async (data) => {
    const {
      password: typedPassword,
      envoy_serial: envoySerial,
      envoy_ip: envoyIp,
      reuse_saved: reuseSaved,
    } = data;
    let userEmail = data.user_email;
    let password = typedPassword;
    let reuseToken = null;

    // "Reuse saved account": the view never holds the password, the backend resolves it for this serial.
    if (reuseSaved && !password && SERIAL_REGEX.test(envoySerial || '')) {
      const saved = await resolveSavedCredentials(homey, envoySerial, userEmail);
      if (saved) {
        userEmail = saved.email;
        password = saved.password;
        reuseToken = saved.token;
        log(`Reusing saved account from ${saved.source} (${saved.sourceDriverId || 'unknown driver'}) for ${envoySerial}.`);
      }
    }

    if (!userEmail || !password || !envoySerial || !envoyIp) {
      throw new Error(homey.__(`${errorPrefix}.error.fields_required`));
    }

    if (!SERIAL_REGEX.test(envoySerial)) {
      throw new Error(homey.__(`${errorPrefix}.error.invalid_serial`));
    }

    // Conflict rule first: no probe (and no login) may run against a gateway that still has a legacy solar device.
    if (blockLegacySolar) {
      const conflict = await findLegacySolarConflictOrThrow(homey, envoySerial, errorPrefix, error);
      if (conflict) {
        log(`Pairing blocked: legacy ${conflict.driverId} device exists on ${envoySerial}.`);
        return {
          success: false,
          blocked: 'legacy_solar',
          legacyDriverId: conflict.driverId,
          message: homey.__('pair.error.legacy_solar_conflict'),
        };
      }
    }

    log(`Attempting login for email: ${userEmail}, Serial: ${envoySerial}, IP: ${envoyIp}`);

    // Create a temporary API client to test credentials with the provided IP
    const api = new EnvoyApi({
      log: (msg, ...args) => log(`[API Temp] ${msg}`, ...args),
      userEmail,
      password,
      envoySerial,
      envoyIp,
    });

    try {
      let token = null;

      // Reused token first: avoids a cloud login. Any failure falls back to a fresh cloud login below.
      if (reuseToken) {
        try {
          await api.getSessionCookie(reuseToken, true);
          api.token = reuseToken;
          token = reuseToken;
          log('Reused existing token during pairing.');
        } catch (err) {
          log('Reused token was not accepted, falling back to a fresh login:', err.message);
        }
      }

      if (!token) {
        // Fetch a new token to verify credentials and get the JWT
        token = await api.fetchNewToken();
        log('Token fetched successfully during pairing.');

        // Verify local connection and authenticate with Envoy using JWT.
        // Done at pairing so an unreachable gateway fails here instead of silently failing in background polling.
        log('Testing local connection and authentication with Envoy gateway...');
        await api.getSessionCookie(token, true);
      }
      log('Local connection and Envoy authentication verified successfully.');

      // Fetch inverters serial numbers during pairing
      log('Fetching microinverters list during pairing verification...');
      let inverterSerials = [];
      try {
        const invertersData = await api.getInvertersData();
        inverterSerials = invertersData.map((inv) => inv.serialNumber);
        log(`Successfully discovered ${inverterSerials.length} inverters during pairing.`);
      } catch (err) {
        error('Failed to retrieve microinverters during pairing verification:', err.message);
      }

      // Check meter status during pairing
      let isMetered = false;
      let hasGridpower = false;
      let hasHomepower = false;
      try {
        const meterStatus = await api.checkMeterStatus();
        isMetered = meterStatus.isMetered;
        hasGridpower = meterStatus.hasGridpower;
        hasHomepower = meterStatus.hasHomepower;
      } catch (err) {
        error('Failed to check meter status during pairing verification:', err.message);
      }

      // Decode the JWT to verify roles using the Envoy API helper method
      const tokenRoleResult = api.evaluateTokenRole(token);
      const { isMaintainer } = tokenRoleResult;
      log(`Token evaluation completed. Is Maintainer: ${isMaintainer}`);

      // Production-control probe: writes to the gateway, so only drivers that control production opt in.
      let productionLimiting = false;
      if (allowProductionLimitProbe && isMetered && isMaintainer) {
        productionLimiting = await probeProductionLimiting(api, log, error);
      }

      // Read-only battery detection. A failed detection is 'unknown' and never blocks pairing.
      let battery = null;
      if (probeBattery) {
        battery = { hasBattery: null, warning: 'unknown' };
        try {
          const probe = await api.probeGateway();
          const hasBattery = probe && probe.has ? probe.has.battery : null;
          if (hasBattery === true) {
            battery = { hasBattery: true, warning: null };
          } else if (hasBattery === false) {
            battery = { hasBattery: false, warning: 'none' };
          }
        } catch (err) {
          error('Battery detection failed during pairing verification:', err.message);
        }
      }

      // Keep device data in memory for the list_devices step
      pairedDeviceData = {
        name: homey.__(deviceNameKey),
        data: {
          id: deviceIdSuffix ? `${envoySerial}_${deviceIdSuffix}` : envoySerial,
        },
        settings: {
          user_email: userEmail,
          password,
          envoy_serial: envoySerial,
          envoy_ip: envoyIp,
        },
        store: {
          enphase_token: token,
          is_maintainer: isMaintainer,
          inverters: inverterSerials,
          is_metered: isMetered,
          has_gridpower: hasGridpower,
          has_homepower: hasHomepower,
          production_limiting: productionLimiting,
        },
      };

      // Return role status and meter information back to frontend
      const loginResult = {
        success: true,
        isMaintainer,
        isMetered,
        hasGridpower,
        hasHomepower,
        productionLimiting,
      };
      if (battery) loginResult.battery = battery;
      return loginResult;

    } catch (err) {
      error('Authentication test failed during pairing:', err.message);
      throw new Error(homey.__(`${errorPrefix}.error.auth_failed`, { message: err.message }));
    }
  });

  // Handler to return list of devices to pair
  session.setHandler('list_devices', async () => {
    if (!pairedDeviceData) {
      throw new Error('No device was successfully authenticated yet.');
    }

    // Second conflict check right before device creation (a legacy device could have appeared during the session).
    if (blockLegacySolar) {
      const conflict = await findLegacySolarConflictOrThrow(homey, pairedDeviceData.settings.envoy_serial, errorPrefix, error);
      if (conflict) {
        throw new Error(homey.__('pair.error.legacy_solar_conflict'));
      }
    }

    // Global credential cache: prefills the next pairing so users do not retype email/password per driver.
    log('Saving authentication credentials globally to App settings...');
    await homey.settings.set('user_email', pairedDeviceData.settings.user_email);
    await homey.settings.set('password', pairedDeviceData.settings.password);

    log('Adding devices to Homey...');

    const deviceObj = {
      name: pairedDeviceData.name,
      data: pairedDeviceData.data,
      settings: {
        envoy_serial: pairedDeviceData.settings.envoy_serial,
        envoy_ip: pairedDeviceData.settings.envoy_ip,
      },
      store: pairedDeviceData.store,
    };

    return [deviceObj];
  });
}

module.exports = {
  setupPairingSession,
  scanMdnsDirect,
  registerGetSerialHandler,
  findPairedGateway,
  prepareGatewayMigration,
  discardGatewayMigration,
  getMigrationStatus,
  pruneMigrationSnapshots,
  findLegacySolarConflict,
};
