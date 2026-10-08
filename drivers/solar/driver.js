'use strict';

const net = require('net');
const Homey = require('homey');

const PairingHelper = require('../../lib/PairingHelper');
const EnvoyApi = require('../../lib/EnvoyApi');

class SolarDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Enphase Solar Driver has been initialized');
  }

  /**
   * onPair is called when a user pairs a new Enphase Solar device.
   * Production-control probing is opt-in and runs only after the legacy-solar conflict check (blockLegacySolar).
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    PairingHelper.setupPairingSession(this, session, {
      deviceNameKey: 'driver.solar.name',
      errorPrefix: 'driver.solar',
      allowProductionLimitProbe: true,
      blockLegacySolar: true,
      reuseKey: 'solar',
    });
  }

  /**
   * Same-serial legacy solar check that fails closed: when a legacy driver cannot be enumerated the conflict cannot
   * be ruled out, so the repair stops with a localized (generic) error.
   * @param {string} serial
   * @returns {Promise<boolean>} True when a conflicting legacy device exists
   */
  async hasLegacySolarConflict(serial) {
    try {
      return !!(await PairingHelper.findLegacySolarConflict(this.homey, serial, { throwOnError: true }));
    } catch (err) {
      this.error('Legacy solar conflict check failed, blocking repair:', err.message);
      throw new Error(this.homey.__('driver.solar.error.auth_failed', { message: err.message }));
    }
  }

  /**
   * onRepair is called when a user repairs an Enphase Solar device.
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

    // Serial read from the gateway at the entered IP (validated as 12 digits)
    PairingHelper.registerGetSerialHandler(this, session);

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
        throw new Error(this.homey.__('driver.solar.error.fields_required'));
      }

      if (!/^\d{12}$/.test(envoySerial)) {
        throw new Error(this.homey.__('driver.solar.error.invalid_serial'));
      }

      // IP literals only: runtime connections never use hostnames.
      if (net.isIP(envoyIp) === 0) {
        throw new Error(this.homey.__('driver.solar.error.invalid_ip'));
      }

      // Same conflict rule as pairing, before any login or production-control probe (the new serial may differ).
      if (await this.hasLegacySolarConflict(envoySerial)) {
        throw new Error(this.homey.__('pair.error.legacy_solar_conflict'));
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
        throw new Error(this.homey.__('driver.solar.error.auth_failed', { message: err.message }));
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

      if (await this.hasLegacySolarConflict(envoySerial)) {
        throw new Error(this.homey.__('pair.error.legacy_solar_conflict'));
      }

      this.log(`Saving repaired settings for gateway: ${device.getName()}`);

      // Update global cached settings
      await this.homey.settings.set('user_email', userEmail);
      await this.homey.settings.set('password', password);

      // device.setSettings() does not trigger device.onSettings(), so run the same settings handling explicitly:
      // validation, token store refresh and re-registration under a changed serial.
      // A rejected change must not stay saved while the runtime keeps using the old settings: roll back on failure.
      const previous = device.getSettings();
      await device.setSettings({
        user_email: userEmail,
        password,
        envoy_serial: envoySerial,
        envoy_ip: envoyIp,
      });
      try {
        await device.applySettingsChange(device.getSettings(), ['user_email', 'password', 'envoy_serial', 'envoy_ip']);
      } catch (err) {
        try {
          await device.setSettings(previous);
        } catch (rollbackErr) {
          this.error('Failed to roll back repaired settings:', rollbackErr.message);
        }
        throw err;
      }

      return { success: true };
    });
  }

}

module.exports = SolarDriver;
