'use strict';

const net = require('net');
const fetch = require('node-fetch');
const EnvoyAuth = require('./EnvoyAuth');
const { classifyMeters, parseInventory } = require('./energyModel');

// Share the exact same httpsAgent instance from parent class to pool TCP/TLS sockets
const { httpsAgent } = EnvoyAuth;

// Meter type strings returned by Enphase /ivp/meters endpoint
const PRODUCTION_METER_TYPES = ['production'];
const GRIDPOWER_METER_TYPES = ['net-consumption', 'consumption'];
const HOMEPOWER_METER_TYPES = ['total-consumption', 'consumption'];

// Key/Property names inside production.json (checked against both .measurementType and .type)
const GRIDPOWER_KEYS = ['net-consumption'];
const HOMEPOWER_KEYS = ['total-consumption'];

// The gateway has few concurrent connection slots (4-8 per earlier notes, unverified) and shares them with the
// Enphase app and other local clients. At most this many requests per gateway run at once (fast reads, slow tier,
// background refreshes and control writes all share the bound). The queue is FIFO, so a slow request is never
// starved by continuously due fast reads.
const MAX_CONCURRENT_REQUESTS = 2;

// /ivp/meters (CT configuration) is cached but not for the process lifetime: an installer may enable/disable a CT.
const METERS_CONFIG_TTL_MS = 10 * 60 * 1000;
// Minimum wait before getMetersConfig() retries a failed refresh (explicit refreshMetersConfig() calls are not held back).
const METERS_CONFIG_RETRY_MS = 60000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Gateway client on top of EnvoyAuth: telemetry, local production control and token role validation.
 */
class EnvoyApi extends EnvoyAuth {

  /**
   * Envoy API Client
   * @param {Object} opts
   * @param {Homey} [opts.homey] - Homey instance
   * @param {boolean} [opts.enableDiscovery] - Enable background discovery listener
   * @param {Function} [opts.onIpUpdated] - Callback when local IP is updated via discovery
   */
  constructor(opts) {
    super(opts);
    this.homey = opts.homey;
    this.onIpUpdated = opts.onIpUpdated || (() => { });
    this.cachedMeters = null;
    this.cachedMetersAt = 0;
    this._metersFailedAt = 0; // last failed /ivp/meters refresh (implicit callers back off, see getMetersConfig)
    this.metersConfigAbsent = false; // /ivp/meters answered 404 (definitive: no meter support)
    this.lastProduction = null; // Per-section detail of the last getProductionData(), consumed by the energy model
    this._metersPromise = null;
    this._activeRequests = 0;
    this._requestQueue = [];

    if (opts.enableDiscovery && this.homey && this.envoySerial) {
      try {
        const strategy = this.homey.discovery.getStrategy('enphase-envoy');
        if (strategy) {
          this.discoveryListener = (result) => {
            this.log('[Auto-IP] Received background discovery result:', JSON.stringify(result));
            const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
            if (serial === this.envoySerial && ip && ip !== this.envoyIp) {
              this.log(`[Auto-IP] Envoy with SN ${this.envoySerial} moved from ${this.envoyIp} to ${ip}. Auto-updating...`);
              this.envoyIp = ip;
              this.onIpUpdated(ip).catch((err) => {
                this.log('Error triggering IP updated callback:', err.message);
              });
            }
          };
          strategy.on('result', this.discoveryListener);
        }
      } catch (err) {
        this.log('Failed to register discovery listener:', err.message);
      }
    }
  }

  /**
   * Clean up background listeners to prevent leaks.
   */
  destroy() {
    if (this.discoveryListener && this.homey) {
      try {
        const strategy = this.homey.discovery.getStrategy('enphase-envoy');
        if (strategy) {
          strategy.removeListener('result', this.discoveryListener);
        }
      } catch (err) {
        this.log('Failed to remove discovery listener:', err.message);
      }
      this.discoveryListener = null;
    }
  }

