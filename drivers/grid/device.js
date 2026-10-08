'use strict';

const net = require('net');
const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

// Declaration for the central polling manager: slow production telemetry plus the fast meter/production snapshot.
const REGISTRATION = { telemetry: 'production', fast: true, sources: ['meters', 'production'] };

class GridDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Enphase Grid Device has been initialized');

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

    // Snapshot state (onEnphaseState is the sole writer of the instantaneous power capabilities)
    this.registeredSerial = null;
    this.reconfigureTimer = null;
    this.pollChangePending = false;
    this.lastObservedAt = 0;
    this.lastGridObservedAt = 0;
    this.lastHomeObservedAt = 0;
    this.pendingState = null;
    this.stateApplying = false;
    this.destroyed = false;

    // Register with App-level polling manager
    this.registerWithApp(settings.envoy_serial);
  }

  /**
   * onUninit is called when the device is removed or the app is stopped.
   */
  async onUninit() {
    this.log('Enphase Grid Device is being uninitialized');
    this.shutdown();
  }

  /**
   * onDeleted is called when the user removes the device.
   */
  async onDeleted() {
    this.shutdown();
  }

  shutdown() {
    this.destroyed = true;
    if (this.reconfigureTimer) {
      this.homey.clearTimeout(this.reconfigureTimer);
      this.reconfigureTimer = null;
    }
    this.unregisterFromApp();
  }

  registerWithApp(serial) {
    if (this.registeredSerial === serial) return;
    this.unregisterFromApp();
    this.homey.app.registerDevice(serial, this, REGISTRATION);
    this.registeredSerial = serial;
  }

  unregisterFromApp() {
    if (this.registeredSerial) {
      this.homey.app.unregisterDevice(this.registeredSerial, this);
      this.registeredSerial = null;
    }
  }

  /**
   * Apply a gateway snapshot. Sole writer of measure_power (grid), measure_power.home, last_update and
   * the home power Flow trigger. Calls may overlap (the core does not await devices serially), so the newest snapshot
   * is applied in order and intermediate ones are dropped; per-field observation times reject late/older samples.
   * @param {Object} state - State snapshot for this gateway serial
   */
  async onEnphaseState(state) {
    this.pendingState = state;
    if (this.stateApplying) return;
    this.stateApplying = true;
    try {
      while (this.pendingState && !this.destroyed) {
        const next = this.pendingState;
        this.pendingState = null;
        try {
          await this.applyGridState(next);
        } catch (err) {
          this.error('Failed to apply grid state:', err.message);
        }
      }
    } finally {
      this.stateApplying = false;
    }
  }

  /**
   * Accept a field only when fresh, finite and not older than the last accepted observation of that field.
   * Null/stale fields keep the last good capability value (never written as zero).
   * @returns {number|null} The observation time when accepted
   */
  acceptField(state, name, lastKey) {
    const field = state.fields && state.fields[name];
    const value = state[name];
    if (!field || field.status !== 'fresh') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (typeof field.observedAt !== 'number' || !Number.isFinite(field.observedAt)) return null;
    if (field.observedAt < this[lastKey]) return null;
    this[lastKey] = field.observedAt;
    return field.observedAt;
  }

  async applyGridState(state) {
    if (!state) return;

    let newest = 0;

    const gridObserved = this.acceptField(state, 'gridW', 'lastGridObservedAt');
    if (gridObserved !== null) {
      newest = Math.max(newest, gridObserved);
      if (this.getCapabilityValue('measure_power') !== state.gridW) {
        await this.setCapabilityValue('measure_power', state.gridW);
      }
    }

    const homeObserved = this.acceptField(state, 'homeW', 'lastHomeObservedAt');
    if (homeObserved !== null) {
      newest = Math.max(newest, homeObserved);
      // The capability exists only for gateways with a home consumption CT (kept as in the homeload driver).
      if (this.hasCapability('measure_power.home')) {
        const oldPower = this.getCapabilityValue('measure_power.home');
        if (oldPower !== state.homeW) {
          await this.setCapabilityValue('measure_power.home', state.homeW);
          // Once per accepted value change.
          const trigger = this.homey.flow.getDeviceTriggerCard('grid_home_power_changed');
          if (trigger) {
            trigger.trigger(this, { value: state.homeW }, {}).catch(this.error);
          }
        }
      }
    }

    // last_update reflects the newest successful relevant observation, never the time a request was attempted.
    if (newest > this.lastObservedAt) {
      this.lastObservedAt = newest;
      const lastUpdateStr = await this.homey.app.formatTimeLocal(Math.round(newest / 1000));
      if (this.getCapabilityValue('last_update') !== lastUpdateStr) {
        await this.setCapabilityValue('last_update', lastUpdateStr);
      }
    }
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
    this.log('Updating grid/home telemetry with data received from central poll...');

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
      + `readingTime = ${prodData.readingTime}`,
    );

    // measure_power, measure_power.home, last_update and the home power Flow trigger belong to onEnphaseState.
    await this.setCapabilityValue('meter_power', prodData.gridpowerKwhImported);
    await this.setCapabilityValue('meter_power_today', gridpowerEnergyTodayImported);

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

      const oldEnergy = this.getCapabilityValue('meter_power.home');
      const oldEnergyToday = this.getCapabilityValue('meter_power_today.home');

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

      if (oldEnergy !== prodData.homepowerKwhImported) {
        const trigger = this.homey.flow.getDeviceTriggerCard('grid_home_energy_changed');
        if (trigger) {
          trigger.trigger(this, { value: prodData.homepowerKwhImported }, {}).catch(this.error);
        }
      }

      if (oldEnergyToday !== homepowerEnergyTodayImported) {
        const trigger = this.homey.flow.getDeviceTriggerCard('grid_home_energy_today_changed');
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
  async onSettings({ newSettings, changedKeys }) {
    await this.applySettingsChange(newSettings, changedKeys);
  }

  /**
   * Apply changed settings: IP check, credential validation and the registration follow-up. Shared by onSettings and
   * the repair flow, because device.setSettings() does not trigger onSettings.
   * @param {Object} newSettings - The full new settings
   * @param {string[]} changedKeys
   */
  async applySettingsChange(newSettings, changedKeys) {
    this.log('Device settings were modified:', JSON.stringify(changedKeys));

    // IP literals only: runtime connections never use hostnames.
    if (changedKeys.includes('envoy_ip') && net.isIP(newSettings.envoy_ip) === 0) {
      throw new Error(this.homey.__('driver.grid.error.invalid_ip'));
    }

    // If credential-relevant keys are changed, re-instantiate the API client
    if (
      changedKeys.includes('user_email')
      || changedKeys.includes('password')
      || changedKeys.includes('envoy_serial')
      || changedKeys.includes('envoy_ip')
    ) {
      this.log('Re-initializing API client with updated settings...');

      // Test the new settings by logging in using the newSettings IP directly.
      // The stored token is only replaced after this succeeded, so a rejected change keeps the working token.
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
        throw new Error(this.homey.__('driver.grid.error.save_settings_failed', { message: err.message }));
      }
    }

    // Registration and the requested update interval depend on the *applied* settings, which Homey only persists
    // after this handler resolves. Follow up shortly after.
    if (changedKeys.includes('poll_interval')) {
      this.pollChangePending = true;
    }
    if (this.pollChangePending || changedKeys.includes('envoy_serial')) {
      this.scheduleFollowUp({
        envoy_serial: newSettings.envoy_serial,
        poll_interval: newSettings.poll_interval,
      });
    }
  }

  /**
   * Run registration/reconfigureDevice once the new settings are visible through getSetting().
   * Polls every 500 ms (max 10 tries) for that, because onSettings runs before Homey persists the values.
   * @param {{envoy_serial: string, poll_interval: number}} expected
   * @param {number} [attempt=0]
   */
  scheduleFollowUp(expected, attempt = 0) {
    if (this.destroyed) return;
    if (this.reconfigureTimer) {
      this.homey.clearTimeout(this.reconfigureTimer);
    }
    this.reconfigureTimer = this.homey.setTimeout(() => {
      this.reconfigureTimer = null;
      this.runFollowUp(expected, attempt).catch(this.error);
    }, 500);
  }

  async runFollowUp(expected, attempt) {
    if (this.destroyed) return;

    const applied = this.getSetting('envoy_serial') === expected.envoy_serial
      && this.getSetting('poll_interval') === expected.poll_interval;
    if (!applied && attempt < 10) {
      this.scheduleFollowUp(expected, attempt + 1);
      return;
    }

    const serial = this.getSetting('envoy_serial');
    const wasRegistered = this.registeredSerial === serial;
    this.registerWithApp(serial);
    // A fresh registration already picked up poll_interval; an existing one must be told about the change.
    if (this.pollChangePending && wasRegistered) {
      await this.homey.app.reconfigureDevice(serial, this);
    }
    this.pollChangePending = false;
  }

}

module.exports = GridDevice;
