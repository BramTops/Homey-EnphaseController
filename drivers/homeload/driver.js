'use strict';

const Homey = require('homey');

const PairingHelper = require('../../lib/PairingHelper');
const EnvoyApi = require('../../lib/EnvoyApi');

class HomeLoadDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Enphase Home Driver has been initialized');
  }

  /**
   * onPair is called when a user pairs a new Enphase Home device.
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    PairingHelper.setupPairingSession(this, session, {
      deviceNameKey: 'driver.homeload.name',
      deviceIdSuffix: 'homeload',
      errorPrefix: 'driver.homeload',
    });
  }

  /**
   * onRepair is called when a user repairs a Enphase Home device.
   * @param {Homey.PairSession} session - The repair session
   * @param {Homey.Device} device - The device instance being repaired
   */
  async onRepair(session, device) {
    this.log(`Repair session started for: ${device.getName()}`);

    // Register active mDNS discovery listener for real-time frontend updates
    const discoveryStrategy = this.getDiscoveryStrategy();
    let discoveryResultListener = null;

    if (discoveryStrategy) {
      discoveryResultListener = (result) => {
        if (!result) return;
        const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
        if (ip || serial) {
          session.emit('discovery_update', { ip, serial }).catch((err) => {
            this.error('Failed to emit discovery update to repair screen:', err.message);
          });
        }
      };
      discoveryStrategy.on('result', discoveryResultListener);
    }

    session.setHandler('disconnect', async () => {
      this.log('Repair session disconnected.');
      if (discoveryStrategy && discoveryResultListener) {
        discoveryStrategy.removeListener('result', discoveryResultListener);
      }
    });

    // Handler to get current settings for the device
    session.setHandler('get_current_settings', async () => {
      const settings = device.getSettings();
      return {
        user_email: settings.user_email || '',
        password: settings.password || '',
        envoy_serial: settings.envoy_serial || '',
        envoy_ip: settings.envoy_ip || '',
      };
    });

    // Handler to send the auto-discovered parameters to the HTML view
    session.setHandler('get_discovered_ip', async () => {
      this.log('Performing auto-detection for Envoy IP during repair...');
      let discoveredIp = '';
      let discoveredSerial = '';
      let discoveryResults = {};

      try {
        if (discoveryStrategy) {
          discoveryResults = discoveryStrategy.getDiscoveryResults();
        }
      } catch (err) {
        this.error('Failed to retrieve discovery results:', err.message);
      }

      for (const result of Object.values(discoveryResults)) {
        if (result) {
          const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
          if (ip || serial) {
            discoveredIp = ip;
            discoveredSerial = serial;
            break;
          }
        }
      }

      // Fallback: If not found via built-in discovery, run direct mDNS scan
      if (!discoveredIp && !discoveredSerial) {
        const directResult = await PairingHelper.scanMdnsDirect(this.log.bind(this), this.error.bind(this), this.homey);
        if (directResult) {
          discoveredIp = directResult.ip;
          discoveredSerial = directResult.serial;
        }
      }

      return {
        ip: discoveredIp || '',
        serial: discoveredSerial || '',
      };
    });

    // Handler to authenticate and verify credentials
    session.setHandler('login_repair', async (data) => {
      const {
        user_email: userEmail,
        password,
        envoy_serial: envoySerial,
        envoy_ip: envoyIp,
      } = data;

      if (!userEmail || !password || !envoySerial || !envoyIp) {
        throw new Error(this.homey.__('driver.homeload.error.fields_required'));
      }

      if (!/^\d{12}$/.test(envoySerial)) {
        throw new Error(this.homey.__('driver.homeload.error.invalid_serial'));
      }

      this.log(`Repair login attempt for email: ${userEmail}, Serial: ${envoySerial}, IP: ${envoyIp}`);

      const api = new EnvoyApi({
        log: (msg, ...args) => this.log(`[API Repair] ${msg}`, ...args),
        userEmail,
        password,
        envoySerial,
        envoyIp,
      });

      try {
        const token = await api.fetchNewToken();
        this.log('Token fetched successfully during repair.');

        await api.getSessionCookie(token, true);
        this.log('Local connection and Envoy authentication verified successfully.');

        const tokenRoleResult = api.evaluateTokenRole(token);
        const { isMaintainer } = tokenRoleResult;
        this.log(`Token evaluation completed. Is Maintainer: ${isMaintainer}`);

        return {
          success: true,
          isMaintainer,
          token,
        };
      } catch (err) {
        this.error('Authentication test failed during repair:', err.message);
        throw new Error(this.homey.__('driver.homeload.error.auth_failed', { message: err.message }));
      }
    });

    // Handler to save the validated settings back to the device
    session.setHandler('save_repair_settings', async (data) => {
      const {
        user_email: userEmail,
        password,
        envoy_serial: envoySerial,
        envoy_ip: envoyIp,
      } = data;

      this.log(`Saving repaired settings for Enphase Home: ${device.getName()}`);

      // Update global cached settings
      await this.homey.settings.set('user_email', userEmail);
      await this.homey.settings.set('password', password);

      // Set settings on the device, which automatically triggers device.onSettings()
      await device.setSettings({
        user_email: userEmail,
        password,
        envoy_serial: envoySerial,
        envoy_ip: envoyIp,
      });

      return { success: true };
    });
  }

}

module.exports = HomeLoadDriver;