  /**
   * Parse a discovery advertisement result to extract the IP address and 12-digit serial number.
   * @param {Object} result - Discovery result metadata
   * @returns {{ ip: string, serial: string }} Extracted details
   */
  static parseDiscoveryResult(result) {
    if (!result) return { ip: '', serial: '' };

    // 1. Extract 12-digit serial number (prefer result.id)
    let serial = result.id || '';
    if (!/^\d{12}$/.test(serial)) {
      const txtValues = result.txt ? Object.values(result.txt).join(' ') : '';
      const searchPool = [result.id, result.name, result.host, result.fullname, txtValues].join(' ');
      const serialMatch = searchPool.match(/\b\d{12}\b/);
      if (serialMatch) {
        serial = serialMatch[0];
      }
    }

    // 2. Extract discovered IP address (prefer IPv4)
    let ip = '';
    if (Array.isArray(result.addresses)) {
      const ipv4 = result.addresses.find((addr) => addr && !addr.includes(':') && addr.includes('.'));
      if (ipv4) {
        ip = ipv4;
      }
    }
    if (!ip && result.address && !result.address.includes(':')) {
      ip = result.address;
    }
    // Fallback to routeable IPv6 if no IPv4 is available. Link-local (fe80::) is skipped: it needs an
    // interface scope id (%eth0) that Node cannot use, so connections to it time out.
    if (!ip && Array.isArray(result.addresses)) {
      const routeableIpv6 = result.addresses.find((addr) => addr && addr.includes(':') && !addr.toLowerCase().startsWith('fe80'));
      if (routeableIpv6) {
        ip = routeableIpv6;
      }
    }

    return {
      ip: ip || '',
      serial: serial || '',
    };
  }

  /**
   * Read the gateway serial from the unauthenticated /info.xml (`<sn>`). IP only (no hostnames), short timeout,
   * never throws.
   * @param {string} ip - Gateway IP address (IPv4 or IPv6 literal)
   * @returns {Promise<{ serial: string|null, reason: null|'unreadable'|'unsupported' }>} serial is exactly 12 digits or null
   */
  static async getGatewaySerial(ip) {
    const addr = typeof ip === 'string' ? ip.trim().replace(/^\[|\]$/g, '') : '';
    if (!net.isIP(addr)) return { serial: null, reason: 'unreadable' };
    const host = addr.includes(':') ? `[${addr}]` : addr;

    try {
      const response = await fetch(`https://${host}/info.xml`, {
        method: 'GET',
        agent: httpsAgent,
        timeout: 5000,
        size: 65536,
      });
      const body = await response.text();
      if (!response.ok) return { serial: null, reason: 'unsupported' };
      const match = body.match(/<sn>\s*([^<]*?)\s*<\/sn>/i);
      if (!match) return { serial: null, reason: 'unsupported' };
      return /^\d{12}$/.test(match[1]) ? { serial: match[1], reason: null } : { serial: null, reason: 'unreadable' };
    } catch (err) {
      return { serial: null, reason: 'unreadable' };
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Request plumbing
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Run `fn` under the per-gateway concurrency bound (FIFO).
   * @template T
   * @param {function(): Promise<T>} fn
   * @returns {Promise<T>}
   * @private
   */
  async _limited(fn) {
    if (this._activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => {
        this._requestQueue.push(resolve);
      });
    } else {
      this._activeRequests += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this._requestQueue.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this._activeRequests -= 1;
      }
    }
  }

