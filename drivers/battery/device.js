'use strict';

const net = require('net');
const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');

// Declaration for the central polling manager: no slow telemetry, fast battery power read only.
const REGISTRATION = { telemetry: null, fast: true, sources: ['batteryPower'] };

const CAPABILITIES = [
  'measure_power',
  'measure_battery',
  'meter_power.charged',
  'meter_power.discharged',
  'last_update',
];

/**
 * Enphase Battery: one device per gateway aggregating all batteries (monitoring only, no control).
 * Values come exclusively from the state snapshot (`onEnphaseState`); the device never talks to the gateway and never
 * polls. Availability is owned by the core (never setAvailable/setUnavailable here); a known-absent battery is shown as
 * a device warning instead.
 */
class BatteryDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Enphase Battery Device has been initialized');

    const settings = this.getSettings();
    const initialToken = this.getStoreValue('enphase_token');

    for (const cap of CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability: ${cap}`);
        await this.addCapability(cap).catch((err) => {
          this.error(`Failed to add capability ${cap}:`, err.message);
        });
      }
    }

    // Shared client for this gateway (the core resolves it from the registered devices' settings and token)
    this.initApi(settings, initialToken);

    // Snapshot state (onEnphaseState is the sole writer of all capabilities)
    this.registeredSerial = null;
    this.reconfigureTimer = null;
    this.pollChangePending = false;
    this.lastObservedAt = 0;
    this.lastObserved = {};
    this.lastCounter = {};
    this.absentWarning = null; // unknown until the first snapshot; clears a stale warning from a previous session
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
    this.log('Enphase Battery Device is being uninitialized');
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
    if (this.registeredSerial) {
      // Different gateway: its observation times and counters are unrelated to what was accepted so far.
      this.lastObservedAt = 0;
      this.lastObserved = {};
      this.lastCounter = {};
      this.absentWarning = null;
    }
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
   * Apply a gateway snapshot. Sole writer of every capability. Calls may overlap (the core does not await
   * devices serially), so the newest snapshot is applied in order and intermediate ones are dropped; per-field
   * observation times reject late/older samples.
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
          await this.applyBatteryState(next);
        } catch (err) {
          this.error('Failed to apply battery state:', err.message);
        }
      }
    } finally {
      this.stateApplying = false;
    }
  }

  /**
   * Accept a live field only when fresh, finite (and within `range` when given) and not older than the last accepted
   * observation of that field. Null/stale/unknown fields keep the last good capability value (never written as zero).
   * Measured zero is valid.
   * @returns {number|null} The observation time when accepted
   */
  acceptField(state, name, range) {
    const field = state.fields && state.fields[name];
    const value = state[name];
    if (!field || field.status !== 'fresh') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (range && (value < range[0] || value > range[1])) return null;
    if (typeof field.observedAt !== 'number' || !Number.isFinite(field.observedAt)) return null;
    if (field.observedAt < (this.lastObserved[name] || 0)) return null;
    this.lastObserved[name] = field.observedAt;
    return field.observedAt;
  }

  /**
   * Accept a lifetime counter (monotonic, persisted per gateway serial by the core). A counter is state rather than an
   * observation, so a persisted value is accepted even when it is not fresh (e.g. right after an app restart); it never
   * advances last_update. A fresh counter must not be older than the last accepted one. Values never decrease while
   * this device stays on the same gateway (in-memory guard; the core guarantees monotonic totals across restarts).
   * @returns {{accepted: boolean, observedAt: number|null}} `observedAt` is set only for fresh, newly observed values
   */
  acceptCounter(state, name) {
    const field = state.fields && state.fields[name];
    const value = state[name];
    const none = { accepted: false, observedAt: null };
    if (!field) return none;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return none;

    const previous = this.lastCounter[name];
    if (typeof previous === 'number' && value < previous) return none;

    if (field.source === 'persisted' && (field.status === 'fresh' || field.status === 'stale')) {
      this.lastCounter[name] = value;
      return { accepted: true, observedAt: null };
    }
    if (field.status !== 'fresh') return none;
    if (typeof field.observedAt !== 'number' || !Number.isFinite(field.observedAt)) return none;
    if (field.observedAt < (this.lastObserved[name] || 0)) return none;
    this.lastObserved[name] = field.observedAt;
    this.lastCounter[name] = value;
    return { accepted: true, observedAt: field.observedAt };
  }

  async setIfChanged(capability, value) {
    if (this.getCapabilityValue(capability) !== value) {
      await this.setCapabilityValue(capability, value);
    }
  }

  async applyBatteryState(state) {
    if (!state) return;

    // Known-absent battery is a hardware warning, distinct from unknown detection (null) and communication loss.
    await this.applyAbsentWarning(state.has ? state.has.battery : null);

    let newest = 0;

    // Positive = charging, negative = discharging (sign flip already done in the core).
    const powerObserved = this.acceptField(state, 'batteryW');
    if (powerObserved !== null) {
      newest = Math.max(newest, powerObserved);
      await this.setIfChanged('measure_power', state.batteryW);
    }

    const socObserved = this.acceptField(state, 'soc', [0, 100]);
    if (socObserved !== null) {
      newest = Math.max(newest, socObserved);
      await this.setIfChanged('measure_battery', state.soc);
    }

    const charged = this.acceptCounter(state, 'battChargedKWh');
    if (charged.accepted) {
      if (charged.observedAt !== null) newest = Math.max(newest, charged.observedAt);
      await this.setIfChanged('meter_power.charged', state.battChargedKWh);
    }

    const discharged = this.acceptCounter(state, 'battDischargedKWh');
    if (discharged.accepted) {
      if (discharged.observedAt !== null) newest = Math.max(newest, discharged.observedAt);
      await this.setIfChanged('meter_power.discharged', state.battDischargedKWh);
    }

    // last_update reflects the newest accepted fresh observation, never the time a request was attempted.
    if (newest > this.lastObservedAt) {
      this.lastObservedAt = newest;
      const lastUpdateStr = await this.homey.app.formatTimeLocal(Math.round(newest / 1000));
      await this.setIfChanged('last_update', lastUpdateStr);
    }
  }

  /**
   * Show a warning only when the core has verified that no battery exists (`has.battery === false`). Unknown (`null`)
   * and present (`true`) clear it.
   * @param {boolean|null} hasBattery
   */
  async applyAbsentWarning(hasBattery) {
    const absent = hasBattery === false;
    if (this.absentWarning === absent) return;
    this.absentWarning = absent;
    if (absent) {
      await this.setWarning(this.homey.__('driver.battery.warning.no_battery'));
    } else {
      await this.unsetWarning();
    }
  }

  initApi(settings, token) {
    this.homey.app.getApiInstance({
      serial: settings.envoy_serial,
      ip: settings.envoy_ip,
      userEmail: settings.user_email,
      password: settings.password,
      initialToken: token || null,
    });
  }

  /**
   * Handle settings changes by the user in the Homey settings UI.
   */
  async onSettings({ newSettings, changedKeys }) {
    await this.applySettingsChange(newSettings, changedKeys);
  }

  /**
   * Apply changed settings: IP check, credential validation and the registration follow-up.
   * @param {Object} newSettings - The full new settings
   * @param {string[]} changedKeys
   */
  async applySettingsChange(newSettings, changedKeys) {
    this.log('Device settings were modified:', JSON.stringify(changedKeys));

    // IP literals only: runtime connections never use hostnames.
    if (changedKeys.includes('envoy_ip') && net.isIP(newSettings.envoy_ip) === 0) {
      throw new Error(this.homey.__('driver.battery.error.invalid_ip'));
    }

    // If credential-relevant keys are changed, validate them and refresh the shared client
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
      } catch (err) {
        this.error('Failed to validate new settings:', err.message);
        throw new Error(this.homey.__('driver.battery.error.save_settings_failed', { message: err.message }));
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

module.exports = BatteryDevice;
