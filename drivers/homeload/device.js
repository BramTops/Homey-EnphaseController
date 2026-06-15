'use strict';

const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

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
    this.hasConsumption = !!this.getStoreValue('has_consumption');

    // Check and add missing capabilities dynamically for older paired devices
    const requiredCapabilities = [
      'measure_power',
      'meter_power',
      'meter_power_today',
      'measure_power.consumed',
      'meter_power.consumed',
      'meter_power_today.consumed',
      'last_update',
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability: ${cap}`);
        await this.addCapability(cap).catch((err) => {
          this.error(`Failed to add capability ${cap}:`, err.message);
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

    // Calculate daily energy consumption for grid
    const currentDay = new Date().getDate();
    const gridEnergyToday = await this.calculateDailyEnergy(prodData.netConsumptionKwhLifetime, currentDay, '_net');

    // Update primary capabilities (Grid Consumption)
    this.log(
      'Grid telemetry updated: '
      + `gridWattsNow = ${prodData.netConsumptionWattsNow} W, `
      + `gridKwhLifetime = ${prodData.netConsumptionKwhLifetime} kWh, `
      + `gridEnergyToday = ${gridEnergyToday} kWh, `
      + `readingTime = ${prodData.readingTime} (${lastUpdateStr})`,
    );

    await this.setCapabilityValue('measure_power', prodData.netConsumptionWattsNow);
    await this.setCapabilityValue('meter_power', prodData.netConsumptionKwhLifetime);
    await this.setCapabilityValue('meter_power_today', gridEnergyToday);
    await this.setCapabilityValue('last_update', lastUpdateStr);

    // If total home consumption is available, calculate and update it too
    if (prodData.hasConsumption) {
      const homeEnergyToday = await this.calculateDailyEnergy(prodData.consumptionKwhLifetime, currentDay, '_consumed');

      this.log(
        'Home consumption telemetry updated: '
        + `homeWattsNow = ${prodData.consumptionWattsNow} W, `
        + `homeKwhLifetime = ${prodData.consumptionKwhLifetime} kWh, `
        + `homeEnergyToday = ${homeEnergyToday} kWh`,
      );

      const oldPower = this.getCapabilityValue('measure_power.consumed');
      const oldEnergy = this.getCapabilityValue('meter_power.consumed');
      const oldEnergyToday = this.getCapabilityValue('meter_power_today.consumed');

      await this.setCapabilityValue('measure_power.consumed', prodData.consumptionWattsNow);
      await this.setCapabilityValue('meter_power.consumed', prodData.consumptionKwhLifetime);
      await this.setCapabilityValue('meter_power_today.consumed', homeEnergyToday);

      if (oldPower !== prodData.consumptionWattsNow) {
        const trigger = this.homey.flow.getDeviceTriggerCard('consumed_power_changed');
        if (trigger) {
          trigger.trigger(this, { value: prodData.consumptionWattsNow }, {}).catch(this.error);
        }
      }

      if (oldEnergy !== prodData.consumptionKwhLifetime) {
        const trigger = this.homey.flow.getDeviceTriggerCard('consumed_energy_changed');
        if (trigger) {
          trigger.trigger(this, { value: prodData.consumptionKwhLifetime }, {}).catch(this.error);
        }
      }

      if (oldEnergyToday !== homeEnergyToday) {
        const trigger = this.homey.flow.getDeviceTriggerCard('consumed_energy_today_changed');
        if (trigger) {
          trigger.trigger(this, { value: homeEnergyToday }, {}).catch(this.error);
        }
      }
    }

    // Update stores if metered status changes
    if (this.isMetered !== prodData.isMetered) {
      this.isMetered = prodData.isMetered;
      await this.setStoreValue('is_metered', this.isMetered).catch(this.error);
    }
    if (this.hasConsumption !== prodData.hasConsumption) {
      this.hasConsumption = prodData.hasConsumption;
      await this.setStoreValue('has_consumption', this.hasConsumption).catch(this.error);
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

}

module.exports = HomeLoadDevice;
