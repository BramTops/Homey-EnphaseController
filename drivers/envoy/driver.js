'use strict';

const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

class EnvoyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Envoy Driver has been initialized');

    // Register background discovery listener to handle IP changes automatically
    const discoveryStrategy = this.getDiscoveryStrategy();
    if (discoveryStrategy) {
      this.log('Registering background mDNS discovery listener for IP updates...');
      discoveryStrategy.on('result', (result) => {
        this.handleDiscoveryResult(result).catch((err) => {
          this.error('Error handling background discovery result:', err.message);
        });
      });
    }
  }

  /**
   * onPair is called when a user pairs a new Envoy device.
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    this.log('Pairing session started...');

    let pairedDeviceData = null;

    // Register active mDNS discovery listener for real-time frontend auto-detection updates
    const discoveryStrategy = this.getDiscoveryStrategy();
    let discoveryResultListener = null;

    if (discoveryStrategy) {
      this.log('Pair session: registering result listener to feed pairing screen...');

      discoveryResultListener = (result) => {
        if (!result) return;
        this.log('Pair session: received live discovery advertisement:', JSON.stringify(result));

        // 1. Extract 12-digit serial number from discovery metadata (prefer result.id)
        let discoveredSerial = result.id || '';
        if (!/^\d{12}$/.test(discoveredSerial)) {
          const searchPool = [result.name, result.host, result.fullname].join(' ');
          const serialMatch = searchPool.match(/\b\d{12}\b/);
          if (serialMatch) {
            discoveredSerial = serialMatch[0];
          }
        }

        // 2. Extract discovered IP address (prefer IPv4)
        let discoveredIp = '';
        if (Array.isArray(result.addresses)) {
          const ipv4 = result.addresses.find((addr) => addr && !addr.includes(':') && addr.includes('.'));
          if (ipv4) {
            discoveredIp = ipv4;
          }
        }
        if (!discoveredIp && result.address && !result.address.includes(':')) {
          discoveredIp = result.address;
        }
        // Fallback to routeable IPv6 if no IPv4 is available
        if (!discoveredIp && Array.isArray(result.addresses)) {
          const routeableIpv6 = result.addresses.find((addr) => addr && addr.includes(':') && !addr.toLowerCase().startsWith('fe80'));
          if (routeableIpv6) {
            discoveredIp = routeableIpv6;
          }
        }

        if (discoveredIp || discoveredSerial) {
          this.log(`Pair session discovery update: IP="${discoveredIp}", Serial="${discoveredSerial}"`);
          session.emit('discovery_update', {
            ip: discoveredIp || '',
            serial: discoveredSerial || '',
          }).catch((err) => {
            this.error('Failed to emit discovery update to pairing screen:', err.message);
          });
        }
      };

      discoveryStrategy.on('result', discoveryResultListener);
    }

    // Clean up dynamic discovery listener when pairing session closes
    session.setHandler('disconnect', async () => {
      this.log('Pairing session disconnected.');
      if (discoveryStrategy && discoveryResultListener) {
        discoveryStrategy.removeListener('result', discoveryResultListener);
        this.log('Removed dynamic pairing discovery result listener.');
      }
    });

    // Handler to send the auto-discovered parameters to the HTML view
    session.setHandler('get_discovered_ip', async () => {
      this.log('Performing auto-detection for Envoy IP using discovery strategy...');

      let discoveredIp = '';
      let discoveredSerial = '';
      let discoveryResults = {};

      try {
        const discoveryStrategy = this.getDiscoveryStrategy();
        if (discoveryStrategy) {
          discoveryResults = discoveryStrategy.getDiscoveryResults();
        } else {
          this.log('Discovery strategy is not available (returned null).');
        }
      } catch (err) {
        this.error('Failed to retrieve discovery strategy or results:', err.message);
      }

      for (const result of Object.values(discoveryResults)) {
        if (result) {
          this.log('Discovered mDNS entry:', JSON.stringify(result));

          // Try to get serial number from result.id first, otherwise extract from names/hosts
          if (result.id && /^\d{12}$/.test(result.id)) {
            discoveredSerial = result.id;
            this.log(`Obtained serial number from result.id: ${discoveredSerial}`);
          } else {
            const searchPool = [result.name, result.host, result.fullname].join(' ');
            const serialMatch = searchPool.match(/\b\d{12}\b/);
            if (serialMatch) {
              discoveredSerial = serialMatch[0];
              this.log(`Extracted serial number from mDNS metadata: ${discoveredSerial}`);
            }
          }

          // Prioritize IPv4 from the addresses list
          if (Array.isArray(result.addresses)) {
            const ipv4 = result.addresses.find((addr) => addr && !addr.includes(':') && addr.includes('.'));
            if (ipv4) {
              discoveredIp = ipv4;
              this.log(`Selected IPv4 address from addresses array: ${discoveredIp}`);
              break;
            }
          }

          // If result.address is a clean IPv4, use it
          if (result.address && !result.address.includes(':')) {
            discoveredIp = result.address;
            this.log(`Selected IPv4 address from address field: ${discoveredIp}`);
            break;
          }

          // Check for routeable IPv6 address from the addresses list (ignore link-local fe80::)
          if (Array.isArray(result.addresses)) {
            const routeableIpv6 = result.addresses.find((addr) => addr && addr.includes(':') && !addr.toLowerCase().startsWith('fe80'));
            if (routeableIpv6) {
              discoveredIp = routeableIpv6;
              this.log(`Selected routeable IPv6 address from addresses array: ${discoveredIp}`);
              break;
            }
          }

          // If result.address is a routeable IPv6, use it
          if (result.address && result.address.includes(':') && !result.address.toLowerCase().startsWith('fe80')) {
            discoveredIp = result.address;
            this.log(`Selected routeable IPv6 address from address field: ${discoveredIp}`);
            break;
          }
        }
      }

      return {
        ip: discoveredIp || '',
        serial: discoveredSerial || '',
      };
    });

    // Handler to authenticate and verify roles
    session.setHandler('login', async (data) => {
      const {
        user_email: userEmail,
        password,
        envoy_serial: envoySerial,
        envoy_ip: envoyIp,
      } = data;

      if (!userEmail || !password || !envoySerial || !envoyIp) {
        throw new Error(this.homey.__('driver.envoy.error.fields_required'));
      }

      if (!/^\d{12}$/.test(envoySerial)) {
        throw new Error(this.homey.__('driver.envoy.error.invalid_serial'));
      }

      this.log(`Attempting login for email: ${userEmail}, Serial: ${envoySerial}, IP: ${envoyIp}`);

      // Create a temporary API client to test credentials with the provided IP
      const api = new EnvoyApi({
        log: (msg, ...args) => this.log(`[API Temp] ${msg}`, ...args),
        userEmail,
        password,
        envoySerial,
        envoyIp,
      });

      try {
        // Fetch a new token to verify credentials and get the JWT
        const token = await api.fetchNewToken();
        this.log('Token fetched successfully during pairing.');

        // Verify local connection and authenticate with Envoy using JWT
        this.log('Testing local connection and authentication with Envoy gateway...');
        await api.getSessionCookie(token, true);
        this.log('Local connection and Envoy authentication verified successfully.');

        // Decode the JWT to verify roles using the Envoy API helper method
        const tokenRoleResult = api.evaluateTokenRole(token);
        const { isMaintainer } = tokenRoleResult;
        this.log(`Token evaluation completed. Is Maintainer: ${isMaintainer}`);

        // Keep device data in memory for the list_devices step
        pairedDeviceData = {
          name: this.homey.__('driver.envoy.name'),
          data: {
            id: envoySerial,
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
          },
        };

        // Return role status back to frontend to display specific message
        return {
          success: true,
          isMaintainer,
        };

      } catch (err) {
        this.error('Authentication test failed during pairing:', err.message);
        throw new Error(this.homey.__('driver.envoy.error.auth_failed', { message: err.message }));
      }
    });

    // Handler to return list of devices to pair
    session.setHandler('list_devices', async () => {
      if (!pairedDeviceData) {
        throw new Error('No device was successfully authenticated yet.');
      }
      this.log('Adding device to Homey:', pairedDeviceData.name);
      return [pairedDeviceData];
    });
  }

  /**
   * Process background discovery advertisements to auto-heal changed IPs.
   * Matches discovered devices by serial number and updates the IP setting if it has changed.
   * @param {Object} result - The discovery result
   */
  async handleDiscoveryResult(result) {
    if (!result) return;

    // 1. Extract 12-digit serial number from discovery metadata (prefer result.id)
    let discoveredSerial = result.id || '';
    if (!/^\d{12}$/.test(discoveredSerial)) {
      const searchPool = [result.name, result.host, result.fullname].join(' ');
      const serialMatch = searchPool.match(/\b\d{12}\b/);
      if (serialMatch) {
        discoveredSerial = serialMatch[0];
      } else {
        return; // Can't reliably match without a serial number
      }
    }

    // 2. Extract discovered IP address (prefer IPv4)
    let discoveredIp = '';
    if (Array.isArray(result.addresses)) {
      const ipv4 = result.addresses.find((addr) => addr && !addr.includes(':') && addr.includes('.'));
      if (ipv4) {
        discoveredIp = ipv4;
      }
    }
    if (!discoveredIp && result.address && !result.address.includes(':')) {
      discoveredIp = result.address;
    }
    // Fallback to routeable IPv6 if no IPv4 is available
    if (!discoveredIp && Array.isArray(result.addresses)) {
      const routeableIpv6 = result.addresses.find((addr) => addr && addr.includes(':') && !addr.toLowerCase().startsWith('fe80'));
      if (routeableIpv6) {
        discoveredIp = routeableIpv6;
      }
    }

    if (!discoveredIp) return;

    // 3. Find paired device in Homey and update its IP setting if it has changed
    const devices = this.getDevices();
    for (const device of devices) {
      const settings = device.getSettings();
      if (settings.envoy_serial === discoveredSerial) {
        if (settings.envoy_ip !== discoveredIp) {
          this.log(`[Auto-IP] Envoy with SN ${discoveredSerial} moved from ${settings.envoy_ip} to ${discoveredIp}. Auto-updating device settings...`);

          // This will automatically trigger device.onSettings(), which re-initializes client and polls immediately
          await device.setSettings({ envoy_ip: discoveredIp });
        }
        break;
      }
    }
  }

}

module.exports = EnvoyDriver;
