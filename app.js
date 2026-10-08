'use strict';

const Homey = require('homey');
const EnvoyApi = require('./lib/EnvoyApi');
const PairingHelper = require('./lib/PairingHelper');
const { GatewayEnergyModel, monoMs } = require('./lib/energyModel');

// Central polling loop and device registration manager.
// Current drivers: solar, grid, battery, inverters. The envoy, gateway and homeload drivers are deprecated but stay
// operational during the 2.0 migration window.
//
// Polling model (one scheduler per gateway serial; devices never talk to the gateway themselves: they register
// with the app and consume EnvoyApi through it):
//
//  * Slow tier, every 120 s on its own timer (independent of the fast interval): the legacy cycle. /production.json is heavy (1.6-9.3 s to compile on the gateway,
//    observed), so it is polled sparingly. Legacy devices get exactly the same data shapes as in 1.5.x:
//    updateTelemetry(prodData, powerForcedOff, pelSettings) or updateTelemetry(invertersData).
//  * Fast tier (only while a registered device declares `fast`): light endpoints only, /ivp/meters/readings and
//    /ivp/ensemble/power, in parallel. Default 15 s, floor 5 s, ceiling 120 s, set per device with the
//    `poll_interval` setting (fastest request wins). 15 s / 5 s are provisional: short intervals
//    burden the gateway, and endpoint freshness and cost vary by firmware (the Enphase brief says several
//    aggregates only refresh every 5 minutes; nklerk treats meter readings as live at 2 s). Staleness is judged
//    from the reading timestamps and the measured cadence (see lib/energyModel.js), not from arrival time.
//  * Background (never awaited by a tick): /ivp/ensemble/inventory (battery presence, grid-tie state, SoC
//    fallback) every 60 s with a battery, 10 min without, retried with backoff (30 s .. 5 min) when unknown;
//    /ivp/meters configuration every 10 min.
//  * Coalescing: each tier has a busy flag, so a slow response never builds a backlog of ticks; a tick that finds
//    its tier busy is skipped. At most 2 requests per gateway are in flight (FIFO, see EnvoyApi), shared by fast,
//    slow and background work and control writes, so the slow tier keeps progressing while fast reads are due.
//  * Firmware assumptions: ensemble endpoints exist only with Ensemble storage (404 = definitive "none");
//    battery power key/unit/sign quirks are handled in lib/energyModel.js.
const SLOW_INTERVAL_MS = 120000;
const FAST_DEFAULT_SECONDS = 15;
const FAST_MIN_SECONDS = 5;
const FAST_MAX_SECONDS = 120;
const INVENTORY_REFRESH_MS = 60000;
const INVENTORY_REDETECT_MS = 10 * 60 * 1000;
const INVENTORY_RETRY_MIN_MS = 30000;
const INVENTORY_RETRY_MAX_MS = 5 * 60 * 1000;
const METERS_CONFIG_REFRESH_MS = 10 * 60 * 1000;
const METERS_CONFIG_RETRY_MS = 30000;
// Grace period: a device only becomes unavailable after 30 minutes of continuous polling errors, because transient
// gateway/network errors must not flip devices unavailable (and fire Flows)
const UNAVAILABLE_GRACE_MS = 30 * 60 * 1000;
const KNOWN_SOURCES = ['meters', 'production', 'batteryPower', 'inventory'];
const EVENT_FLOW = 'enphase:flow';
const EVENT_GATEWAYS = 'enphase:gateways';

const settle = (promise) => promise.then(
  (value) => ({
    ok: true, value, at: Date.now(), mono: monoMs(),
  }),
  (error) => ({
    ok: false, error, at: Date.now(), mono: monoMs(),
  }),
);

