'use strict';

const fetch = require('node-fetch');
const EnvoyAuth = require('./EnvoyAuth');

// Share the exact same httpsAgent instance from parent class to pool TCP/TLS sockets
const { httpsAgent } = EnvoyAuth;

// Meter type strings returned by Enphase /ivp/meters endpoint
const PRODUCTION_METER_TYPES = ['production'];
const GRIDPOWER_METER_TYPES = ['net-consumption', 'consumption'];
const HOMEPOWER_METER_TYPES = ['total-consumption', 'consumption'];

// Key/Property names inside production.json (checked against both .measurementType and .type)
const GRIDPOWER_KEYS = ['net-consumption'];
const HOMEPOWER_KEYS = ['total-consumption'];

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
    this.onIpUpdated = opts.onIpUpdated || (() => {});
    this.cachedMeters = null;

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
    // Fallback to routeable IPv6 if no IPv4 is available
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
   * Fetch PowerForcedOff state from the Envoy.
   * @returns {Promise<boolean>} True if power forced off is true (disabled production)
   */
  async getPowerForcedOffstate() {
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/ivp/mod/603980032/mode/power`;

    this.log('Fetching power mode data from local Envoy...');
    let response = await fetch(dataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
      },
      agent: httpsAgent,
      timeout: 15000,
    });

    // Handle transient local session eviction by force-refreshing cookie and retrying once
    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: cookie,
        },
        agent: httpsAgent,
        timeout: 15000,
      });
    }

    if (!response.ok) {
      throw new Error(`Power mode data fetch failed. Status: ${response.status}`);
    }

    const result = await response.json();
    this.log('Power mode data retrieved from Envoy:', JSON.stringify(result));

    // Safely return powerForcedOff field
    if (result && typeof result.powerForcedOff !== 'undefined') {
      return result.powerForcedOff;
    }
    throw new Error('Envoy response did not contain powerForcedOff state.');
  }

  /**
   * Fetch meters configuration to build cached config.
   * @returns {Promise<Array<Object>>}
   */
  async getMetersConfig() {
    if (this.cachedMeters) return this.cachedMeters;

    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/ivp/meters`;

    this.log('Fetching meters configuration to build cached config...');
    let response = await fetch(dataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
      },
      agent: httpsAgent,
      timeout: 10000,
    });

    if (response.status === 401) {
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: cookie,
        },
        agent: httpsAgent,
        timeout: 10000,
      });
    }

    if (response.ok) {
      const meters = await response.json();
      if (Array.isArray(meters)) {
        this.cachedMeters = meters;
      }
    } else {
      this.log(`Failed to fetch meters config. Status: ${response.status}`);
    }
    return this.cachedMeters;
  }

  /**
   * Fetch detailed meter readings from local Envoy.
   * @returns {Promise<Array<Object>>}
   */
  async getMeterReadings() {
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/ivp/meters/readings`;

    this.log('Fetching detailed meter readings from local Envoy...');
    let response = await fetch(dataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
      },
      agent: httpsAgent,
      timeout: 15000,
    });

    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: cookie,
        },
        agent: httpsAgent,
        timeout: 15000,
      });
    }

    if (!response.ok) {
      throw new Error(`Meter readings fetch failed. Status: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Fetch production data from the Envoy.
   * @returns {Promise<Object>} Production data object containing wattsNow and kwhLifetime
   */
  async getProductionData() {
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/production.json`;

    this.log('Fetching production data from local Envoy...');
    let response = await fetch(dataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
      },
      agent: httpsAgent,
      timeout: 30000, // 30s timeout to absorb slow Envoy compile times
    });

    // Handle transient local session eviction by force-refreshing cookie and retrying once
    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: cookie,
        },
        agent: httpsAgent,
        timeout: 30000,
      });
    }

    if (!response.ok) {
      throw new Error(`Production data fetch failed. Status: ${response.status}`);
    }

    const result = await response.json();
    this.log('Production data retrieved from Envoy:', JSON.stringify(result));

    let solarpowerWatts = 0;
    let solarpowerKwhLifetime = 0;
    let connectedInverters = 0;
    let readingTime = 0;
    let isMetered = false;

    if (result && Array.isArray(result.production)) {
      const eimProd = result.production.find((p) => p.type === 'eim');
      const invProd = result.production.find((p) => p.type === 'inverters');

      if (invProd && typeof invProd.activeCount !== 'undefined') {
        connectedInverters = invProd.activeCount;
      }

      isMetered = !!(eimProd && typeof eimProd.wNow !== 'undefined' && eimProd.whLifetime > 0);
      readingTime = (eimProd && eimProd.readingTime) || (invProd && invProd.readingTime) || Math.floor(Date.now() / 1000);

      // Use eim only if it is present, has active power, and valid non-zero lifetime reading
      if (isMetered) {
        solarpowerWatts = Math.max(0, eimProd.wNow);
        solarpowerKwhLifetime = eimProd.whLifetime / 1000.0;
      } else if (invProd && typeof invProd.wNow !== 'undefined') {
        // Fallback to inverters if eim is missing, disabled, or reporting zero lifetime (e.g. no CT clamps)
        solarpowerWatts = Math.max(0, invProd.wNow);
        if (typeof invProd.whLifetime !== 'undefined') {
          solarpowerKwhLifetime = invProd.whLifetime / 1000.0;
        }
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

    // First, try to locate total-consumption and net-consumption elements in production.json
    let totalConsElement = null;
    let netConsElement = null;

    if (result && Array.isArray(result.consumption)) {
      totalConsElement = result.consumption.find((c) => HOMEPOWER_KEYS.includes(c.measurementType) || HOMEPOWER_KEYS.includes(c.type));
      netConsElement = result.consumption.find((c) => GRIDPOWER_KEYS.includes(c.measurementType) || GRIDPOWER_KEYS.includes(c.type));

      if (netConsElement && typeof netConsElement.wNow !== 'undefined' && typeof netConsElement.whLifetime !== 'undefined' && netConsElement.whLifetime > 0) {
        gridpowerWatts = netConsElement.wNow;
        gridpowerKwhImported = netConsElement.whLifetime / 1000.0;
        hasGridpower = true;
      }

      if (totalConsElement && typeof totalConsElement.wNow !== 'undefined' && typeof totalConsElement.whLifetime !== 'undefined' && totalConsElement.whLifetime > 0) {
        homepowerWatts = Math.max(0, totalConsElement.wNow);
        homepowerKwhImported = totalConsElement.whLifetime / 1000.0;
        hasHomepower = true;
      }
    }

    // Try to enrich with highly accurate import/export Wh readings from /ivp/meters/readings
    try {
      const metersConfig = await this.getMetersConfig();
      if (metersConfig && metersConfig.length > 0) {
        const readings = await this.getMeterReadings();
        if (Array.isArray(readings)) {
          // Resolve gridpower and homepower eids using metersConfig
          const gridMeters = metersConfig.filter((m) => GRIDPOWER_METER_TYPES.includes(m.measurementType) && m.state === 'enabled');
          const homeMeters = metersConfig.filter((m) => HOMEPOWER_METER_TYPES.includes(m.measurementType) && m.state === 'enabled');

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
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/ivp/mod/603980032/mode/power`;
    const stateValue = state ? 1 : 0;

    this.log(`Sending PUT request to set PowerForcedOff state to ${stateValue}...`);

    let response = await fetch(dataUrl, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: JSON.stringify({ length: 1, arr: [stateValue] }),
      agent: httpsAgent,
      timeout: 15000,
    });

    // Handle transient local session eviction by force-refreshing cookie and retrying once
    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: JSON.stringify({ length: 1, arr: [stateValue] }),
        agent: httpsAgent,
        timeout: 15000,
      });
    }

    if (!response.ok) {
      throw new Error(`PowerForcedOff command failed. Status: ${response.status}`);
    }

    const result = await response.text();
    this.log(`PowerForcedOff state ${stateValue} command sent successfully:`, result);
    return result;
  }

  /**
   * Fetch individual microinverter telemetry from the Envoy.
   * @returns {Promise<Array<Object>>} Array of microinverters status and power data
   */
  async getInvertersData() {
    const token = await this.getToken();
    let cookie = await this.getSessionCookie(token);
    const host = this.getFormattedHost();
    const dataUrl = `https://${host}/api/v1/production/inverters`;

    this.log('Fetching microinverters data from local Envoy...');
    let response = await fetch(dataUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Cookie: cookie,
      },
      agent: httpsAgent,
      timeout: 15000,
    });

    // Handle transient local session eviction by force-refreshing cookie and retrying once
    if (response.status === 401) {
      this.log('Local Envoy returned 401. Retrying with a fresh session cookie...');
      try {
        await response.text();
      } catch (err) {
        // ignore
      }
      cookie = await this.getSessionCookie(token, true);
      response = await fetch(dataUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Cookie: cookie,
        },
        agent: httpsAgent,
        timeout: 15000,
      });
    }

    if (!response.ok) {
      throw new Error(`Microinverters data fetch failed. Status: ${response.status}`);
    }

    const result = await response.json();
    this.log(`Microinverters data retrieved from Envoy (${Array.isArray(result) ? result.length : 0} items):`, JSON.stringify(result));
    return result;
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

        if (prodMeter && prodMeter.state === 'enabled') {
          isMetered = true;
        }
        if (gridMeter && gridMeter.state === 'enabled') {
          hasGridpower = true;
        }
        if (homeMeter && homeMeter.state === 'enabled') {
          hasHomepower = true;
        }
        if (genericConsMeter && genericConsMeter.state === 'enabled') {
          // 'consumption' is a fallback for either gridpower or homepower (on older firmware).
          // Since it physically exists, we can treat both gridpower and homepower as available.
          hasGridpower = true;
          hasHomepower = true;
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
