'use strict';

const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

// Sub-capability ids used for per-phase telemetry on 3-phase gateways
const PHASE_IDS = ['l1', 'l2', 'l3'];

class HomeLoadDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Enphase Home Device has been initialized');

    // Retrieve settings
    const settings = this.getSettings();

    // Retrieve stored store values
    const initialToken = this.getStoreValue('enphase_token');
    this.isMetered = !!this.getStoreValue('is_metered');
    this.hasGridpower = !!this.getStoreValue('has_gridpower');
    this.hasHomepower = !!this.getStoreValue('has_homepower');

    // 1. Ensure static gridpower capabilities are present
    const staticCapabilities = [
      'measure_power',
      'meter_power',
      'meter_power_today',
      'meter_power.produced',
      'meter_power_today.produced',
      'last_update',
    ];

    for (const cap of staticCapabilities) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing static capability: ${cap}`);
        await this.addCapability(cap).catch((err) => {
          this.error(`Failed to add static capability ${cap}:`, err.message);
        });
      }
    }

    // 2. Manage dynamic homepower capabilities
    const homeCapabilities = [
      'measure_power.home',
      'meter_power.home',
      'meter_power_today.home',
      'meter_power.home_produced',
      'meter_power_today.home_produced',
    ];

    if (this.hasHomepower) {
      for (const cap of homeCapabilities) {
        if (!this.hasCapability(cap)) {
          this.log(`Adding missing dynamic homepower capability: ${cap}`);
          await this.addCapability(cap).catch((err) => {
            this.error(`Failed to add homepower capability ${cap}:`, err.message);
          });
        }
      }
    } else {
      for (const cap of homeCapabilities) {
        if (this.hasCapability(cap)) {
          this.log(`Removing dynamic homepower capability (not active on gateway): ${cap}`);
          await this.removeCapability(cap).catch((err) => {
            this.error(`Failed to remove homepower capability ${cap}:`, err.message);
          });
        }
      }
    }

    // 3. Clean up legacy backward compatibility capabilities if present (.consumed namespace)
    const legacyCapabilities = [
      'measure_power.consumed',
      'meter_power.consumed',
      'meter_power_today.consumed',
    ];

    for (const cap of legacyCapabilities) {
      if (this.hasCapability(cap)) {
        this.log(`Removing legacy capability: ${cap}`);
        await this.removeCapability(cap).catch((err) => {
          this.error(`Failed to remove legacy capability ${cap}:`, err.message);
        });
      }
    }

    // Initialize API Client
    this.initApi(settings, initialToken);

    // Register with App-level polling manager
    this.homey.app.registerDevice(settings.envoy_serial, this);
  }

  /**
   * onUninit is called when the device is removed or the app is stopped.
   */
  async onUninit() {
    this.log('Enphase Home Device is being uninitialized');
    const settings = this.getSettings();
    this.homey.app.unregisterDevice(settings.envoy_serial, this);
  }

  initApi(settings, token) {
    this.api = this.homey.app.getApiInstance({
      serial: settings.envoy_serial,
      ip: settings.envoy_ip,
      userEmail: settings.user_email,
      password: settings.password,
      initialToken: token || null,
    });
  }

  async updateTelemetry(prodData) {
    this.log('Updating consumption telemetry with data received from central poll...');

    // Format readingTime to HH:mm in local timezone with DST
    const lastUpdateStr = await this.homey.app.formatTimeLocal(prodData.readingTime || Math.round(Date.now() / 1000));

    // Calculate daily energy consumption for grid (imported and exported)
    const currentDay = new Date().getDate();
    const gridpowerEnergyTodayImported = await this.calculateDailyEnergy(prodData.gridpowerKwhImported, currentDay, '_gridpower_import');
    const gridpowerEnergyTodayExported = await this.calculateDailyEnergy(prodData.gridpowerKwhExported, currentDay, '_gridpower_export');

    // Update primary capabilities (Grid Consumption)
    this.log(
      'Grid telemetry updated: '
      + `gridpowerWatts = ${prodData.gridpowerWatts} W, `
      + `gridpowerKwhImported = ${prodData.gridpowerKwhImported} kWh, `
      + `gridpowerEnergyTodayImported = ${gridpowerEnergyTodayImported} kWh, `
      + `gridpowerKwhExported = ${prodData.gridpowerKwhExported} kWh, `
      + `gridpowerEnergyTodayExported = ${gridpowerEnergyTodayExported} kWh, `
      + `readingTime = ${prodData.readingTime} (${lastUpdateStr})`,
    );

    await this.setCapabilityValue('measure_power', prodData.gridpowerWatts);
    await this.setCapabilityValue('meter_power', prodData.gridpowerKwhImported);
    await this.setCapabilityValue('meter_power_today', gridpowerEnergyTodayImported);
    await this.setCapabilityValue('last_update', lastUpdateStr);

    // Per-phase grid, home load and voltage (ADR 0011)
    await this.ensurePhaseCapabilities(prodData);
    await this.updatePhaseValues(prodData);

    if (this.hasCapability('meter_power.produced')) {
      await this.setCapabilityValue('meter_power.produced', prodData.gridpowerKwhExported);
    }
    if (this.hasCapability('meter_power_today.produced')) {
      await this.setCapabilityValue('meter_power_today.produced', gridpowerEnergyTodayExported);
    }

    // Handle dynamic updates to homepower availability state at runtime
    if (this.hasHomepower !== prodData.hasHomepower) {
      this.hasHomepower = prodData.hasHomepower;
      await this.setStoreValue('has_homepower', this.hasHomepower).catch(this.error);

      const homeCapabilities = [
        'measure_power.home',
        'meter_power.home',
        'meter_power_today.home',
        'meter_power.home_produced',
        'meter_power_today.home_produced',
      ];
      if (this.hasHomepower) {
        for (const cap of homeCapabilities) {
          if (!this.hasCapability(cap)) {
            this.log(`Adding homepower capability at runtime: ${cap}`);
            await this.addCapability(cap).catch(this.error);
          }
        }
      } else {
        for (const cap of homeCapabilities) {
          if (this.hasCapability(cap)) {
            this.log(`Removing homepower capability at runtime: ${cap}`);
            await this.removeCapability(cap).catch(this.error);
          }
        }
      }
    }

    // If home consumption is available, calculate and update it too
    if (this.hasHomepower) {
      const homepowerEnergyTodayImported = await this.calculateDailyEnergy(prodData.homepowerKwhImported, currentDay, '_homepower_import');
      const homepowerEnergyTodayExported = await this.calculateDailyEnergy(prodData.homepowerKwhExported, currentDay, '_homepower_export');

      this.log(
        'Home consumption telemetry updated: '
        + `homepowerWatts = ${prodData.homepowerWatts} W, `
        + `homepowerKwhImported = ${prodData.homepowerKwhImported} kWh, `
        + `homepowerEnergyTodayImported = ${homepowerEnergyTodayImported} kWh, `
        + `homepowerKwhExported = ${prodData.homepowerKwhExported} kWh, `
        + `homepowerEnergyTodayExported = ${homepowerEnergyTodayExported} kWh`,
      );

      const oldPower = this.getCapabilityValue('measure_power.home');
      const oldEnergy = this.getCapabilityValue('meter_power.home');
      const oldEnergyToday = this.getCapabilityValue('meter_power_today.home');

      if (this.hasCapability('measure_power.home')) {
        await this.setCapabilityValue('measure_power.home', prodData.homepowerWatts);
      }
      if (this.hasCapability('meter_power.home')) {
        await this.setCapabilityValue('meter_power.home', prodData.homepowerKwhImported);
      }
      if (this.hasCapability('meter_power_today.home')) {
        await this.setCapabilityValue('meter_power_today.home', homepowerEnergyTodayImported);
      }
      if (this.hasCapability('meter_power.home_produced')) {
        await this.setCapabilityValue('meter_power.home_produced', prodData.homepowerKwhExported);
      }
      if (this.hasCapability('meter_power_today.home_produced')) {
        await this.setCapabilityValue('meter_power_today.home_produced', homepowerEnergyTodayExported);
      }

      if (oldPower !== prodData.homepowerWatts) {
        const trigger = this.homey.flow.getDeviceTriggerCard('home_power_changed');
        if (trigger) {
          trigger.trigger(this, { value: prodData.homepowerWatts }, {}).catch(this.error);
        }
      }

      if (oldEnergy !== prodData.homepowerKwhImported) {
        const trigger = this.homey.flow.getDeviceTriggerCard('home_energy_changed');
        if (trigger) {
          trigger.trigger(this, { value: prodData.homepowerKwhImported }, {}).catch(this.error);
        }
      }

      if (oldEnergyToday !== homepowerEnergyTodayImported) {
        const trigger = this.homey.flow.getDeviceTriggerCard('home_energy_today_changed');
        if (trigger) {
          trigger.trigger(this, { value: homepowerEnergyTodayImported }, {}).catch(this.error);
        }
      }
    }

    // Update stores if metered status or gridpower state changes
    if (this.isMetered !== prodData.isMetered) {
      this.isMetered = prodData.isMetered;
      await this.setStoreValue('is_metered', this.isMetered).catch(this.error);
    }
    if (this.hasGridpower !== prodData.hasGridpower) {
      this.hasGridpower = prodData.hasGridpower;
      await this.setStoreValue('has_gridpower', this.hasGridpower).catch(this.error);
    }
  }

  async calculateDailyEnergy(kwhLifetime, currentDay, storeKeySuffix = '') {
    const dayKey = `today_day${storeKeySuffix}`;
    const startKey = `today_start_kwh${storeKeySuffix}`;

    let todayDay = this.getStoreValue(dayKey);
    let todayStartKwh = this.getStoreValue(startKey);

    if (todayDay !== currentDay || typeof todayStartKwh !== 'number') {
      this.log(`New day detected. Resetting today's start energy meter for ${storeKeySuffix || 'primary'} to: ${kwhLifetime} kWh (previous day: ${todayDay}, current day: ${currentDay})`);
      todayDay = currentDay;
      todayStartKwh = kwhLifetime;
      await this.setStoreValue(dayKey, todayDay).catch(this.error);
      await this.setStoreValue(startKey, todayStartKwh).catch(this.error);
    }

    let energyToday = kwhLifetime - todayStartKwh;
    if (energyToday < 0) {
      this.log(`Warning: Energy today for ${storeKeySuffix || 'primary'} calculated as negative (${energyToday} kWh). Resetting start value.`);
      todayStartKwh = kwhLifetime;
      await this.setStoreValue(startKey, todayStartKwh).catch(this.error);
      energyToday = 0;
    }

    energyToday = Math.round(energyToday * 100) / 100;
    this.log(`Energy today calculation for ${storeKeySuffix || 'primary'}: current lifetime = ${kwhLifetime} kWh, start of day = ${todayStartKwh} kWh, energy today = ${energyToday} kWh`);
    return energyToday;
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

        await this.setStoreValue('enphase_token', token);

        this.initApi(newSettings, token);

        this.log('Settings validated successfully. Token updated.');

        // Trigger status poll immediately via app central coordinator
        this.homey.app.triggerImmediatePoll(newSettings.envoy_serial);

      } catch (err) {
        this.error('Failed to validate new settings:', err.message);
        throw new Error(this.homey.__('driver.homeload.error.save_settings_failed', { message: err.message }));
      }
    }
  }

  /**
   * Add or remove per-phase capabilities for grid, home load and voltage.
   * Values come from the /ivp/meters/readings channels already fetched by the regular
   * poll, so no additional gateway request is made (ADR 0011). Opt-in via device setting
   * because most systems are single-phase.
   * @param {Object} prodData - Live readings
   */
  async ensurePhaseCapabilities(prodData) {
    const optedIn = !!this.getSetting('phase_capabilities');
    const gridPhases = Array.isArray(prodData.gridpowerPhases) ? prodData.gridpowerPhases : null;
    const homePhases = Array.isArray(prodData.homepowerPhases) ? prodData.homepowerPhases : null;

    const wantedGrid = (optedIn && gridPhases && gridPhases.length > 1) ? Math.min(gridPhases.length, PHASE_IDS.length) : 0;
    const wantedHome = (optedIn && homePhases && homePhases.length > 1) ? Math.min(homePhases.length, PHASE_IDS.length) : 0;

    for (let idx = 0; idx < PHASE_IDS.length; idx++) {
      const phaseId = PHASE_IDS[idx];
      const label = phaseId.toUpperCase();

      await this.togglePhaseCapability(`measure_power.${phaseId}`, idx < wantedGrid, {
        en: `Grid power ${label}`,
        nl: `Netvermogen ${label}`,
      });
      await this.togglePhaseCapability(`measure_voltage.${phaseId}`, idx < wantedGrid, {
        en: `Grid voltage ${label}`,
        nl: `Netspanning ${label}`,
      });
      await this.togglePhaseCapability(`measure_power.home_${phaseId}`, idx < wantedHome, {
        en: `Home power ${label}`,
        nl: `Huisvermogen ${label}`,
      });
    }
  }

  /**
   * Add a capability with a localized title, or remove it when no longer wanted.
   * @param {string} capabilityId
   * @param {boolean} shouldExist
   * @param {Object} title - Localized title object
   */
  async togglePhaseCapability(capabilityId, shouldExist, title) {
    if (shouldExist) {
      if (!this.hasCapability(capabilityId)) {
        this.log(`Adding per-phase capability: ${capabilityId}`);
        await this.addCapability(capabilityId).catch((err) => {
          this.error(`Failed to add capability ${capabilityId}:`, err.message);
        });
        await this.setCapabilityOptions(capabilityId, { title }).catch((err) => {
          this.error(`Failed to set options for ${capabilityId}:`, err.message);
        });
      }
      return;
    }

    if (this.hasCapability(capabilityId)) {
      this.log(`Removing per-phase capability: ${capabilityId}`);
      await this.removeCapability(capabilityId).catch((err) => {
        this.error(`Failed to remove capability ${capabilityId}:`, err.message);
      });
    }
  }

  /**
   * Write per-phase values, when the capabilities are present.
   * @param {Object} prodData - Live readings
   */
  async updatePhaseValues(prodData) {
    const gridPhases = Array.isArray(prodData.gridpowerPhases) ? prodData.gridpowerPhases : [];
    const homePhases = Array.isArray(prodData.homepowerPhases) ? prodData.homepowerPhases : [];

    for (let idx = 0; idx < PHASE_IDS.length; idx++) {
      const phaseId = PHASE_IDS[idx];
      const grid = gridPhases[idx];
      const home = homePhases[idx];

      if (this.hasCapability(`measure_power.${phaseId}`) && grid && typeof grid.activePower === 'number') {
        await this.setCapabilityValue(`measure_power.${phaseId}`, Math.round(grid.activePower * 10) / 10).catch(this.error);
      }
      if (this.hasCapability(`measure_voltage.${phaseId}`) && grid && typeof grid.voltage === 'number') {
        await this.setCapabilityValue(`measure_voltage.${phaseId}`, Math.round(grid.voltage * 10) / 10).catch(this.error);
      }
      if (this.hasCapability(`measure_power.home_${phaseId}`) && home && typeof home.activePower === 'number') {
        await this.setCapabilityValue(`measure_power.home_${phaseId}`, Math.round(home.activePower * 10) / 10).catch(this.error);
      }
    }
  }

}

module.exports = HomeLoadDevice;