  /**
   * Authenticated local request: Bearer JWT + cached session cookie. Token and session setup (cloud login,
   * check_jwt) run outside the concurrency bound: only the actual fetch holds a slot, so requests waiting for a
   * shared login can never occupy every slot and starve the work that login (or its callbacks) needs. On a 401 the session is refreshed (shared by
   * parallel requests, and not re-done when another request already installed a newer cookie) and the request is
   * retried exactly once. The JWT is never discarded for a local failure.
   * @param {string} path - Request path (e.g. `/ivp/meters`)
   * @param {Object} [opts]
   * @param {string} [opts.method='GET']
   * @param {string} [opts.body]
   * @param {string} [opts.contentType]
   * @param {number} [opts.timeout=15000]
   * @returns {Promise<Response>} Response (callers check `ok`; use _json for the error convention)
   * @private
   */
  async _request(path, {
    method = 'GET', body, contentType, timeout = 15000,
  } = {}) {
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const url = `https://${this.getFormattedHost()}${path}`;
    const send = (c) => this._limited(() => {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}`, Cookie: c };
      if (contentType) headers['Content-Type'] = contentType;
      return fetch(url, {
        method, headers, body, agent: httpsAgent, timeout,
      });
    });

    let response = await send(cookie);
    // A 401 usually means the gateway dropped our session (eviction, restart), not bad credentials.
    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.refreshSessionCookie(token, cookie);
      response = await send(cookie);
    }
    return response;
  }

  /**
   * Read a JSON body or throw `<prefix>. Status: <code>` (the message format callers and the 401 demotion rely on).
   * The error carries `.status`. Failed bodies are drained so the socket can be reused.
   * @private
   */
  async _json(response, prefix) {
    if (!response.ok) {
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      const error = new Error(`${prefix}. Status: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Fetch PowerForcedOff state from the Envoy.
   * @returns {Promise<boolean>} True if power forced off is true (disabled production)
   */
  async getPowerForcedOffstate() {
    const response = await this._request('/ivp/mod/603980032/mode/power');
    const result = await this._json(response, 'Power mode data fetch failed');
    this.log('Power mode data retrieved from Envoy.');

    // Safely return powerForcedOff field
    if (result && typeof result.powerForcedOff !== 'undefined') {
      return result.powerForcedOff;
    }
    throw new Error('Envoy response did not contain powerForcedOff state.');
  }

  /**
   * Fetch meters configuration (CT roles and enabled state). Cached for 10 minutes, then refreshed; a failed
   * refresh keeps the previous configuration.
   * @returns {Promise<Array<Object>|null>}
   */
  async getMetersConfig() {
    if (this.cachedMeters && Date.now() - this.cachedMetersAt < METERS_CONFIG_TTL_MS) return this.cachedMeters;
    // After a failed refresh implicit callers keep what they have for a while instead of retrying on every call
    if (this._metersFailedAt && Date.now() - this._metersFailedAt < METERS_CONFIG_RETRY_MS) return this.cachedMeters;
    return this.refreshMetersConfig();
  }

  /**
   * Force a refresh of the meters configuration (concurrent callers share one request).
   * A definitive 404 means the gateway has no meter support: the configuration becomes an empty list and
   * `metersConfigAbsent` is set. Other failures keep the cached configuration (network errors are rethrown when
   * nothing is cached).
   * @returns {Promise<Array<Object>|null>}
   */
  async refreshMetersConfig() {
    if (this._metersPromise) return this._metersPromise;

    const promise = (async () => {
      let response;
      try {
        this.log('Fetching meters configuration...');
        response = await this._request('/ivp/meters', { timeout: 10000 });
      } catch (err) {
        this._metersFailedAt = Date.now();
        if (this.cachedMeters) {
          this.log(`Meters configuration refresh failed, keeping cached configuration: ${err.message}`);
          return this.cachedMeters;
        }
        throw err;
      }

      if (response.ok) {
        let meters = null;
        try {
          meters = await response.json();
        } catch (err) {
          this.log(`Meters configuration response was not valid JSON: ${err.message}`);
        }
        if (Array.isArray(meters)) {
          this.cachedMeters = meters;
          this.cachedMetersAt = Date.now();
          this.metersConfigAbsent = false;
          this._metersFailedAt = 0;
        } else {
          this._metersFailedAt = Date.now();
        }
      } else {
        try {
          await response.text();
        } catch (err) {
          // ignore
        }
        if (response.status === 404) {
          this.cachedMeters = [];
          this.cachedMetersAt = Date.now();
          this.metersConfigAbsent = true;
          this._metersFailedAt = 0;
        } else {
          this._metersFailedAt = Date.now();
        }
        this.log(`Failed to fetch meters config. Status: ${response.status}`);
      }
      return this.cachedMeters;
    })();
    this._metersPromise = promise;

    try {
      return await promise;
    } finally {
      if (this._metersPromise === promise) this._metersPromise = null;
    }
  }

  /**
   * Fetch detailed meter readings from local Envoy. Light endpoint, used by the fast tier (every few seconds) and
   * by the slow tier's energy enrichment.
   * @param {number} [timeout=8000] - Request timeout in ms (the slow-tier enrichment allows longer)
   * @returns {Promise<Array<Object>>}
   */
  async getMeterReadings(timeout = 8000) {
    const response = await this._request('/ivp/meters/readings', { timeout });
    return this._json(response, 'Meter readings fetch failed');
  }

  /**
   * Fetch live battery power per unit (`/ivp/ensemble/power`). Light endpoint, used by the fast tier.
   * Parsing, units and the sign flip live in lib/energyModel.js.
   * @returns {Promise<Object>} Raw response; errors carry `.status`
   */
  async getEnsemblePower() {
    const response = await this._request('/ivp/ensemble/power', { timeout: 8000 });
    return this._json(response, 'Ensemble power fetch failed');
  }

  /**
   * Fetch the Ensemble inventory (`/ivp/ensemble/inventory`): battery presence, grid-tie state, SoC fallback.
   * Slow-changing; refreshed in the background, never per fast tick. Errors carry `.status` (404 is a definitive
   * "no storage" answer, other failures prove nothing).
   * @returns {Promise<Array<Object>>}
   */
  async getEnsembleInventory() {
    const response = await this._request('/ivp/ensemble/inventory', { timeout: 10000 });
    return this._json(response, 'Ensemble inventory fetch failed');
  }

  /**
   * Fetch production data from the Envoy.
   * Heavy endpoint: the gateway needs 1.6-9.3 s to compile /production.json (observed), hence the 30 s timeout.
   * Also records per-section detail (with reading times) in `this.lastProduction` for the energy model; the returned
   * object keeps the legacy shape.
   * @returns {Promise<Object>} Production data object containing wattsNow and kwhLifetime
   */
  async getProductionData() {
    const response = await this._request('/production.json', { timeout: 30000 }); // 30s to absorb slow Envoy compile times
    const result = await this._json(response, 'Production data fetch failed');
    const receivedAt = Date.now();
    this.log('Production data retrieved from Envoy.');

    let solarpowerWatts = 0;
    let solarpowerKwhLifetime = 0;
    let connectedInverters = 0;
    let readingTime = 0;
    let isMetered = false;
    let solarDetail = null;

    // Reading time of a production.json entry (epoch s) as ms; collection time when absent. Never in the future.
    const observedMs = (entry) => (entry && finite(entry.readingTime) && entry.readingTime > 0
      ? Math.min(entry.readingTime * 1000, receivedAt) : receivedAt);

    // Fetch meters config early to verify if CT clamps are physically enabled
    let metersConfig = null;
    try {
      metersConfig = await this.getMetersConfig();
    } catch (err) {
      this.log('Failed to fetch meters config in getProductionData:', err.message);
    }

    if (result && Array.isArray(result.production)) {
      const eimProd = result.production.find((p) => p.type === 'eim');
      const invProd = result.production.find((p) => p.type === 'inverters');

      if (invProd && typeof invProd.activeCount !== 'undefined') {
        connectedInverters = invProd.activeCount;
      }

      const hasEimProduction = !!(eimProd && typeof eimProd.wNow !== 'undefined' && eimProd.whLifetime > 0);
      if (metersConfig && Array.isArray(metersConfig)) {
        const prodMeter = metersConfig.find((m) => PRODUCTION_METER_TYPES.includes(m.measurementType));
        if (prodMeter) {
          isMetered = prodMeter.state === 'enabled';
        } else {
          isMetered = hasEimProduction;
        }
      } else {
        isMetered = hasEimProduction;
      }

      readingTime = (eimProd && eimProd.readingTime) || (invProd && invProd.readingTime) || Math.floor(Date.now() / 1000);

      // Use eim only if it is present, has active power, and valid non-zero lifetime reading
      // (an enabled production CT without an eim entry falls through to the inverters instead of throwing)
      if (isMetered && eimProd) {
        solarpowerWatts = Math.max(0, eimProd.wNow);
        solarpowerKwhLifetime = eimProd.whLifetime / 1000.0;
        solarDetail = {
          w: solarpowerWatts, kWh: solarpowerKwhLifetime, observedAt: observedMs(eimProd), source: 'eim',
        };
      } else if (invProd && typeof invProd.wNow !== 'undefined') {
        // Fallback to inverters if eim is missing, disabled, or reporting zero lifetime (e.g. no CT clamps)
        solarpowerWatts = Math.max(0, invProd.wNow);
        if (typeof invProd.whLifetime !== 'undefined') {
          solarpowerKwhLifetime = invProd.whLifetime / 1000.0;
        }
        solarDetail = {
          w: solarpowerWatts,
          kWh: typeof invProd.whLifetime !== 'undefined' ? solarpowerKwhLifetime : null,
          observedAt: observedMs(invProd),
          source: 'inverters',
        };
      }
    } else {
      throw new Error('Envoy response did not contain production array.');
    }

    // Default telemetry values from production.json (or fallback if readings endpoint fails)
    let gridpowerWatts = 0;
    let gridpowerKwhImported = 0;
    let gridpowerKwhExported = 0;
    let hasGridpower = false;

    let homepowerWatts = 0;
    let homepowerKwhImported = 0;
    let homepowerKwhExported = 0;
    let hasHomepower = false;

    // Detail for the energy model: only typed (net-/total-consumption) production.json entries count as evidence.
    let gridDetail = null;
    let homeDetail = null;

    // First, try to locate total-consumption and net-consumption elements in production.json
    let totalConsElement = null;
    let netConsElement = null;

    if (result && Array.isArray(result.consumption)) {
      totalConsElement = result.consumption.find((c) => HOMEPOWER_KEYS.includes(c.measurementType) || HOMEPOWER_KEYS.includes(c.type));
      netConsElement = result.consumption.find((c) => GRIDPOWER_KEYS.includes(c.measurementType) || GRIDPOWER_KEYS.includes(c.type));

      const hasGridpowerProd = !!(netConsElement && typeof netConsElement.wNow !== 'undefined' && typeof netConsElement.whLifetime !== 'undefined' && netConsElement.whLifetime > 0);
      const hasHomepowerProd = !!(totalConsElement && typeof totalConsElement.wNow !== 'undefined' && typeof totalConsElement.whLifetime !== 'undefined' && totalConsElement.whLifetime > 0);

      if (metersConfig && Array.isArray(metersConfig)) {
        const gridMeter = metersConfig.find((m) => m.measurementType === 'net-consumption');
        const homeMeter = metersConfig.find((m) => m.measurementType === 'total-consumption');
        const genericConsMeter = metersConfig.find((m) => m.measurementType === 'consumption');

        if (gridMeter) {
          hasGridpower = gridMeter.state === 'enabled';
        } else if (genericConsMeter) {
          hasGridpower = genericConsMeter.state === 'enabled';
        } else {
          hasGridpower = hasGridpowerProd;
        }

        if (homeMeter) {
          hasHomepower = homeMeter.state === 'enabled';
        } else if (genericConsMeter) {
          hasHomepower = genericConsMeter.state === 'enabled';
        } else {
          hasHomepower = hasHomepowerProd;
        }
      } else {
        hasGridpower = hasGridpowerProd;
        hasHomepower = hasHomepowerProd;
      }

      if (hasGridpower && netConsElement) {
        gridpowerWatts = netConsElement.wNow;
        gridpowerKwhImported = netConsElement.whLifetime / 1000.0;
        if (finite(netConsElement.wNow)) {
          gridDetail = {
            w: netConsElement.wNow,
            importKWh: finite(netConsElement.whLifetime) ? netConsElement.whLifetime / 1000.0 : null,
            exportKWh: null, // production.json has no export counter
            observedAt: observedMs(netConsElement),
          };
        }
      }

      if (hasHomepower && totalConsElement) {
        homepowerWatts = Math.max(0, totalConsElement.wNow);
        homepowerKwhImported = totalConsElement.whLifetime / 1000.0;
        if (finite(totalConsElement.wNow)) {
          homeDetail = {
            w: homepowerWatts,
            importKWh: finite(totalConsElement.whLifetime) ? totalConsElement.whLifetime / 1000.0 : null,
            observedAt: observedMs(totalConsElement),
          };
        }
      }
    }

    // Try to enrich with highly accurate import/export Wh readings from /ivp/meters/readings
    try {
      const enrichConfig = await this.getMetersConfig();
      if (enrichConfig && enrichConfig.length > 0) {
        const readings = await this.getMeterReadings(15000);
        if (Array.isArray(readings)) {
          // Resolve gridpower and homepower eids using the meters config
          const gridMeters = enrichConfig.filter((m) => GRIDPOWER_METER_TYPES.includes(m.measurementType) && m.state === 'enabled');
          const homeMeters = enrichConfig.filter((m) => HOMEPOWER_METER_TYPES.includes(m.measurementType) && m.state === 'enabled');

          // Find readings matching these eids
          const gridReading = readings.find((r) => gridMeters.some((m) => m.eid === r.eid));
          const homeReading = readings.find((r) => homeMeters.some((m) => m.eid === r.eid));

          if (gridReading) {
            // delivered is import, received is export
            if (typeof gridReading.actEnergyDlvd === 'number') {
              gridpowerKwhImported = gridReading.actEnergyDlvd / 1000.0;
            }
            if (typeof gridReading.actEnergyRcvd === 'number') {
              gridpowerKwhExported = gridReading.actEnergyRcvd / 1000.0;
            }
            // activePower is the net power
            if (typeof gridReading.activePower === 'number') {
              gridpowerWatts = gridReading.activePower;
            }
            hasGridpower = true;
          }

          if (homeReading) {
            // delivered is home import (consumed), received is home export (e.g. from battery)
            if (typeof homeReading.actEnergyDlvd === 'number') {
              homepowerKwhImported = homeReading.actEnergyDlvd / 1000.0;
            }
            if (typeof homeReading.actEnergyRcvd === 'number') {
              homepowerKwhExported = homeReading.actEnergyRcvd / 1000.0;
            }
            if (typeof homeReading.activePower === 'number') {
              homepowerWatts = Math.max(0, homeReading.activePower);
            }
            hasHomepower = true;
          }
        }
      }
    } catch (err) {
      this.log(`Failed to enrich with /ivp/meters/readings (falling back to production.json): ${err.message}`);
    }

    this.lastProduction = {
      receivedAt, solar: solarDetail, grid: gridDetail, home: homeDetail,
    };

    return {
      // Solar production metrics (used exclusively for Enphase Solar and Enphase Inverters devices)
      solarpowerWatts,
      solarpowerKwhLifetime,
      wattsNow: solarpowerWatts, // legacy alias for backward compatibility
      kwhLifetime: solarpowerKwhLifetime, // legacy alias for backward compatibility

      connectedInverters,
      readingTime,
      isMetered,

      // Grid power metrics (used exclusively in Enphase Home device)
      gridpowerWatts,
      gridpowerKwhImported,
      gridpowerKwhExported,
      hasGridpower,

      // Home power metrics (used exclusively in Enphase Home device)
      homepowerWatts,
      homepowerKwhImported,
      homepowerKwhExported,
      hasHomepower,
    };
  }

  /**
   * Set PowerForcedOff state on the Envoy.
   * @param {boolean} state - True to force power production off (disable), False for normal (enable)
   * @returns {Promise<string>} Response body
   */
  async setPowerForcedOff(state) {
    const stateValue = state ? 1 : 0;

    this.log(`Sending PUT request to set PowerForcedOff state to ${stateValue}...`);

    const response = await this._request('/ivp/mod/603980032/mode/power', {
      method: 'PUT',
      contentType: 'application/x-www-form-urlencoded',
      body: JSON.stringify({ length: 1, arr: [stateValue] }),
    });

    if (!response.ok) {
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      throw new Error(`PowerForcedOff command failed. Status: ${response.status}`);
    }

    const result = await response.text();
    this.log(`PowerForcedOff state ${stateValue} command sent successfully:`, result);
    return result;
  }

  /**
   * Fetch the current Dynamic Power Export Limit (PEL) settings from the local Envoy.
   * This is an undocumented local API endpoint (/ivp/ss/dpel) that requires installer/maintainer level token authentication.
   * On unmetered systems, this endpoint is not functional and should not be queried.
   *
   * @returns {Promise<Object>} The DPEL settings JSON object containing:
   *   - dynamic_pel_settings: {
   *       enable: boolean (indicates whether dynamic limiting is active),
   *       export_limit: boolean (true = limit net grid export, false = limit absolute solar production),
   *       limit_value_W: number (the limit threshold in Watts),
   *       slew_rate: number (generation adjustment ramp speed in W/s),
   *       enable_dynamic_limiting: boolean (typically false to respect limit_value_W directly)
   *     }
   */
  async getDpelSettings() {
    const response = await this._request('/ivp/ss/dpel');
    const result = await this._json(response, 'DPEL settings fetch failed');
    this.log('DPEL settings retrieved from Envoy:', JSON.stringify(result));
    return result;
  }

  /**
   * Set Dynamic Power Export Limit (PEL) settings on the Envoy gateway.
   * Writes to the local /ivp/ss/dpel API using a JSON-encoded body.
   * This is used when Homey needs to set an absolute production limit (limit_value_W in Custom solar production mode)
   * or a net export limit (Self-use offset in Self-use only mode), or when disabling dynamic limiting.
   *
   * @param {Object} opts
   * @param {boolean} opts.enable - True to activate dynamic limiting, False to restore default static grid profile
   * @param {boolean} opts.export_limit - True to limit net export power, False to limit absolute solar production
   * @param {number} opts.limit_value_W - The target limit threshold in Watts (must be positive or zero)
   * @returns {Promise<string>} The response text from the gateway indicating command confirmation
   */
  /* eslint-disable camelcase */
  async setDpelSettings({
    enable,
    export_limit = true,
    limit_value_W,
    slew_rate = 900.0,
  }) {
    const limitVal = Number(limit_value_W).toFixed(1);
    const slewVal = Number(slew_rate).toFixed(1);

    // Construct the payload matching the Envoy's expected schema.
    // - slew_rate: defines the maximum rate of change (in Watts/second) to ensure grid stability when ramping output.
    // - enable_dynamic_limiting: set to false so the Envoy respects our fixed target limit_value_W directly.
    const payload = {
      dynamic_pel_settings: {
        enable: !!enable,
        export_limit: !!export_limit,
        limit_value_W: '__LIMIT_VALUE_W_PLACEHOLDER__',
        slew_rate: '__SLEW_RATE_PLACEHOLDER__',
        enable_dynamic_limiting: false,
      },
      filename: 'site_settings',
      version: '00.00.01',
    };

    const jsonString = JSON.stringify(payload)
      .replace('"__LIMIT_VALUE_W_PLACEHOLDER__"', limitVal)
      .replace('"__SLEW_RATE_PLACEHOLDER__"', slewVal);

    this.log(
      `Sending POST request to set DPEL settings to: {"enable":${!!enable},`
      + `"export_limit":${!!export_limit},"limit_value_W":${limitVal},`
      + `"slew_rate":${slewVal},"enable_dynamic_limiting":false}...`,
    );

    const response = await this._request('/ivp/ss/dpel', {
      method: 'POST',
      contentType: 'application/json',
      body: jsonString,
    });
    /* eslint-enable camelcase */

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (err) {
        bodyText = `<failed to read body: ${err.message}>`;
      }
      const headers = {};
      response.headers.forEach((val, key) => {
        headers[key] = val;
      });
      const responseDetails = {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: bodyText,
      };
      throw new Error(`DPEL settings command failed. Response: ${JSON.stringify(responseDetails, null, 2)}`);
    }

    const result = await response.text();
    this.log('DPEL settings updated successfully:', result);
    return result;
  }

  /**
   * Fetch individual microinverter telemetry from the Envoy.

   * @returns {Promise<Array<Object>>} Array of microinverters status and power data
   */
  async getInvertersData() {
    const response = await this._request('/api/v1/production/inverters');
    const result = await this._json(response, 'Microinverters data fetch failed');
    this.log(`Microinverters data retrieved from Envoy (${Array.isArray(result) ? result.length : 0} items).`);
    return result;
  }

  /**
   * Read-only hardware detection for pairing (no control writes). Uses this authenticated client.
   * Detection failures are reported as `null`/'unknown' (never as "absent"); only definitive answers prove absence.
   * It throws only when the whole probe failed (neither the meters nor the inventory endpoint could be read).
   * `batteryCapacityWh` assumes `encharge_capacity` is in Wh (unverified on our hardware; null when any unit lacks it).
   * @returns {Promise<{
   *   serial: string|null,
   *   has: { productionMeter: boolean|null, gridMeter: boolean|null, homeMeter: boolean|null, battery: boolean|null },
   *   batteryModels: string[],
   *   batteryCapacityWh: number|null,
   *   sources: { meters: 'fresh'|'unknown'|'absent', inventory: 'fresh'|'unknown'|'absent' }
   * }>}
   */
  async probeGateway() {
    const gateway = await EnvoyApi.getGatewaySerial(this.envoyIp);
    const out = {
      serial: gateway.serial,
      has: {
        productionMeter: null, gridMeter: null, homeMeter: null, battery: null,
      },
      batteryModels: [],
      batteryCapacityWh: null,
      sources: { meters: 'unknown', inventory: 'unknown' },
    };
    let metersError = null;
    let inventoryError = null;

    try {
      const list = await this.refreshMetersConfig();
      const cfg = classifyMeters(list);
      if (cfg.known) {
        out.has.productionMeter = cfg.has.productionMeter;
        out.has.gridMeter = cfg.has.gridMeter;
        out.has.homeMeter = cfg.has.homeMeter;
        out.sources.meters = cfg.readable ? 'fresh' : 'absent';
      } else {
        metersError = new Error('Meters configuration unreadable');
      }
    } catch (err) {
      metersError = err;
    }

    try {
      const inventory = parseInventory(await this.getEnsembleInventory());
      out.sources.inventory = 'fresh';
      out.has.battery = inventory.hasBattery;
      out.batteryModels = [...new Set(inventory.units.map((u) => u.partNum).filter(Boolean))];
      if (inventory.units.length > 0 && inventory.units.every((u) => u.capacity)) {
        out.batteryCapacityWh = inventory.units.reduce((sum, u) => sum + u.capacity, 0);
      }
    } catch (err) {
      if (err.status === 404) {
        out.sources.inventory = 'absent';
        out.has.battery = false;
      } else {
        inventoryError = err;
      }
    }

    if (metersError && inventoryError) throw inventoryError;
    return out;
  }

  /**
   * Check if Envoy has production metering, gridpower, and homepower active.
   * @returns {Promise<{ isMetered: boolean, hasGridpower: boolean, hasHomepower: boolean }>}
   */
  async checkMeterStatus() {
    let isMetered = false;
    let hasGridpower = false;
    let hasHomepower = false;

    // 1. Check via production.json first (always available)
    try {
      const prodData = await this.getProductionData();
      isMetered = !!prodData.isMetered;
      hasGridpower = !!prodData.hasGridpower;
      hasHomepower = !!prodData.hasHomepower;
      this.log(`checkMeterStatus (production.json): isMetered = ${isMetered}, hasGridpower = ${hasGridpower}, hasHomepower = ${hasHomepower}`);
    } catch (err) {
      this.log('Failed to check meter status via production.json:', err.message);
    }

    // 2. Double check and refine via /ivp/meters if possible
    try {
      const meters = await this.getMetersConfig();
      if (Array.isArray(meters)) {
        this.log('Meters configuration retrieved:', JSON.stringify(meters));
        const prodMeter = meters.find((m) => PRODUCTION_METER_TYPES.includes(m.measurementType));
        const gridMeter = meters.find((m) => m.measurementType === 'net-consumption');
        const homeMeter = meters.find((m) => m.measurementType === 'total-consumption');
        const genericConsMeter = meters.find((m) => m.measurementType === 'consumption');

        if (prodMeter) {
          isMetered = prodMeter.state === 'enabled';
        }
        if (gridMeter) {
          hasGridpower = gridMeter.state === 'enabled';
        }
        if (homeMeter) {
          hasHomepower = homeMeter.state === 'enabled';
        }
        if (genericConsMeter) {
          if (genericConsMeter.state === 'enabled') {
            hasGridpower = true;
            hasHomepower = true;
          } else {
            hasGridpower = false;
            hasHomepower = false;
          }
        }
      }
    } catch (err) {
      this.log('Failed to check meter status via /ivp/meters (endpoint may not exist):', err.message);
    }

    this.log(`checkMeterStatus final: isMetered = ${isMetered}, hasGridpower = ${hasGridpower}, hasHomepower = ${hasHomepower}`);
    return { isMetered, hasGridpower, hasHomepower };
  }
}

module.exports = EnvoyApi;
