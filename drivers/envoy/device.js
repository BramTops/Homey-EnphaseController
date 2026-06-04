'use strict';

const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

class EnvoyDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Envoy Device has been initialized');

    // Retrieve settings
    const settings = this.getSettings();

    // Retrieve stored store values and set class properties
    const initialToken = this.getStoreValue('enphase_token');
    this.isMaintainer = !!this.getStoreValue('is_maintainer');
    this.isMetered = !!this.getStoreValue('is_metered');

    this.log(`Initializing device: SN ${settings.envoy_serial}, IP ${settings.envoy_ip}`);
    this.log(`Initial role: ${this.isMaintainer ? 'Maintainer / Installer' : 'System Owner'}`);
    this.log(`Initial metered status: ${this.isMetered ? 'Metered' : 'Standard/Unmetered'}`);

    // Check and add missing capabilities dynamically for older paired devices
    if (!this.hasCapability('measure_power')) {
      this.log('Adding missing capability: measure_power');
      await this.addCapability('measure_power').catch((err) => {
        this.error('Failed to add capability measure_power:', err.message);
      });
    }
    if (!this.hasCapability('meter_power')) {
      this.log('Adding missing capability: meter_power');
      await this.addCapability('meter_power').catch((err) => {
        this.error('Failed to add capability meter_power:', err.message);
      });
    }
    if (this.hasCapability('active_panels')) {
      this.log('Removing old capability: active_panels');
      await this.removeCapability('active_panels').catch((err) => {
        this.error('Failed to remove capability active_panels:', err.message);
      });
    }
    if (this.hasCapability('active_inverters')) {
      this.log('Removing old capability: active_inverters');
      await this.removeCapability('active_inverters').catch((err) => {
        this.error('Failed to remove capability active_inverters:', err.message);
      });
    }
    if (!this.hasCapability('connected_inverters')) {
      this.log('Adding missing capability: connected_inverters');
      await this.addCapability('connected_inverters').catch((err) => {
        this.error('Failed to add capability connected_inverters:', err.message);
      });
    }
    if (!this.hasCapability('last_update')) {
      this.log('Adding missing capability: last_update');
      await this.addCapability('last_update').catch((err) => {
        this.error('Failed to add capability last_update:', err.message);
      });
    }
    if (!this.hasCapability('power_production')) {
      this.log('Adding missing capability: power_production');
      await this.addCapability('power_production').catch((err) => {
        this.error('Failed to add capability power_production:', err.message);
      });
    }
    if (!this.hasCapability('control_state')) {
      this.log('Adding missing capability: control_state');
      await this.addCapability('control_state').catch((err) => {
        this.error('Failed to add capability control_state:', err.message);
      });
    }
    if (!this.hasCapability('metered_gateway')) {
      this.log('Adding missing capability: metered_gateway');
      await this.addCapability('metered_gateway').catch((err) => {
        this.error('Failed to add capability metered_gateway:', err.message);
      });
    }
    if (!this.hasCapability('meter_power_today')) {
      this.log('Adding missing capability: meter_power_today');
      await this.addCapability('meter_power_today').catch((err) => {
        this.error('Failed to add capability meter_power_today:', err.message);
      });
    }

    // Initialize API Client
    this.initApi(settings, initialToken);

    // Dynamically manage the 'onoff' capability based on user role (Maintainer vs. System Owner)
    if (this.isMaintainer) {
      if (!this.hasCapability('onoff')) {
        this.log('Adding missing capability: onoff');
        await this.addCapability('onoff').catch((err) => {
          this.error('Failed to add capability onoff:', err.message);
        });
      }
      this.registerOnoffListener();
    } else if (this.hasCapability('onoff')) {
      this.log('Removing unauthorized capability: onoff');
      await this.removeCapability('onoff').catch((err) => {
        this.error('Failed to remove capability onoff:', err.message);
      });
    }

    // Initialize the failed poll timestamp tracker
    this.firstFailedPollTime = null;

    // Start background status polling (every 120 seconds / 2 minutes)
    this.pollInterval = this.homey.setInterval(() => {
      this.pollStatus().catch(this.error);
    }, 120000);

    // Perform initial status poll asynchronously
    this.pollStatus().catch(this.error);
  }

  /**
   * onUninit is called when the device is removed or the app is stopped.
   */
  async onUninit() {
    this.log('Envoy Device is being uninitialized');
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
    }
  }

  /**
   * Instantiate or update the Envoy API client.
   * @param {Object} settings - Device settings
   * @param {string} [token] - Active JWT token
   */
  initApi(settings, token) {
    this.api = new EnvoyApi({
      log: (msg, ...args) => this.log(`[API] ${msg}`, ...args),
      userEmail: settings.user_email,
      password: settings.password,
      envoySerial: settings.envoy_serial,
      envoyIp: settings.envoy_ip,
      initialToken: token || null,
      onTokenUpdated: async (newToken) => {
        this.log('Token updated by API client. Saving to device store...');
        await this.setStoreValue('enphase_token', newToken);
      },
    });
  }

  /**
   * Register the capability listener for the power switch (onoff).
   * Ensures the listener is registered at most once to prevent duplicate callback registration errors.
   */
  registerOnoffListener() {
    if (this.onoffListenerRegistered) {
      return;
    }

    if (!this.hasCapability('onoff')) {
      return;
    }

    this.log('Registering capability listener for: onoff');
    this.registerCapabilityListener('onoff', async (value) => {
      this.log(`Switch toggled to: ${value ? 'ON (Enable Production)' : 'OFF (Disable Production)'}`);

      // Verify that this account is authorized to perform control actions
      if (!this.isMaintainer) {
        this.error('Permission denied: Account role is not Maintainer / Installer.');
        throw new Error(this.homey.__('driver.envoy.error.no_maintainer'));
      }

      try {
        // value = true -> Enable production -> powerForcedOff = false
        // value = false -> Disable production -> powerForcedOff = true
        const forceOff = !value;
        await this.api.setPowerForcedOff(forceOff);
        this.log(`Successfully sent power production control command: powerForcedOff = ${forceOff}`);
      } catch (err) {
        this.error('Failed to change power production state:', err.message);
        throw new Error(this.homey.__('driver.envoy.error.command_failed', { message: err.message }));
      }
    });

    this.onoffListenerRegistered = true;
  }

  /**
   * Poll the Envoy gateway locally to fetch the current PowerForcedOff status
   * and update the capability state in Homey.
   */
  async pollStatus() {
    this.log('Polling status from local Envoy...');
    try {
      // Fetch power forced off state (only if Installer/Maintainer) and active production metrics
      let powerForcedOff = false;
      if (this.isMaintainer) {
        powerForcedOff = await this.api.getPowerForcedOffstate();
      }
      const prodData = await this.api.getProductionData();

      // onoff is true if production is ENABLED (not forced off)
      let productionEnabled = !powerForcedOff;

      // Retrieve the user's desired state in Homey (if capability exists)
      const currentOnoffValue = this.hasCapability('onoff') ? this.getCapabilityValue('onoff') : null;

      // If Homey is manually set to OFF, but the physical Envoy returned to ON (due to top-of-hour cloud sync reset),
      // we must re-apply the OFF command to respect the user's intent.
      // This override is only relevant and possible for Maintainer/Installer accounts.
      if (this.isMaintainer && currentOnoffValue === false && productionEnabled === true) {
        this.log(
          'Discrepancy detected: Homey is OFF, but Envoy is ON (production enabled). '
          + 'The Envoy likely reset itself during its hourly cloud sync. '
          + "Re-applying the OFF command to enforce the user's setting.",
        );

        try {
          await this.api.setPowerForcedOff(true);
          this.log('Successfully re-applied power production control command: powerForcedOff = true');
          productionEnabled = false; // Override status to remain OFF in Homey UI
        } catch (err) {
          this.error('Failed to re-apply power production control command:', err.message);
        }
      }

      // Retrieve local timezone from Homey Pro clock
      let timezone = 'UTC';
      try {
        if (this.homey && this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
          timezone = await this.homey.clock.getTimezone();
        }
      } catch (err) {
        this.error('Failed to get Homey timezone:', err.message);
      }

      // Format readingTime to HH:mm in local timezone with DST
      let lastUpdateStr = '';
      try {
        const timestampMs = prodData.readingTime ? prodData.readingTime * 1000 : Date.now();
        const date = new Date(timestampMs);
        const formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        lastUpdateStr = formatter.format(date);
      } catch (err) {
        this.error('Failed to format timestamp with timezone:', err.message);
        const date = prodData.readingTime ? new Date(prodData.readingTime * 1000) : new Date();
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        lastUpdateStr = `${hh}:${mm}`;
      }

      // Calculate Energy Today
      let todayDay = this.getStoreValue('today_day');
      let todayStartKwh = this.getStoreValue('today_start_kwh');
      const currentDay = new Date().getDate();

      if (todayDay !== currentDay || typeof todayStartKwh !== 'number') {
        this.log(`New day detected. Resetting today's start energy meter to: ${prodData.kwhLifetime} kWh (previous day: ${todayDay}, current day: ${currentDay})`);
        todayDay = currentDay;
        todayStartKwh = prodData.kwhLifetime;
        await this.setStoreValue('today_day', todayDay).catch(this.error);
        await this.setStoreValue('today_start_kwh', todayStartKwh).catch(this.error);
      }

      let energyToday = prodData.kwhLifetime - todayStartKwh;
      if (energyToday < 0) {
        this.log(`Warning: Energy today calculated as negative (${energyToday} kWh). Resetting start value.`);
        todayStartKwh = prodData.kwhLifetime;
        await this.setStoreValue('today_start_kwh', todayStartKwh).catch(this.error);
        energyToday = 0;
      }

      // Round to 2 decimal places
      energyToday = Math.round(energyToday * 100) / 100;
      this.log(`Energy today calculation: current lifetime = ${prodData.kwhLifetime} kWh, start of day = ${todayStartKwh} kWh, energy today = ${energyToday} kWh`);

      this.log(
        `Poll result: powerForcedOff = ${powerForcedOff}, `
        + `wattsNow = ${prodData.wattsNow} W, `
        + `kwhLifetime = ${prodData.kwhLifetime} kWh, `
        + `connectedInverters = ${prodData.connectedInverters}, `
        + `readingTime = ${prodData.readingTime} (${lastUpdateStr})`,
      );

      // Safely update the Homey interface states
      if (this.hasCapability('onoff')) {
        this.log(`Setting capability 'onoff' to: ${productionEnabled}`);
        await this.setCapabilityValue('onoff', productionEnabled);
      }
      await this.setCapabilityValue('measure_power', prodData.wattsNow);
      await this.setCapabilityValue('meter_power', prodData.kwhLifetime);
      await this.setCapabilityValue('meter_power_today', energyToday);
      await this.setCapabilityValue('connected_inverters', prodData.connectedInverters);
      await this.setCapabilityValue('last_update', lastUpdateStr);

      // Update and save metered status if it changed
      if (this.isMetered !== prodData.isMetered) {
        this.isMetered = prodData.isMetered;
        await this.setStoreValue('is_metered', this.isMetered).catch(this.error);
      }

      // Determine and translate power production and control state status strings
      const powerProductionStr = productionEnabled
        ? this.homey.__('driver.envoy.status.on')
        : this.homey.__('driver.envoy.status.off');

      await this.setCapabilityValue('power_production', powerProductionStr);
      await this.setCapabilityValue('control_state', this.isMaintainer);
      await this.setCapabilityValue('metered_gateway', this.isMetered);

      // Explicitly mark device as available since connection succeeded
      await this.setAvailable();
      this.firstFailedPollTime = null; // Reset failure timer on success
    } catch (err) {
      this.error('Error occurred during status polling:', err.message);

      if (!this.firstFailedPollTime) {
        this.firstFailedPollTime = new Date();
        this.log(`First poll failure recorded at: ${this.firstFailedPollTime.toISOString()}`);
      }

      const elapsedMs = Date.now() - this.firstFailedPollTime.getTime();
      const thirtyMinutesMs = 30 * 60 * 1000;

      if (elapsedMs >= thirtyMinutesMs) {
        const minutesElapsed = Math.round(elapsedMs / 60000);
        this.log(`Downtime has persisted for ${minutesElapsed} minutes. Marking device as unavailable.`);
        await this.setUnavailable(err.message || 'Offline');
      } else {
        const remainingMinutes = Math.round((thirtyMinutesMs - elapsedMs) / 60000);
        this.warn(`Transient polling error: ${err.message}. Keeping device available (grace period remaining: ${remainingMinutes} minutes).`);
      }

      // Clear token only if the cloud credentials themselves are invalid (e.g., login failed).
      // Do not clear the cloud token on local Envoy session 401/403 errors, as those are handled by local retry logic.
      if (err.message.includes('login failed') || err.message.includes('verify email and password')) {
        this.log('Cloud credentials invalid or expired. Wiping token to force re-login.');
        this.api.token = null;
        await this.setStoreValue('enphase_token', null);
      }
    }
  }

  /**
   * Handle settings changes by the user in the Homey settings UI.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Device settings were modified:', JSON.stringify(changedKeys));

    // If credential-relevant keys are changed, re-instantiate the API client
    if (
      changedKeys.includes('user_email')
      || changedKeys.includes('password')
      || changedKeys.includes('envoy_serial')
      || changedKeys.includes('envoy_ip')
    ) {
      this.log('Re-initializing API client with updated settings...');

      // Re-initialize API client (we can clear the token store so it forces a re-auth test)
      await this.setStoreValue('enphase_token', null);

      // Test the new settings by logging in using the newSettings IP directly
      const tempApi = new EnvoyApi({
        log: (msg, ...args) => this.log(`[API Test] ${msg}`, ...args),
        userEmail: newSettings.user_email,
        password: newSettings.password,
        envoySerial: newSettings.envoy_serial,
        envoyIp: newSettings.envoy_ip,
      });

      try {
        const token = await tempApi.fetchNewToken();

        // Verify local connection and authenticate with Envoy using JWT
        this.log('Testing local connection and authentication with Envoy gateway...');
        await tempApi.getSessionCookie(token, true);
        this.log('Local connection and Envoy authentication verified successfully.');

        // Decode the JWT to verify roles using the Envoy API helper method
        const tokenRoleResult = tempApi.evaluateTokenRole(token);
        const { isMaintainer } = tokenRoleResult;
        this.log(`Settings role verification completed. Is Maintainer: ${isMaintainer}`);

        this.isMaintainer = isMaintainer;
        await this.setStoreValue('is_maintainer', isMaintainer);

        this.initApi(newSettings, token);

        // Dynamically add/remove onoff capability based on the updated role
        if (this.isMaintainer) {
          if (!this.hasCapability('onoff')) {
            this.log('Account upgraded to Maintainer: adding onoff capability');
            await this.addCapability('onoff').catch(this.error);
          }
          this.registerOnoffListener();
        } else if (this.hasCapability('onoff')) {
          this.log('Account downgraded to Owner: removing onoff capability');
          await this.removeCapability('onoff').catch(this.error);
          this.onoffListenerRegistered = false;
        }

        this.log('Settings validated successfully. Token and roles updated.');

        // Trigger status poll immediately
        this.pollStatus().catch(this.error);

      } catch (err) {
        this.error('Failed to validate new settings:', err.message);
        throw new Error(this.homey.__('driver.envoy.error.save_settings_failed', { message: err.message }));
      }
    }
  }

}

module.exports = EnvoyDevice;