class EnphaseController extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.apiInstances = new Map();
    this.gateways = new Map(); // serial -> runtime state of the per-gateway scheduler
    this._noticePromises = new Map();
    this._gatewaysJson = null;
    this._timezone = 'UTC';
    this.log('Enphase Controller has been initialized');

    // Drop stale gateway-migration snapshots (credentials saved for a removal-first migration that never completed)
    try {
      if (typeof PairingHelper.pruneMigrationSnapshots === 'function') PairingHelper.pruneMigrationSnapshots(this.homey);
    } catch (err) {
      this.error('Failed to prune migration snapshots:', err.message);
    }
  }

  /**
   * onUninit is called when the app stops: stop all timers and flush battery counters.
   */
  async onUninit() {
    for (const rt of this.gateways.values()) {
      this._stopTimer(rt);
      try {
        rt.model.persist(Date.now(), true);
      } catch (err) {
        this.error(`[Manager] Failed to persist battery energy for serial ${rt.serial}:`, err.message);
      }
    }
    this.gateways.clear();
    for (const api of this.apiInstances.values()) {
      try {
        api.destroy();
      } catch (err) {
        // ignore
      }
    }
    this.apiInstances.clear();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Timeline notices
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Post a timeline notice once, guarded by an app setting. Concurrent callers share one in-flight promise.
   * @private
   */
  async _postNoticeOnce({ settingKey, messageKey, label }) {
    if (this.homey.settings.get(settingKey)) {
      return;
    }

    if (this._noticePromises.has(settingKey)) {
      await this._noticePromises.get(settingKey);
      return;
    }

    const promise = (async () => {
      if (!this.homey.notifications || typeof this.homey.notifications.createNotification !== 'function') {
        this.error(`Timeline notification manager is unavailable; ${label} notice was not sent.`);
        return;
      }

      const excerpt = this.homey.__(messageKey);
      await this.homey.notifications.createNotification({ excerpt });
      await this.homey.settings.set(settingKey, true);
      this.log(`Posted ${label} notice to the user timeline.`);
    })();
    this._noticePromises.set(settingKey, promise);

    try {
      await promise;
    } finally {
      this._noticePromises.delete(settingKey);
    }
  }

  /**
   * Notify users who still have a legacy Envoy device paired (1.5.4 notice, kept for compatibility).
   * The caller is the legacy device itself, so users without one are never notified.
   * @returns {Promise<void>}
   */
  async notifyDeprecatedEnvoyDriver() {
    return this._postNoticeOnce({
      settingKey: 'deprecated_envoy_notice_sent',
      messageKey: 'timeline.deprecated_envoy',
      label: 'deprecated Envoy driver',
    });
  }

  /**
   * Post the versioned 2.0 migration notice for a deprecated driver, once per driver id.
   * Locale key `timeline.migration_2_0_<driverId>`, guarded by app setting `migration_2_0_<driverId>_notice_sent`.
   * The caller is a device of that driver, so users without one are never notified. Message text lives in the locales.
   * @param {string} driverId - Deprecated driver id (e.g. 'envoy', 'gateway', 'homeload')
   * @returns {Promise<void>}
   */
  async notifyDeprecatedDriver(driverId) {
    if (typeof driverId !== 'string' || !/^[a-z0-9_-]+$/i.test(driverId)) {
      this.error('notifyDeprecatedDriver called with an invalid driver id.');
      return;
    }
    await this._postNoticeOnce({
      settingKey: `migration_2_0_${driverId}_notice_sent`,
      messageKey: `timeline.migration_2_0_${driverId}`,
      label: `2.0 migration (${driverId})`,
    });
  }

  /**
   * Resolve the Homey Pro timezone. Refreshes each call to handle DST transitions.
   * @returns {Promise<string>} IANA timezone string (e.g. 'Europe/Amsterdam')
   */
  async getTimezone() {
    try {
      if (this.homey && this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
        this._timezone = await this.homey.clock.getTimezone();
      }
    } catch (err) {
      this.error('Failed to resolve Homey timezone:', err.message);
    }
    return this._timezone;
  }

  /**
   * Format a Unix epoch timestamp (seconds) to HH:mm string in local timezone.
   * @param {number} timestampSeconds - Unix epoch in seconds
   * @returns {Promise<string>} Formatted time string (e.g. '14:30') or '-' if falsy
   */
  async formatTimeLocal(timestampSeconds) {
    if (!timestampSeconds) return '-';
    const timezone = await this.getTimezone();
    try {
      const date = new Date(timestampSeconds * 1000);
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return formatter.format(date);
    } catch (err) {
      this.error('Failed to format timestamp with timezone:', err.message);
      const date = new Date(timestampSeconds * 1000);
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
  }

  /**
   * Get the current local day of the month based on the Homey timezone.
   * @returns {Promise<number>} Day of month (1-31)
   */
  async getLocalDayOfMonth() {
    const timezone = await this.getTimezone();
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        day: 'numeric',
      });
      return Number(formatter.format(new Date()));
    } catch (err) {
      this.error('Failed to calculate local day of month:', err.message);
      return new Date().getDate();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Shared API client and driver-independent propagation
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * All paired devices (every app driver, registered for polling or not) on a gateway serial.
   * Driver-independent: token, IP and role propagation never branch on driver ids.
   * @param {string} serial - Gateway serial
   * @returns {Array<Homey.Device>}
   * @private
   */
  _pairedDevices(serial) {
    const out = [];
    let drivers;
    try {
      drivers = Object.values(this.homey.drivers.getDrivers() || {});
    } catch (err) {
      return out;
    }
    for (const driver of drivers) {
      let devices;
      try {
        devices = driver.getDevices();
      } catch (err) {
        continue;
      }
      for (const dev of devices) {
        try {
          if (dev.getSettings().envoy_serial === serial) out.push(dev);
        } catch (err) {
          // device not ready
        }
      }
    }
    return out;
  }

  /**
   * Get or create a shared EnvoyApi instance for a gateway serial number.
   * One client (one JWT, one cached session cookie) serves every device on a serial: the gateway has few
   * concurrent session/connection slots, and separate clients would log in over each other.
   * @param {Object} opts
   * @param {string} opts.serial - 12-digit Envoy serial number
   * @param {string} opts.ip - Local Envoy IP address
   * @param {string} [opts.userEmail] - Enlighten Email (optional fallback)
   * @param {string} [opts.password] - Enlighten Password (optional fallback)
   * @param {string} [opts.initialToken] - Stored JWT
   * @returns {EnvoyApi}
   */
  getApiInstance({
    serial,
    ip,
    userEmail,
    password,
    initialToken,
  }) {
    if (!this.apiInstances) {
      this.apiInstances = new Map();
    }

    let api = this.apiInstances.get(serial);
    if (!api) {
      this.log(`Creating new shared EnvoyApi client instance for SN ${serial}...`);

      const email = userEmail || this.homey.settings.get('user_email');
      const pass = password || this.homey.settings.get('password');

      api = new EnvoyApi({
        homey: this.homey,
        enableDiscovery: true,
        log: (msg, ...args) => this.log(`[API ${serial}] ${msg}`, ...args),
        userEmail: email,
        password: pass,
        envoySerial: serial,
        envoyIp: ip,
        initialToken: initialToken || null,
        onTokenUpdated: async (newToken) => {
          this.log(`Token updated for gateway serial: ${serial}. Saving to devices...`);

          const isNewTokenMaintainer = api.evaluateTokenRole(newToken).isMaintainer;
          this.log(`New token evaluated. Is Maintainer: ${isNewTokenMaintainer}`);

          // The token goes to every paired device on the serial; the role only to devices that implement
          // updateRole (read-only drivers never acquire production-control behaviour).
          for (const dev of this._pairedDevices(serial)) {
            await dev.setStoreValue('enphase_token', newToken).catch((err) => {
              this.error(`Failed to save token to device ${dev.getName()}:`, err.message);
            });
            if (typeof dev.updateRole === 'function') {
              await Promise.resolve(dev.updateRole(isNewTokenMaintainer)).catch((err) => {
                this.error(`Failed to update role for device ${dev.getName()}:`, err.message);
              });
            }
          }
        },
        onIpUpdated: async (newIp) => {
          this.log(`IP updated for gateway serial: ${serial} to ${newIp}. Propagating to devices...`);

          for (const dev of this._pairedDevices(serial)) {
            try {
              if (dev.getSettings().envoy_ip !== newIp) {
                this.log(`Updating IP setting for device: ${dev.getName()}`);
                await dev.setSettings({ envoy_ip: newIp });
              }
            } catch (err) {
              this.error(`Failed to update IP setting for device ${dev.getName()}:`, err.message);
            }
          }
        },
      });

      this.apiInstances.set(serial, api);
    } else {
      if (ip && api.envoyIp !== ip) {
        this.log(`Updating IP for shared EnvoyApi client SN ${serial} from ${api.envoyIp} to ${ip}`);
        api.envoyIp = ip;
      }
      if (userEmail && api.userEmail !== userEmail) {
        this.log(`Updating userEmail for shared EnvoyApi client SN ${serial}`);
        api.userEmail = userEmail;
        api.resetLoginBackoff();
      }
      if (password && api.password !== password) {
        this.log(`Updating password for shared EnvoyApi client SN ${serial}`);
        api.password = password;
        api.resetLoginBackoff();
      }
      if (initialToken && api.token !== initialToken) {
        // A device may still hold an older, expired copy of the token (e.g. a failed store write): never replace a
        // working client token with it, that would force a cloud login on every poll.
        const { exp } = api.evaluateTokenRole(initialToken);
        const expired = exp > 0 && exp < Math.floor(Date.now() / 1000);
        if (!api.token || !expired) {
          this.log(`Updating token for shared EnvoyApi client SN ${serial}`);
          api.token = initialToken;
          api.sessionCookie = null; // Clear cached cookie when token changes
        }
      }
    }

    return api;
  }

  /**
   * Pick the device whose settings and token the shared client uses: a maintainer token is preferred (it unlocks
   * power-mode/DPEL reads), then any control-capable device (one that exposes `isMaintainer`), then any with a token.
   * @private
   */
  _pickRepresentative(devices) {
    const hasToken = (d) => {
      try {
        return !!d.getStoreValue('enphase_token');
      } catch (err) {
        return false;
      }
    };
    return devices.find((d) => d.isMaintainer && hasToken(d))
      || devices.find((d) => d.isMaintainer)
      || devices.find((d) => d.isMaintainer !== undefined && hasToken(d))
      || devices.find((d) => d.isMaintainer !== undefined)
      || devices.find(hasToken)
      || devices[0];
  }

  /**
   * Shared client for a gateway runtime, refreshed from the representative device's settings.
   * @private
   */
  _resolveApi(rt) {
    const rep = this._pickRepresentative([...rt.devices.keys()]);
    if (!rep) return null;
    try {
      const settings = rep.getSettings();
      const token = rep.getStoreValue('enphase_token');
      rt.api = this.getApiInstance({
        serial: rt.serial,
        ip: settings.envoy_ip,
        userEmail: settings.user_email || this.homey.settings.get('user_email'),
        password: settings.password || this.homey.settings.get('password'),
        initialToken: token || null,
      });
      return rt.api;
    } catch (err) {
      this.error(`[Manager] Failed to resolve API client for serial ${rt.serial}:`, err.message);
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Normalise a registration declaration. Two-argument callers (legacy envoy/gateway/homeload) become
   * `{ telemetry: 'production', fast: false }`; new drivers declare their needs.
   * @private
   */
  _normalizeDeclaration(declaration) {
    if (!declaration || typeof declaration !== 'object') {
      return {
        telemetry: 'production', fast: false, sources: null, declared: false,
      };
    }
    let telemetry = null;
    if (declaration.telemetry === 'production' || declaration.telemetry === 'inverters') telemetry = declaration.telemetry;
    const sources = Array.isArray(declaration.sources) ? declaration.sources.filter((s) => KNOWN_SOURCES.includes(s)) : [];
    return {
      telemetry, fast: !!declaration.fast, sources: sources.length > 0 ? sources : null, declared: true,
    };
  }

  /**
   * Register a device for polling.
   * Devices never poll the gateway themselves: one scheduler per serial fetches once and dispatches to all devices.
   * Per-device polling multiplied requests on the small gateway and raced on session/token refresh.
   * Availability is owned by the core while a device is registered.
   * @param {string} serial - Gateway serial number
   * @param {Homey.Device} device - Device instance
   * @param {Object} [declaration] - Optional `{ telemetry: 'production'|'inverters'|null, fast: boolean, sources?: Array<'meters'|'production'|'batteryPower'|'inventory'> }`
   */
  registerDevice(serial, device, declaration) {
    if (!serial || !device) return;
    this.log(`[Manager] Registering device: ${device.getName()} for serial: ${serial}`);

    let rt = this.gateways.get(serial);
    const isFirst = !rt;
    if (!rt) {
      rt = this._createRuntime(serial);
      this.gateways.set(serial, rt);
    }

    const decl = this._normalizeDeclaration(declaration);
    const snapshot = decl.declared && typeof device.onEnphaseState === 'function';
    rt.devices.set(device, { decl, snapshot });
    rt.health.set(device, { avail: undefined, firstFailAt: null });
    rt.wantsSnapshots = this._wantsSnapshots(rt);
    this.log(`[Manager] Serial ${serial} now has ${rt.devices.size} registered device(s)`);

    const fastChanged = this._applySchedule(rt);

    // Snapshot devices get the latest state immediately, then every publication.
    if (snapshot && rt.latest) this._deliver(device, rt.latest);

    if (isFirst) {
      this.log(`[Manager] Starting polling for serial: ${serial}`);
    }
    if (decl.telemetry) {
      // First device: start the loop; later devices: populate their telemetry right away.
      this.pollGateway(serial).catch((err) => {
        this.error(`[Manager] Initial poll failed for serial ${serial}:`, err.message);
      });
    }
    if (rt.fastMs && (fastChanged || decl.fast)) {
      this._runFast(rt).catch((err) => this.error(`[Manager] Initial fast poll failed for serial ${serial}:`, err.message));
    }
    this._runBackground(rt);
    this._emitGateways();
  }

  /**
   * Unregister a device when it is deleted or uninitialized.
   * @param {string} serial - Gateway serial number
   * @param {Homey.Device} device - Device instance
   */
  unregisterDevice(serial, device) {
    if (!serial || !device) return;
    this.log(`[Manager] Unregistering device: ${device.getName()} for serial: ${serial}`);

    const rt = this.gateways.get(serial);
    if (!rt) return;
    rt.devices.delete(device);
    rt.health.delete(device);
    this.log(`[Manager] Serial ${serial} has ${rt.devices.size} registered device(s) remaining`);

    if (rt.devices.size === 0) {
      this.log(`[Manager] Stopping polling for serial: ${serial} (no devices remaining)`);
      this._stopTimer(rt);
      try {
        rt.model.persist(Date.now(), true);
      } catch (err) {
        this.error(`[Manager] Failed to persist battery energy for serial ${serial}:`, err.message);
      }
      this.gateways.delete(serial);
    } else {
      rt.wantsSnapshots = this._wantsSnapshots(rt);
      if (![...rt.devices.values()].some((e) => e.snapshot)) rt.latest = null;
      this._applySchedule(rt);
    }
    this._emitGateways();
  }

  /**
   * A registered device changed its `poll_interval` setting (or declaration inputs): recompute the effective fast
   * interval for its gateway. This is the only "notify the manager" call.
   * @param {string} serial - Gateway serial number
   * @param {Homey.Device} device - Device instance
   * @returns {Promise<void>}
   */
  async reconfigureDevice(serial, device) {
    const rt = this.gateways.get(serial);
    if (!rt || !rt.devices.has(device)) return;
    const apply = () => {
      if (this.gateways.get(serial) !== rt) return;
      const changed = this._applySchedule(rt);
      if (changed && rt.fastMs) {
        this._runFast(rt).catch((err) => this.error(`[Manager] Fast poll after reconfigure failed for serial ${serial}:`, err.message));
      }
    };
    apply();
    // Inside onSettings the device still reports its old setting value: re-check once it has been applied.
    if (rt.reconfigureTimer) this.homey.clearTimeout(rt.reconfigureTimer);
    rt.reconfigureTimer = this.homey.setTimeout(() => {
      rt.reconfigureTimer = null;
      apply();
    }, 1000);
  }

  /**
   * Force an immediate slow-tier poll for a serial number (coalesced with any running poll).
   * @param {string} serial - Gateway serial number
   */
  async triggerImmediatePoll(serial) {
    if (!serial) return;
    this.log(`[Manager] Triggering immediate poll for serial: ${serial}`);
    this.pollGateway(serial).catch((err) => {
      this.error(`[Manager] Immediate poll failed for serial: ${serial}:`, err.message);
    });
  }

  _createRuntime(serial) {
    const storage = {
      get: (key) => this.homey.settings.get(key),
      set: (key, value) => this.homey.settings.set(key, value),
    };
    return {
      serial,
      devices: new Map(), // device -> { decl, snapshot }
      health: new Map(), // device -> { avail, firstFailAt }
      model: new GatewayEnergyModel({ serial, log: (msg, ...args) => this.log(`[Energy ${serial}] ${msg}`, ...args), storage }),
      api: null,
      timer: null, // fast/background tick
      slowTimer: null, // slow tier, fixed 120 s
      reconfigureTimer: null,
      tickMs: null,
      fastMs: null,
      fastBusy: false,
      slowBusy: false,
      slowPending: false,
      bgBusy: false,
      invDueAt: 0,
      invFailures: 0,
      cfgDueAt: 0,
      cfgTriedAt: 0,
      wantsSnapshots: false,
      latest: null,
      consecutiveMaintainerFailures: 0,
      errLog: new Map(),
    };
  }

  _wantsSnapshots(rt) {
    return [...rt.devices.values()].some((e) => e.snapshot || e.decl.fast);
  }

  _stopTimer(rt) {
    if (rt.timer) {
      this.homey.clearInterval(rt.timer);
      rt.timer = null;
    }
    if (rt.slowTimer) {
      this.homey.clearInterval(rt.slowTimer);
      rt.slowTimer = null;
    }
    if (rt.reconfigureTimer) {
      this.homey.clearTimeout(rt.reconfigureTimer);
      rt.reconfigureTimer = null;
    }
  }

  /**
   * Requested fast interval of a device: `poll_interval` clamped to [5, 120] s; missing/invalid means 15 s.
   * @private
   */
  _requestedSeconds(device) {
    let value = null;
    try {
      value = Number(device.getSetting('poll_interval'));
    } catch (err) {
      value = null;
    }
    if (!Number.isFinite(value) || value <= 0) return FAST_DEFAULT_SECONDS;
    return Math.min(FAST_MAX_SECONDS, Math.max(FAST_MIN_SECONDS, Math.round(value)));
  }

  /**
   * Recompute the effective fast interval (fastest request among fast devices) and (re)create the scheduler timers
   * when the cadence changed: the fast/background tick timer, and a separate fixed 120 s slow-tier timer that
   * exists while a registered device declares telemetry. Widgets never request an interval or keep polling alive.
   * @returns {boolean} true when the fast interval changed
   * @private
   */
  _applySchedule(rt) {
    const fastDevices = [...rt.devices.entries()].filter(([, e]) => e.decl.fast).map(([d]) => d);
    const fastMs = fastDevices.length > 0 ? Math.min(...fastDevices.map((d) => this._requestedSeconds(d))) * 1000 : null;
    const tickMs = fastMs || SLOW_INTERVAL_MS;
    const changed = fastMs !== rt.fastMs;

    // The tick timer only serves the fast tier and background refreshes (snapshot devices)
    if (!fastMs && !rt.wantsSnapshots) {
      if (rt.timer) this.homey.clearInterval(rt.timer);
      rt.timer = null;
      rt.tickMs = null;
    } else if (!rt.timer || tickMs !== rt.tickMs) {
      if (rt.timer) this.homey.clearInterval(rt.timer);
      rt.tickMs = tickMs;
      rt.timer = this.homey.setInterval(() => this._tick(rt), tickMs);
    }

    const hasTelemetry = [...rt.devices.values()].some((e) => e.decl.telemetry);
    if (hasTelemetry && !rt.slowTimer) {
      rt.slowTimer = this.homey.setInterval(() => {
        if (this.gateways.get(rt.serial) !== rt) return;
        this.pollGateway(rt.serial).catch((err) => this.error(`[Manager] Interval poll failed for serial ${rt.serial}:`, err.message));
      }, SLOW_INTERVAL_MS);
    } else if (!hasTelemetry && rt.slowTimer) {
      this.homey.clearInterval(rt.slowTimer);
      rt.slowTimer = null;
    }
    rt.fastMs = fastMs;
    rt.model.setFastIntervalMs(fastMs);
    if (changed) this.log(`[Manager] Serial ${rt.serial}: fast interval ${fastMs ? `${fastMs / 1000}s` : 'off'}`);
    return changed;
  }

  /**
   * Scheduler tick for the fast tier and background refreshes (the slow tier has its own timer). Nothing here is
   * awaited; each tier guards itself with a busy flag so slow responses cannot accumulate a backlog of ticks.
   * @private
   */
  _tick(rt) {
    if (this.gateways.get(rt.serial) !== rt) return;
    if (rt.fastMs) {
      this._runFast(rt).catch((err) => this.error(`[Manager] Fast poll failed for serial ${rt.serial}:`, err.message));
    }
    this._runBackground(rt);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Availability (core-owned) and failure tracking
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * A device's data was obtained: mark it available. Devices without `sources` (legacy) keep the 1.5.x behaviour of
   * asserting availability on every successful slow poll; others only on transitions.
   * @private
   */
  _markSuccess(rt, device, always) {
    const health = rt.health.get(device);
    if (!health) return;
    health.firstFailAt = null;
    if (always || health.avail !== true) {
      health.avail = true;
      Promise.resolve(device.setAvailable()).catch((err) => {
        this.error(`[Manager] Failed to set device ${device.getName()} available:`, err.message);
      });
    }
  }

  /**
   * A device's required telemetry failed. The 30-minute clock is per device and starts at the first failed attempt
   * after its last success.
   * @private
   */
  _markFailure(rt, device, err) {
    const health = rt.health.get(device);
    if (!health) return;
    const now = Date.now();
    if (!health.firstFailAt) health.firstFailAt = now;
    const elapsedMs = now - health.firstFailAt;

    if (elapsedMs >= UNAVAILABLE_GRACE_MS) {
      if (health.avail !== false) {
        health.avail = false;
        this.log(`[Manager] Polling failure persisted for device ${device.getName()}. Setting it unavailable.`);
        Promise.resolve(device.setUnavailable((err && err.message) || 'Offline')).catch((e) => {
          this.error(`[Manager] Failed to set device ${device.getName()} unavailable:`, e.message);
        });
      }
    }
  }

  /**
   * Report the outcome of a source to every registered device that declares it in `sources`.
   * An `absent` source (e.g. meters without an enabled CT) is neither success nor failure.
   * @param {Object} rt
   * @param {'meters'|'production'|'batteryPower'|'inventory'} source
   * @param {'ok'|'fail'|'absent'} outcome
   * @param {Error} [err]
   * @private
   */
  _sourceOutcome(rt, source, outcome, err) {
    if (outcome === 'absent') return;
    for (const [device, entry] of rt.devices) {
      if (!entry.decl.sources || !entry.decl.sources.includes(source)) continue;
      if (outcome === 'ok') this._markSuccess(rt, device, false);
      else this._markFailure(rt, device, err);
    }
  }

  /** Log a repeating failure at most once per message per 5 minutes (the fast tier would flood the log). */
  _logFailure(rt, key, err) {
    const now = Date.now();
    const prev = rt.errLog.get(key);
    if (prev && prev.message === err.message && now - prev.at < 5 * 60 * 1000) return;
    rt.errLog.set(key, { message: err.message, at: now });
    this.error(`[Manager] ${key} failed for serial ${rt.serial}:`, err.message);
  }

  /**
   * If the cloud login rejected the credentials, clear the stored tokens. Local failures (401, 503, timeouts) never
   * clear the JWT. Note: fetchNewToken() currently rethrows a generic "Both ... paths failed" message, so this
   * branch is effectively unreachable today (auth semantics are deliberately unchanged).
   * @private
   */
  async _maybeClearTokens(rt, api, err) {
    if (!(err && err.message && (err.message.includes('login failed') || err.message.includes('verify email and password')))) return;
    this.log(`[Manager] Invalid credentials detected for serial ${rt.serial}. Clearing tokens.`);
    if (api) api.token = null;
    for (const dev of rt.devices.keys()) {
      await dev.setStoreValue('enphase_token', null).catch((e) => {
        this.error(`[Manager] Failed to clear token in store for device ${dev.getName()}:`, e.message);
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Slow tier (legacy cycle)
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Central slow-tier poll handler for a specific serial number (production, inverters, power mode, DPEL).
   * @param {string} serial - Gateway serial number
   */
  async pollGateway(serial) {
    const rt = this.gateways.get(serial);
    if (!rt || rt.devices.size === 0) {
      this.log(`[Manager] No registered devices for serial: ${serial}. Skipping poll.`);
      return;
    }

    if (rt.slowBusy) {
      this.log(`[Manager] Poll already in progress for serial: ${serial}. Scheduling a pending poll on completion.`);
      rt.slowPending = true;
      return;
    }

    rt.slowBusy = true;
    try {
      await this._runSlow(rt);
    } catch (err) {
      this.error(`[Manager] Polling error for serial ${serial}:`, err.message);
    } finally {
      rt.slowBusy = false;
      if (rt.slowPending) {
        rt.slowPending = false;
        this.log(`[Manager] Executing scheduled pending poll for serial: ${serial}`);
        this.pollGateway(serial).catch((err) => {
          this.error(`[Manager] Pending poll failed for serial ${serial}:`, err.message);
        });
      }
    }
  }

  /**
   * Slow tier body. Devices are selected by their declared telemetry, never by driver id.
   * @private
   */
  async _runSlow(rt) {
    const entries = [...rt.devices.entries()];
    const productionDevices = entries.filter(([, e]) => e.decl.telemetry === 'production').map(([d]) => d);
    const invertersDevices = entries.filter(([, e]) => e.decl.telemetry === 'inverters').map(([d]) => d);
    if (productionDevices.length === 0 && invertersDevices.length === 0) return;

    const api = this._resolveApi(rt);
    if (!api) return;

    // Duck-typed role/metering flags (read-only devices simply do not expose them)
    const devices = entries.map(([d]) => d);
    let isMaintainer = devices.some((d) => d.isMaintainer);
    // metered = has solar production clamps; only control-capable devices (those exposing isMaintainer) are asked
    const isMetered = devices.some((d) => d.isMaintainer !== undefined && d.isMetered);

    let prodData = null;
    let prodError = null;
    let powerForcedOff = false;
    let pelSettings = null; // Stored DPEL (dynamic limit) settings from local gateway API
    let invertersData = null;
    let invertersError = null;

    // 1. Production telemetry (plus power mode / DPEL for maintainer tokens)
    if (productionDevices.length > 0) {
      try {
        if (isMaintainer) {
          try {
            powerForcedOff = await api.getPowerForcedOffstate();
            rt.consecutiveMaintainerFailures = 0;
          } catch (err) {
            this.error(`[Manager] Failed to fetch power mode for serial ${rt.serial}:`, err.message);

            if (err.message && err.message.includes('401')) {
              rt.consecutiveMaintainerFailures += 1;
              this.log(`[Manager] Consecutive power mode 401 failures for serial ${rt.serial}: ${rt.consecutiveMaintainerFailures}/3`);

              if (rt.consecutiveMaintainerFailures >= 3) {
                this.log(`[Manager] Threshold reached. Automatically downgrading serial ${rt.serial} to System Owner.`);
                for (const dev of devices) {
                  if (typeof dev.updateRole === 'function') {
                    await Promise.resolve(dev.updateRole(false)).catch((e) => this.error(`[Manager] Failed to demote ${dev.getName()}:`, e.message));
                  }
                }
                isMaintainer = false;
              }
            }
          }

          // DPEL (dynamic export/production limit) only works on metered gateways; skipped on unmetered ones
          if (isMetered) {
            try {
              pelSettings = await api.getDpelSettings();
            } catch (err) {
              this.error(`[Manager] Failed to fetch DPEL settings for serial ${rt.serial}:`, err.message);
            }
          }
        }
        prodData = await api.getProductionData();
        try {
          rt.model.recordProduction(api.lastProduction, Date.now());
        } catch (err) {
          // The energy model must never break the legacy path
          this._logFailure(rt, 'Energy model production update', err);
        }
      } catch (err) {
        prodData = null;
        prodError = err;
        this._logFailure(rt, 'Production poll', err);
        rt.model.recordFailure('production', err, Date.now());
        await this._maybeClearTokens(rt, api, err);
      }
    }

    // 2. Individual inverter telemetry
    if (invertersDevices.length > 0) {
      try {
        invertersData = await api.getInvertersData();
      } catch (err) {
        invertersError = err;
        this._logFailure(rt, 'Inverters poll', err);
        await this._maybeClearTokens(rt, api, err);
      }
    }

    // 3. Dispatch legacy telemetry, then settle availability
    for (const dev of productionDevices) {
      if (prodData) {
        // homeload-style handlers ignore the extra arguments
        await this._callTelemetry(dev, [prodData, powerForcedOff, pelSettings]);
      }
    }
    for (const dev of invertersDevices) {
      if (invertersData) await this._callTelemetry(dev, [invertersData]);
    }

    const settleDevices = (list, error, source) => {
      for (const dev of list) {
        const entry = rt.devices.get(dev);
        if (!entry || entry.decl.sources) continue; // unregistered meanwhile, or handled per source below
        if (error) this._markFailure(rt, dev, error);
        else this._markSuccess(rt, dev, true);
      }
      if (source) this._sourceOutcome(rt, source, error ? 'fail' : 'ok', error);
    };
    if (productionDevices.length > 0) settleDevices(productionDevices, prodError, 'production');
    if (invertersDevices.length > 0) settleDevices(invertersDevices, invertersError, null);

    if (prodData) this._publish(rt);
  }

  async _callTelemetry(device, args) {
    try {
      await device.updateTelemetry(...args);
    } catch (err) {
      this.error(`[Manager] Device ${device.getName()} updateTelemetry failed:`, err.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Fast tier and background refreshes
  // ---------------------------------------------------------------------------------------------------------------

  /** Feed the cached meters configuration (shared with the slow tier's TTL cache) to the model. */
  _syncMetersConfig(rt, api) {
    rt.model.setMetersConfig(api.cachedMeters, api.metersConfigAbsent, api.cachedMetersAt);
  }

  /**
   * One fast attempt: endpoint-gated light reads, recorded per source, then publish. Skipped while the previous
   * attempt is still running (no backlog).
   * @private
   */
  async _runFast(rt) {
    if (!rt.fastMs || rt.fastBusy || rt.devices.size === 0) return;
    rt.fastBusy = true;
    try {
      const api = this._resolveApi(rt);
      if (!api) return;
      const { model } = rt;

      // The CT configuration maps readings to roles. Only when it is unknown is it fetched inline (a cheap
      // request, rate-limited to every 30 s); normally it is refreshed in the background.
      this._syncMetersConfig(rt, api);
      let configError = null;
      if (model.needsMetersConfig() && Date.now() - rt.cfgTriedAt >= METERS_CONFIG_RETRY_MS) {
        rt.cfgTriedAt = Date.now();
        try {
          await api.refreshMetersConfig();
          this._syncMetersConfig(rt, api);
        } catch (err) {
          configError = err;
        }
      }

      // Gate individual endpoints, not the whole tier
      const readMeters = model.shouldReadMeters();
      const readBattery = model.shouldReadBattery();
      const [metersResult, batteryResult] = await Promise.all([
        readMeters ? settle(api.getMeterReadings()) : null,
        readBattery ? settle(api.getEnsemblePower()) : null,
      ]);
      if (this.gateways.get(rt.serial) !== rt) return;

      // Meters
      if (metersResult) {
        let error = metersResult.ok ? null : metersResult.error;
        if (metersResult.ok) {
          try {
            model.recordMeters(metersResult.value, metersResult.at);
          } catch (err) {
            error = err;
          }
        }
        if (error) {
          model.recordFailure('meters', error, metersResult.at);
          this._logFailure(rt, 'Meter readings', error);
          this._sourceOutcome(rt, 'meters', 'fail', error);
          await this._maybeClearTokens(rt, api, error);
        } else {
          this._sourceOutcome(rt, 'meters', 'ok');
        }
      } else if (model.cfg.known && !model.cfg.readable) {
        this._sourceOutcome(rt, 'meters', 'absent');
      } else if (configError) {
        model.recordFailure('meters', configError, Date.now());
        this._logFailure(rt, 'Meters configuration', configError);
        this._sourceOutcome(rt, 'meters', 'fail', configError);
        await this._maybeClearTokens(rt, api, configError);
      }

      // Battery power
      if (batteryResult) {
        let error = batteryResult.ok ? null : batteryResult.error;
        if (batteryResult.ok) {
          try {
            const { units } = model.recordBatteryPower(batteryResult.value, batteryResult.at, batteryResult.mono);
            if (units === 0 && model.hasBattery() === null && rt.invFailures === 0) rt.invDueAt = 0; // let the inventory decide soon
          } catch (err) {
            error = err;
          }
        }
        if (error) {
          model.recordFailure('batteryPower', error, batteryResult.at);
          this._logFailure(rt, 'Battery power', error);
          this._sourceOutcome(rt, 'batteryPower', 'fail', error);
          if (error.status === 404 && model.hasBattery() === null && rt.invFailures === 0) rt.invDueAt = 0;
          await this._maybeClearTokens(rt, api, error);
        } else {
          this._sourceOutcome(rt, 'batteryPower', 'ok');
        }
      } else {
        this._sourceOutcome(rt, 'batteryPower', 'absent');
      }

      this._publish(rt);
      model.persist(Date.now());
    } finally {
      rt.fastBusy = false;
    }
  }

  /**
   * Background refreshes (inventory, meter configuration). Fire-and-forget: never awaited by a fast tick.
   * @param {Object} rt
   * @private
   */
  _runBackground(rt) {
    if (!rt.wantsSnapshots || rt.bgBusy) return;
    const now = Date.now();
    const inventoryDue = now >= rt.invDueAt;
    const configDue = now >= rt.cfgDueAt;
    if (!inventoryDue && !configDue) return;

    rt.bgBusy = true;
    (async () => {
      const api = this._resolveApi(rt);
      if (!api) return;
      const { model } = rt;
      let publish = false;

      if (inventoryDue) {
        const started = Date.now();
        try {
          const json = await api.getEnsembleInventory();
          model.recordInventory(json, Date.now());
          rt.invFailures = 0;
          rt.invDueAt = started + (model.invHas ? INVENTORY_REFRESH_MS : INVENTORY_REDETECT_MS);
          this._sourceOutcome(rt, 'inventory', 'ok');
          publish = true;
        } catch (err) {
          if (err.status === 404) {
            // Definitive "no storage" on a gateway that otherwise answers
            model.recordInventoryAbsent(Date.now());
            rt.invFailures = 0;
            rt.invDueAt = started + INVENTORY_REDETECT_MS;
            this._sourceOutcome(rt, 'inventory', 'absent');
            publish = true;
          } else {
            // Unknown (timeout, 401/5xx, unparseable): proves nothing, retry with backoff
            model.recordFailure('inventory', err, Date.now());
            rt.invFailures += 1;
            rt.invDueAt = started + Math.min(INVENTORY_RETRY_MAX_MS, INVENTORY_RETRY_MIN_MS * (2 ** (rt.invFailures - 1)));
            this._logFailure(rt, 'Ensemble inventory', err);
            this._sourceOutcome(rt, 'inventory', 'fail', err);
            await this._maybeClearTokens(rt, api, err);
          }
        }
      }

      if (configDue) {
        const started = Date.now();
        try {
          await api.refreshMetersConfig();
          this._syncMetersConfig(rt, api);
          rt.cfgDueAt = started + METERS_CONFIG_REFRESH_MS;
        } catch (err) {
          rt.cfgDueAt = started + METERS_CONFIG_RETRY_MS * 2;
          this._logFailure(rt, 'Meters configuration refresh', err);
        }
      }

      if (publish && this.gateways.get(rt.serial) === rt) this._publish(rt);
    })().catch((err) => {
      this.error(`[Manager] Background refresh failed for serial ${rt.serial}:`, err.message);
    }).finally(() => {
      rt.bgBusy = false;
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // State snapshot publication and widget feed
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Build the snapshot, hand it to every snapshot-model device (each call isolated) and emit `enphase:flow`.
   * @private
   */
  _publish(rt) {
    if (!rt.wantsSnapshots || this.gateways.get(rt.serial) !== rt) return;
    let state;
    try {
      state = rt.model.snapshot(Date.now(), { fastIntervalSeconds: rt.fastMs ? rt.fastMs / 1000 : null });
    } catch (err) {
      this.error(`[Manager] Failed to build state snapshot for serial ${rt.serial}:`, err.message);
      return;
    }
    rt.latest = state;

    for (const [device, entry] of rt.devices) {
      if (entry.snapshot) this._deliver(device, state);
    }
    this._realtime(EVENT_FLOW, state);
  }

  /** Deliver a snapshot to one device without letting a sync throw or a slow handler affect others. */
  _deliver(device, state) {
    Promise.resolve().then(() => device.onEnphaseState(state)).catch((err) => {
      this.error(`[Manager] Device ${device.getName()} onEnphaseState failed:`, err.message);
    });
  }

  _realtime(event, data) {
    try {
      if (this.homey.api && typeof this.homey.api.realtime === 'function') {
        Promise.resolve(this.homey.api.realtime(event, data)).catch((err) => {
          this.error(`[Manager] Realtime emit ${event} failed:`, err.message);
        });
      }
    } catch (err) {
      this.error(`[Manager] Realtime emit ${event} failed:`, err.message);
    }
  }

  /**
   * Latest state snapshot for a gateway serial.
   * @param {string} serial - Gateway serial
   * @returns {Object|null} Frozen snapshot, or null before the first publication / without snapshot devices
   */
  getLatestState(serial) {
    const rt = this.gateways ? this.gateways.get(serial) : null;
    return rt && rt.latest ? rt.latest : null;
  }

  /**
   * Credential-free list of known gateways, from all paired devices of all drivers (so legacy-only and
   * not-yet-registered gateways are listed). `widgetEligible` is true while a snapshot-model device (declared and
   * implementing onEnphaseState) is registered on the serial.
   * @returns {Array<{ serial: string, name: string, widgetEligible: boolean }>}
   */
  getKnownGateways() {
    if (!this.gateways || !this.homey || !this.homey.drivers) return [];
    const found = new Map();
    try {
      for (const driver of Object.values(this.homey.drivers.getDrivers() || {})) {
        let devices = [];
        try {
          devices = driver.getDevices();
        } catch (err) {
          continue;
        }
        for (const dev of devices) {
          let serial;
          let name;
          try {
            serial = dev.getSettings().envoy_serial;
            name = dev.getName();
          } catch (err) {
            continue;
          }
          if (!serial || typeof serial !== 'string') continue;
          const rt = this.gateways ? this.gateways.get(serial) : null;
          const entry = rt ? rt.devices.get(dev) : null;
          const isSnapshot = !!(entry && entry.snapshot);
          const current = found.get(serial);
          if (!current) {
            found.set(serial, {
              serial, name: name || serial, widgetEligible: false, named: isSnapshot,
            });
          } else if (isSnapshot && !current.named) {
            current.name = name || serial;
            current.named = true;
          }
        }
      }
    } catch (err) {
      return [];
    }
    return [...found.values()]
      .map((g) => ({
        serial: g.serial,
        name: g.name,
        widgetEligible: !!(this.gateways.get(g.serial) && [...this.gateways.get(g.serial).devices.values()].some((e) => e.snapshot)),
      }))
      .sort((a, b) => a.serial.localeCompare(b.serial));
  }

  /** Emit `enphase:gateways` when the gateway list or eligibility changed. @private */
  _emitGateways() {
    const list = this.getKnownGateways();
    const json = JSON.stringify(list);
    if (json === this._gatewaysJson) return;
    this._gatewaysJson = json;
    this._realtime(EVENT_GATEWAYS, list);
  }

}

module.exports = EnphaseController;
