'use strict';

const fetch = require('node-fetch');
const EnvoyAuth = require('./EnvoyAuth');

// Share the exact same httpsAgent instance from parent class to pool TCP/TLS sockets
const { httpsAgent } = EnvoyAuth;

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

    let wattsNow = 0;
    let kwhLifetime = 0;
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

      // Use eim only if it is present, has active power, and valid non-zero lifetime reading
      if (isMetered) {
        wattsNow = Math.max(0, eimProd.wNow);
        kwhLifetime = eimProd.whLifetime / 1000.0;
        readingTime = eimProd.readingTime || Math.floor(Date.now() / 1000);
      } else if (invProd && typeof invProd.wNow !== 'undefined') {
        // Fallback to inverters if eim is missing, disabled, or reporting zero lifetime (e.g. no CT clamps)
        wattsNow = Math.max(0, invProd.wNow);
        if (typeof invProd.whLifetime !== 'undefined') {
          kwhLifetime = invProd.whLifetime / 1000.0;
        }
        readingTime = invProd.readingTime || Math.floor(Date.now() / 1000);
      }
    } else {
      throw new Error('Envoy response did not contain production array.');
    }

    return {
      wattsNow, kwhLifetime, connectedInverters, readingTime, isMetered,
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
}

module.exports = EnvoyApi;
