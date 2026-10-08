'use strict';

const net = require('net');
const Homey = require('homey');
const EnvoyApi = require('../../lib/EnvoyApi');
const PairingHelper = require('../../lib/PairingHelper');

// Declaration for the central polling manager: slow production telemetry plus the fast meter/production snapshot.
const REGISTRATION = { telemetry: 'production', fast: true, sources: ['meters', 'production'] };

// While blocked by a legacy solar device, re-check now and then so removing the old device frees this one
// without an app restart.
const CONFLICT_RECHECK_MS = 5 * 60 * 1000;

// After a transient failure to enumerate the legacy drivers (e.g. during app start), retry once soon, then fall back
// to CONFLICT_RECHECK_MS.
const CONFLICT_QUICK_RETRY_MS = 15 * 1000;

class SolarDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Solar Device has been initialized');

    // Retrieve settings
    const settings = this.getSettings();

    // Retrieve stored store values and set class properties
    const initialToken = this.getStoreValue('enphase_token');
    this.isMaintainer = !!this.getStoreValue('is_maintainer');
    this.isMetered = !!this.getStoreValue('is_metered');
    this.productionLimiting = !!this.getStoreValue('production_limiting');

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

    // Snapshot state (onEnphaseState is the sole writer of measure_power and last_update)
    this.registeredSerial = null;
    this.conflicted = false;
    this.unverified = false; // legacy conflict check failed transiently before any check succeeded: treated as blocked
    this.conflictVerified = false;
    this.conflictQuickRetried = false;
    this.conflictTimer = null;
    this.conflictQuickTimer = null;
    this.reconfigureTimer = null;
    this.pollChangePending = false;
    this.lastSolarObservedAt = 0;
    this.pendingState = null;
    this.stateApplying = false;
    this.destroyed = false;

    // Same-serial legacy solar device? Decide before any control capability/listener is enabled.
    await this.syncRegistration(settings.envoy_serial, { register: false });

    // Initialize temporary cache for target power to resolve UI race conditions
    this.tempTargetPower = this.getCapabilityValue('target_power') || null;

    // Dynamically update PEL and onoff capabilities based on current role and metered status
    await this.ensurePelCapabilities();

    // Initialize the failed poll timestamp tracker (kept for legacy support if needed)
    this.firstFailedPollTime = null;

    // Register with App-level polling manager (skipped while a legacy solar device owns this gateway)
    await this.syncRegistration(settings.envoy_serial);
  }

  /**
   * onAdded is called after the user finished pairing this device: the migration snapshot has served its purpose.
   */
  async onAdded() {
    await PairingHelper.discardGatewayMigration(this.homey, this.getSetting('envoy_serial'));
  }

  /**
   * onUninit is called when the device is removed or the app is stopped.
   */
  async onUninit() {
    this.log('Solar Device is being uninitialized');
    this.destroyed = true;
    this.clearTimers();
    this.unregisterFromApp();
  }

  /**
   * onDeleted is called when the user removes the device.
   */
  async onDeleted() {
    this.destroyed = true;
    this.clearTimers();
    this.unregisterFromApp();
  }

  clearTimers() {
    if (this.conflictTimer) {
      this.homey.clearInterval(this.conflictTimer);
      this.conflictTimer = null;
    }
    if (this.conflictQuickTimer) {
      this.homey.clearTimeout(this.conflictQuickTimer);
      this.conflictQuickTimer = null;
    }
    if (this.reconfigureTimer) {
      this.homey.clearTimeout(this.reconfigureTimer);
      this.reconfigureTimer = null;
    }
  }

  unregisterFromApp() {
    if (this.registeredSerial) {
      this.homey.app.unregisterDevice(this.registeredSerial, this);
      this.registeredSerial = null;
    }
  }

  /**
   * Decide whether this device may poll/control the gateway and (un)register accordingly.
   * Conflict rule: a legacy `envoy`/`gateway` device on the same serial wins. Then this device does NOT register
   * (or unregisters first) and flags itself unavailable with a migration message, so the core never flips it back.
   * The old device is never touched. Recovery: remove the old device, then wait for the periodic re-check,
   * restart the app, change any setting of this device, or run Repair.
   * Availability is core-owned while registered, so setAvailable/setUnavailable are only called while unregistered.
   * A legacy driver that cannot be enumerated (transient error) is not treated as "no conflict": the previous state is
   * kept (a working device is not unregistered) and the check is retried once after CONFLICT_QUICK_RETRY_MS, then at
   * every periodic re-check. Before the first successful check the device stays unregistered and its controls stay
   * blocked (`unverified`).
   * @param {string} serial
   * @param {Object} [opts]
   * @param {boolean} [opts.register=true] - Register with the polling manager when there is no conflict
   * @returns {Promise<boolean>} True when the conflict check itself succeeded
   */
  async syncRegistration(serial, { register = true } = {}) {
    if (this.destroyed) return false;

    let conflict;
    try {
      conflict = await PairingHelper.findLegacySolarConflict(this.homey, serial, { throwOnError: true });
    } catch (err) {
      this.error('Legacy solar conflict check failed, keeping the previous state:', err.message);
      this.conflictCheckError = err.message;
      // Until a check succeeded the conflict is unknown: keep controls blocked (a verified device keeps its state).
      if (!this.conflictVerified) this.unverified = true;
      if (!this.destroyed) {
        if (!this.conflictTimer) {
          this.conflictTimer = this.homey.setInterval(() => {
            this.syncRegistration(this.getSetting('envoy_serial')).catch(this.error);
          }, CONFLICT_RECHECK_MS);
        }
        // Retry soon once (the legacy drivers are often not ready yet during app start), then every CONFLICT_RECHECK_MS.
        if (!this.conflictQuickRetried && !this.conflictQuickTimer) {
          this.conflictQuickRetried = true;
          this.conflictQuickTimer = this.homey.setTimeout(() => {
            this.conflictQuickTimer = null;
            this.syncRegistration(this.getSetting('envoy_serial')).catch(this.error);
          }, CONFLICT_QUICK_RETRY_MS);
        }
      }
      return false;
    }
    if (this.destroyed) return false;

    const wasUnverified = this.unverified;
    this.unverified = false;
    this.conflictVerified = true;
    this.conflictQuickRetried = false;

    if (conflict) {
      this.log(`Legacy ${conflict.driverId} device exists on this gateway; staying unregistered and unavailable.`);
      this.unregisterFromApp();
      this.conflicted = true;
      await this.setUnavailable(this.homey.__('driver.solar.error.legacy_conflict')).catch(this.error);
      if (this.destroyed) return false;
      if (!this.conflictTimer) {
        this.conflictTimer = this.homey.setInterval(() => {
          this.syncRegistration(this.getSetting('envoy_serial')).catch(this.error);
        }, CONFLICT_RECHECK_MS);
      }
      return true;
    }

    if (this.conflictTimer) {
      this.homey.clearInterval(this.conflictTimer);
      this.conflictTimer = null;
    }
    if (this.conflicted) {
      this.log('Legacy solar conflict resolved.');
      this.conflicted = false;
      // Not registered right now, so this is the only writer of availability; the core takes over on register.
      await this.setAvailable().catch(this.error);
      // Control was held back while blocked: run the control-capability test now, then expose the controls.
      await this.testProductionLimitingSupport();
      await this.ensurePelCapabilities();
    } else if (wasUnverified) {
      // Controls were held back only while the conflict was unverified: expose them now (no probe write needed).
      await this.ensurePelCapabilities();
    }

    if (this.destroyed) return false;
    if (register && this.registeredSerial !== serial) {
      this.unregisterFromApp();
      this.homey.app.registerDevice(serial, this, REGISTRATION);
      this.registeredSerial = serial;
    }
    return true;
  }

  /** Control and probe actions are refused while a legacy solar device owns this gateway. */
  assertNotConflicted() {
    if (this.conflicted || this.unverified) {
      throw new Error(this.homey.__('driver.solar.error.legacy_conflict'));
    }
  }

  /**
   * Apply a gateway snapshot. Sole writer of measure_power and last_update.
   * Calls may overlap (the core does not await devices serially), so the newest snapshot is applied in order and
   * intermediate ones are dropped; per-field observation times reject late/older samples.
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
          await this.applySolarState(next);
        } catch (err) {
          this.error('Failed to apply solar state:', err.message);
        }
      }
    } finally {
      this.stateApplying = false;
    }
  }

  async applySolarState(state) {
    if (!state || !state.fields || !state.fields.solarW) return;

    const field = state.fields.solarW;
    const watts = state.solarW;
    // Null/stale fields keep the last good capability value; they are never written as zero.
    if (field.status !== 'fresh' || typeof watts !== 'number' || !Number.isFinite(watts)) return;
    if (typeof field.observedAt !== 'number' || !Number.isFinite(field.observedAt)) return;
    if (field.observedAt < this.lastSolarObservedAt) return;
    this.lastSolarObservedAt = field.observedAt;

    if (this.getCapabilityValue('measure_power') !== watts) {
      await this.setCapabilityValue('measure_power', watts);
    }
    // last_update reflects the newest successful observation, never the time a request was attempted.
    const lastUpdateStr = await this.homey.app.formatTimeLocal(Math.round(field.observedAt / 1000));
    if (this.getCapabilityValue('last_update') !== lastUpdateStr) {
      await this.setCapabilityValue('last_update', lastUpdateStr);
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

  /**
   * Register the capability listener for the power switch (onoff).
   * Ensures the listener is registered at most once to prevent duplicate callback registration errors.
   * Remaps ON/OFF toggles on metered gateways to dynamic PEL commands. Reason (earlier maintainer finding,
   * not Enphase-documented): powerForcedOff also opens the production contactor, which is believed to cut
   * battery/contactor communications; a 0 W DPEL limit curtails the microinverters without that side effect.
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

      this.assertNotConflicted();

      // Check Always on setting
      if (!value && this.getSetting('always_on')) {
        this.log('Cannot turn off device: "Always on" setting is enabled.');
        throw new Error(this.homey.__('driver.solar.error.always_on'));
      }

      // Verify that this account is authorized to perform control actions
      if (!this.isMaintainer) {
        this.error('Permission denied: Account role is not Maintainer / Installer.');
        throw new Error(this.homey.__('driver.solar.error.no_maintainer'));
      }

      try {
        const usePel = this.isMetered && this.isMaintainer && this.productionLimiting;
        if (usePel) {
          // Remap switch for metered gateways supporting dynamic limiting to dynamic PEL (see registerOnoffListener)
          // Shuts down PV generation safely via microinverter curtailment (no full contactor block)
          if (value) {
            // ON -> Disable limit override, restore Normal solar production
            await this.api.setDpelSettings({
              enable: false,
              export_limit: true,
              limit_value_W: 0,
            });
            await this.setCapabilityValue('target_power_mode', 'device').catch(this.error);
            this.log('Successfully remapped ON command to disable PEL (Normal solar production)');
          } else {
            // OFF -> Enable limit at 0 W to halt PV production safely
            await this.api.setDpelSettings({
              enable: true,
              export_limit: false,
              limit_value_W: 0,
            });
            await this.setCapabilityValue('target_power_mode', 'no_production').catch(this.error);
            this.log('Successfully remapped OFF command to set PEL to No production (0 W)');
          }
        } else {
          // Unmetered or unsupported PEL: Fallback to original powerForcedOff endpoint
          // value = true -> Enable production -> powerForcedOff = false
          // value = false -> Disable production -> powerForcedOff = true
          const forceOff = !value;
          await this.api.setPowerForcedOff(forceOff);
          this.log(`Successfully sent power production control command: powerForcedOff = ${forceOff}`);
        }
      } catch (err) {
        this.error('Failed to change power production state:', err.message);
        throw new Error(this.homey.__('driver.solar.error.command_failed', { message: err.message }));
      }
    });

    this.onoffListenerRegistered = true;
  }

  /**
   * Register listeners for target_power and target_power_mode capabilities.
   * This handles UI changes from Homey Pro, validating inputs, and calling the local Envoy client.
   * Adds guard checks for role and metered status to prevent unauthorized writes.
   */
  registerPelListeners() {
    if (this.pelListenersRegistered) {
      return;
    }

    if (this.hasCapability('target_power')) {
      this.log('Registering capability listener for: target_power');
      this.registerCapabilityListener('target_power', async (value) => {
        this.log(`Target power (production limit) changed in UI to: ${value} W`);
        this.assertNotConflicted();

        if (!this.isMaintainer) {
          throw new Error(this.homey.__('driver.solar.error.no_maintainer'));
        }
        if (!this.isMetered) {
          throw new Error(this.homey.__('driver.solar.error.not_metered'));
        }

        // Cache the latest value in-memory to prevent UI race conditions
        this.tempTargetPower = value;

        const mode = this.getCapabilityValue('target_power_mode') || 'device';
        if (mode === 'homey') {
          try {
            // Write the production limit directly to the dynamic PEL settings endpoint
            await this.api.setDpelSettings({
              enable: true,
              export_limit: false,
              limit_value_W: value,
            });
            this.log(`Successfully updated Envoy dynamic production limit to: ${value} W`);
          } catch (err) {
            this.error('Failed to set Envoy production limit:', err.message);
            throw new Error(this.homey.__('driver.solar.error.command_failed', { message: err.message }));
          }
        } else {
          this.log(`Currently in mode: ${mode}. Discarding target_power update (only active in Custom solar production mode).`);
        }
      });
    }

    if (this.hasCapability('target_power_mode')) {
      this.log('Registering capability listener for: target_power_mode');
      this.registerCapabilityListener('target_power_mode', async (value) => {
        this.log(`Target power mode changed in UI to: ${value}`);
        this.assertNotConflicted();

        // Check Always on setting when attempting to stop production via PEL mode
        if (value === 'no_production' && this.getSetting('always_on')) {
          this.log('Cannot set mode to "no_production": "Always on" setting is enabled.');
          throw new Error(this.homey.__('driver.solar.error.always_on'));
        }

        if (!this.isMaintainer) {
          throw new Error(this.homey.__('driver.solar.error.no_maintainer'));
        }
        if (!this.isMetered) {
          throw new Error(this.homey.__('driver.solar.error.not_metered'));
        }

        try {
          if (value === 'homey') {
            // Custom solar production: enable dynamic limit, target production (export_limit: false)
            const targetPower = typeof this.tempTargetPower === 'number'
              ? this.tempTargetPower
              : (this.getCapabilityValue('target_power') || 0);
            await this.api.setDpelSettings({
              enable: true,
              export_limit: false,
              limit_value_W: targetPower,
            });
            await this.setCapabilityValue('onoff', true).catch(this.error);
            this.log(`Successfully enabled dynamic production limit with target: ${targetPower} W`);
          } else if (value === 'self_use') {
            // Self-use only: enable dynamic limit, target grid export (export_limit: true)
            // Reads the static offset from the user's advanced settings (pel_offset, defaults to 0)
            const settings = this.getSettings();
            const offset = typeof settings.pel_offset === 'number' ? settings.pel_offset : 0;
            await this.api.setDpelSettings({
              enable: true,
              export_limit: true,
              limit_value_W: offset,
            });
            await this.setCapabilityValue('onoff', true).catch(this.error);
            this.log(`Successfully enabled self-use mode (zero export) with offset: ${offset} W`);
          } else if (value === 'no_production') {
            // No production: enable dynamic limit, target production (export_limit: false), limit to 0 W
            // This is a safe alternative to setPowerForcedOff that keeps batteries functional
            await this.api.setDpelSettings({
              enable: true,
              export_limit: false,
              limit_value_W: 0,
            });
            await this.setCapabilityValue('onoff', false).catch(this.error);
            this.log('Successfully enabled dynamic limit (No production: 0 W).');
          } else {
            // device mode (Normal solar production): disable dynamic PEL override
            await this.api.setDpelSettings({
              enable: false,
              export_limit: true,
              limit_value_W: 0,
            });
            await this.setCapabilityValue('onoff', true).catch(this.error);
            this.log('Successfully disabled dynamic limit override (Normal production).');
          }
        } catch (err) {
          this.error('Failed to update Envoy PEL mode:', err.message);
          throw new Error(this.homey.__('driver.solar.error.command_failed', { message: err.message }));
        }
      });
    }

    this.pelListenersRegistered = true;
  }

  /**
   * Dynamically add or remove PEL capabilities (target_power, target_power_mode)
   * and the onoff control switch depending on user role and metered status.
   * This is called on device init, on central poll updates, and settings/role updates.
   * Ensures that control capabilities are only exposed when they can physically function.
   *
   * @returns {Promise<void>}
   */
  async ensurePelCapabilities() {
    // Control capabilities stay unexposed while a legacy solar device owns this gateway (syncRegistration calls this
    // again once the conflict is resolved or verified absent).
    if (this.conflicted || this.unverified) {
      return;
    }

    this.log(`ensurePelCapabilities check: isMaintainer = ${this.isMaintainer}, isMetered = ${this.isMetered}, productionLimiting = ${this.productionLimiting}`);

    const currentProdLimiting = this.isMetered && this.isMaintainer && this.productionLimiting;

    if (this.isMaintainer) {
      // 1. Maintainer: Always expose the standard onoff switch capability
      if (!this.hasCapability('onoff')) {
        this.log('Adding capability: onoff');
        await this.addCapability('onoff').catch((err) => {
          this.error('Failed to add capability onoff:', err.message);
        });
      }
      this.registerOnoffListener();

      // 2. Expose Production Limiting capability if both isMetered and isMaintainer are true
      if (this.isMetered) {
        if (!this.hasCapability('production_limiting')) {
          this.log('Adding capability: production_limiting');
          await this.addCapability('production_limiting').catch((err) => {
            this.error('Failed to add capability production_limiting:', err.message);
          });
        }
        await this.setCapabilityValue('production_limiting', currentProdLimiting).catch(this.error);
      } else if (this.hasCapability('production_limiting')) {
        this.log('Removing capability: production_limiting');
        await this.removeCapability('production_limiting').catch((err) => {
          this.error('Failed to remove capability production_limiting:', err.message);
        });
      }

      // 3. Expose dynamic PEL capabilities only if production limiting is supported and active
      if (currentProdLimiting) {
        let addedAny = false;
        if (!this.hasCapability('target_power')) {
          this.log('Adding capability: target_power');
          await this.addCapability('target_power').catch((err) => {
            this.error('Failed to add capability target_power:', err.message);
          });
          addedAny = true;
        }
        if (!this.hasCapability('target_power_mode')) {
          this.log('Adding capability: target_power_mode');
          await this.addCapability('target_power_mode').catch((err) => {
            this.error('Failed to add capability target_power_mode:', err.message);
          });
          addedAny = true;
        }
        // Register listeners for target_power and target_power_mode capabilities
        if (addedAny || !this.pelListenersRegistered) {
          this.registerPelListeners();
        }
      } else {
        // Remove PEL capabilities
        if (this.hasCapability('target_power')) {
          this.log('Removing capability: target_power');
          await this.removeCapability('target_power').catch((err) => {
            this.error('Failed to remove capability target_power:', err.message);
          });
        }
        if (this.hasCapability('target_power_mode')) {
          this.log('Removing capability: target_power_mode');
          await this.removeCapability('target_power_mode').catch((err) => {
            this.error('Failed to remove capability target_power_mode:', err.message);
          });
        }
        this.pelListenersRegistered = false;
      }
    } else {
      // Non-Maintainer: Remove all control switch, production limiting and limit capabilities (read-only mode)
      if (this.hasCapability('onoff')) {
        this.log('Removing capability: onoff (unauthorized role)');
        await this.removeCapability('onoff').catch((err) => {
          this.error('Failed to remove capability onoff:', err.message);
        });
        this.onoffListenerRegistered = false;
      }
      if (this.hasCapability('production_limiting')) {
        this.log('Removing capability: production_limiting (unauthorized role)');
        await this.removeCapability('production_limiting').catch((err) => {
          this.error('Failed to remove capability production_limiting:', err.message);
        });
      }
      if (this.hasCapability('target_power')) {
        this.log('Removing capability: target_power (unauthorized role)');
        await this.removeCapability('target_power').catch((err) => {
          this.error('Failed to remove capability target_power:', err.message);
        });
      }
      if (this.hasCapability('target_power_mode')) {
        this.log('Removing capability: target_power_mode (unauthorized role)');
        await this.removeCapability('target_power_mode').catch((err) => {
          this.error('Failed to remove capability target_power_mode:', err.message);
        });
      }
      this.pelListenersRegistered = false;
    }
  }

  /**
   * Verify Envoy local PEL state matches the Homey target states.
   * If a discrepancy is detected (e.g. Envoy reset via its hourly cloud sync), re-apply target settings.
   * Only called on metered systems with active maintainer authentication.
   *
   * @param {Object} pelSettings - Polled settings from GET /ivp/ss/dpel
   * @returns {Promise<void>}
   */
  async checkForPelCloudOverride(pelSettings) {
    const currentProdLimiting = this.isMetered && this.isMaintainer && this.productionLimiting;
    if (!currentProdLimiting || !pelSettings) {
      return;
    }

    const targetMode = this.hasCapability('target_power_mode') ? this.getCapabilityValue('target_power_mode') : null;
    const targetPower = this.hasCapability('target_power') ? this.getCapabilityValue('target_power') : null;

    if (!targetMode) {
      return;
    }

    // Determine the expected configuration based on Homey capability state
    let expectedEnable = false;
    let expectedExportLimit = true;
    let expectedLimit = 0;

    if (targetMode === 'homey') {
      expectedEnable = true;
      expectedExportLimit = false;
      expectedLimit = typeof targetPower === 'number' ? targetPower : 0;
    } else if (targetMode === 'self_use') {
      expectedEnable = true;
      expectedExportLimit = true;
      const settings = this.getSettings();
      expectedLimit = typeof settings.pel_offset === 'number' ? settings.pel_offset : 0;
    } else if (targetMode === 'no_production') {
      expectedEnable = true;
      expectedExportLimit = false;
      expectedLimit = 0;
    } else {
      // Normal production (device) has PEL disabled
      expectedEnable = false;
    }

    const currentEnable = !!(pelSettings.dynamic_pel_settings && pelSettings.dynamic_pel_settings.enable);
    const currentExportLimit = !!(pelSettings.dynamic_pel_settings && pelSettings.dynamic_pel_settings.export_limit);
    const currentLimit = pelSettings.dynamic_pel_settings && typeof pelSettings.dynamic_pel_settings.limit_value_W === 'number'
      ? pelSettings.dynamic_pel_settings.limit_value_W
      : 0;

    // Detect discrepancy in enable state, limit target, or export vs production mapping
    if (
      expectedEnable !== currentEnable
      || (expectedEnable && (expectedExportLimit !== currentExportLimit || expectedLimit !== currentLimit))
    ) {
      this.log(
        `PEL discrepancy detected: Homey expected (enable: ${expectedEnable}, exportLimit: ${expectedExportLimit}, limit: ${expectedLimit}W), `
        + `Envoy reported (enable: ${currentEnable}, exportLimit: ${currentExportLimit}, limit: ${currentLimit}W). `
        + 'Envoy might have reset via cloud sync. Re-applying Homey configuration...',
      );

      try {
        await this.api.setDpelSettings({
          enable: expectedEnable,
          export_limit: expectedExportLimit,
          limit_value_W: expectedLimit,
        });
        this.log('Successfully re-applied PEL configuration to Envoy.');
      } catch (err) {
        this.error('Failed to re-apply PEL configuration:', err.message);
      }
    }
  }

  /**
   * Update production telemetry received from the App orchestrator.
   * This is called by the central orchestrator poll loop.
   *
   * @param {Object} prodData - Live production readings
   * @param {boolean} powerForcedOff - True if production is disabled via setPowerForcedOff
   * @param {Object} [pelSettings] - Live PEL configuration from Envoy
   */
  async updateTelemetry(prodData, powerForcedOff, pelSettings = null) {
    this.log('Updating telemetry with data received from central poll...');

    // Step 1: Cloud Override Check (only when not using dynamic production limiting)
    const currentProdLimiting = this.isMetered && this.isMaintainer && this.productionLimiting;
    if (!currentProdLimiting) {
      let productionEnabled = !powerForcedOff;
      const overridden = await this.checkForCloudOverride(productionEnabled);
      if (overridden) {
        productionEnabled = false;
      }
      if (this.hasCapability('onoff')) {
        await this.setCapabilityValue('onoff', productionEnabled).catch(this.error);
      }
    }

    // Step 2: Calculate daily energy production
    const currentDay = new Date().getDate();
    const energyToday = await this.calculateDailyEnergy(prodData, currentDay);

    // Step 3: Update and save metered status if changed
    await this.updateMeteredStatus(prodData);

    // Step 4: Dynamically update PEL and onoff capabilities based on metered status
    await this.ensurePelCapabilities();

    // Step 5: Update device capability values
    await this.updateDeviceCapabilities(prodData, powerForcedOff, energyToday, pelSettings);

    // Step 6: Verify and re-apply PEL settings if there's a cloud-sync discrepancy
    if (this.isMetered && pelSettings) {
      await this.checkForPelCloudOverride(pelSettings);
    }
  }

  /**
   * Check if Homey is manual OFF but Envoy is ON, and re-apply OFF command if so.
   * The gateway syncs with Enphase Cloud at the top of every hour (observed) and the cloud default
   * (production enabled) overwrites local forced-off, so the state is re-checked on every poll instead of trusted.
   * Production can therefore resume for up to one poll interval after each hour change.
   * @param {boolean} productionEnabled
   * @returns {Promise<boolean>} True if command was overridden to OFF
   */
  async checkForCloudOverride(productionEnabled) {
    const currentOnoffValue = this.hasCapability('onoff') ? this.getCapabilityValue('onoff') : null;

    if (this.isMaintainer && currentOnoffValue === false && productionEnabled === true) {
      this.log(
        'Discrepancy detected: Homey is OFF, but Envoy is ON (production enabled). '
        + 'The Envoy likely reset itself during its hourly cloud sync. '
        + "Re-applying the OFF command to enforce the user's setting.",
      );

      try {
        await this.api.setPowerForcedOff(true);
        this.log('Successfully re-applied power production control command: powerForcedOff = true');
        return true;
      } catch (err) {
        this.error('Failed to re-apply power production control command:', err.message);
      }
    }
    return false;
  }

  /**
   * Calculate Energy Today production based on lifetime value and daily reset.
   * @param {Object} prodData
   * @param {number} currentDay
   * @returns {Promise<number>} Energy produced today in kWh
   */
  async calculateDailyEnergy(prodData, currentDay) {
    let todayDay = this.getStoreValue('today_day');
    let todayStartKwh = this.getStoreValue('today_start_kwh');

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

    energyToday = Math.round(energyToday * 100) / 100;
    this.log(`Energy today calculation: current lifetime = ${prodData.kwhLifetime} kWh, start of day = ${todayStartKwh} kWh, energy today = ${energyToday} kWh`);
    return energyToday;
  }

  /**
   * Update device capabilities inside Homey UI.
   *
   * @param {Object} prodData - Live production readings
   * @param {boolean} powerForcedOff - True if unmetered contactor is forced off
   * @param {number} energyToday - Calculated energy production today in kWh
   * @param {Object} [pelSettings] - Live Dynamic PEL configuration
   */
  async updateDeviceCapabilities(prodData, powerForcedOff, energyToday, pelSettings = null) {
    let productionEnabled = !powerForcedOff;

    const currentProdLimiting = this.isMetered && this.isMaintainer && this.productionLimiting;

    if (currentProdLimiting && pelSettings && pelSettings.dynamic_pel_settings) {
      const isEnabled = !!pelSettings.dynamic_pel_settings.enable;
      const isExport = !!pelSettings.dynamic_pel_settings.export_limit;
      const limit = pelSettings.dynamic_pel_settings.limit_value_W || 0;

      // Map dynamic PEL state back to our custom capability values
      let mode = 'device';
      if (isEnabled) {
        if (isExport) {
          mode = 'self_use';
        } else {
          mode = limit === 0 ? 'no_production' : 'homey';
        }
      }

      productionEnabled = (mode !== 'no_production');

      if (this.hasCapability('target_power_mode')) {
        await this.setCapabilityValue('target_power_mode', mode).catch(this.error);
      }

      if (this.hasCapability('target_power') && mode === 'homey') {
        await this.setCapabilityValue('target_power', limit).catch(this.error);
      }
    }

    if (this.hasCapability('production_limiting')) {
      await this.setCapabilityValue('production_limiting', currentProdLimiting).catch(this.error);
    }

    this.log(
      `Telemetry updated: powerForcedOff = ${!productionEnabled}, `
      + `wattsNow = ${prodData.wattsNow} W, `
      + `kwhLifetime = ${prodData.kwhLifetime} kWh, `
      + `connectedInverters = ${prodData.connectedInverters}, `
      + `readingTime = ${prodData.readingTime}`,
    );

    if (this.hasCapability('onoff')) {
      this.log(`Setting capability 'onoff' to: ${productionEnabled}`);
      await this.setCapabilityValue('onoff', productionEnabled).catch(this.error);
    }
    // measure_power and last_update are written by onEnphaseState (snapshot), not here.
    await this.setCapabilityValue('meter_power', prodData.kwhLifetime);
    await this.setCapabilityValue('meter_power_today', energyToday);
    await this.setCapabilityValue('connected_inverters', prodData.connectedInverters);

    const powerProductionStr = productionEnabled
      ? this.homey.__('driver.solar.status.on')
      : this.homey.__('driver.solar.status.off');

    await this.setCapabilityValue('power_production', powerProductionStr);
    await this.setCapabilityValue('control_state', this.isMaintainer);
    await this.setCapabilityValue('metered_gateway', this.isMetered);
  }

  /**
   * Check and update metered status if it has changed.
   * @param {Object} prodData
   */
  async updateMeteredStatus(prodData) {
    if (this.isMetered !== prodData.isMetered) {
      this.isMetered = prodData.isMetered;
      await this.setStoreValue('is_metered', this.isMetered).catch(this.error);

      // Re-evaluate production limiting support dynamically
      if (this.isMetered) {
        await this.testProductionLimitingSupport();
      } else {
        this.productionLimiting = false;
        await this.setStoreValue('production_limiting', false).catch(this.error);
      }
    }
  }

  /**
   * Handle settings changes by the user in the Homey settings UI.
   */
  async onSettings({ newSettings, changedKeys }) {
    await this.applySettingsChange(newSettings, changedKeys);
  }

  /**
   * Apply changed settings: IP check, conflict pre-check, Always on, credential validation and the registration
   * follow-up. Shared by onSettings and the repair flow, because device.setSettings() does not trigger onSettings.
   * @param {Object} newSettings - The full new settings
   * @param {string[]} changedKeys
   */
  async applySettingsChange(newSettings, changedKeys) {
    this.log('Device settings were modified:', JSON.stringify(changedKeys));

    // IP literals only: runtime connections never use hostnames.
    if (changedKeys.includes('envoy_ip') && net.isIP(newSettings.envoy_ip) === 0) {
      throw new Error(this.homey.__('driver.solar.error.invalid_ip'));
    }

    // Conflict rule for the serial that is about to become active: a legacy solar device wins, and nothing below
    // may write to the gateway. (Recovery from a conflict is handled by the follow-up after the settings applied.)
    // If the legacy drivers cannot be checked, the change is refused rather than assumed conflict-free.
    let restoreSerial = null;
    if (changedKeys.includes('envoy_serial') && !this.conflicted) {
      // Serial that was active before this change (the settings may already be persisted by the repair flow).
      restoreSerial = this.registeredSerial || this.getSetting('envoy_serial');
      const checked = await this.syncRegistration(newSettings.envoy_serial, { register: false });
      if (!checked) {
        throw new Error(this.homey.__('driver.solar.error.save_settings_failed', { message: this.conflictCheckError || 'unknown' }));
      }
    }

    try {
      await this.applyValidatedSettings(newSettings, changedKeys);
    } catch (err) {
      // The change is rejected (Homey reverts the settings): undo the pre-check's conflict state for the new serial.
      if (restoreSerial && this.conflicted && !this.destroyed) {
        await this.syncRegistration(restoreSerial).catch(this.error);
      }
      throw err;
    }
  }

  /**
   * Second half of applySettingsChange: Always on, credential validation and the registration follow-up.
   * @param {Object} newSettings - The full new settings
   * @param {string[]} changedKeys
   */
  async applyValidatedSettings(newSettings, changedKeys) {
    // Handle Always on setting change
    if (changedKeys.includes('always_on') && !this.conflicted) {
      this.log(`"Always on" setting changed to: ${newSettings.always_on}`);
      if (newSettings.always_on && this.isMaintainer) {
        const currentOnoff = this.hasCapability('onoff') ? this.getCapabilityValue('onoff') : null;
        if (currentOnoff === false) {
          this.log('"Always on" was enabled while device was OFF. Automatically turning device ON...');
          const usePel = this.isMetered && this.productionLimiting;
          try {
            if (usePel) {
              await this.api.setDpelSettings({
                enable: false,
                export_limit: true,
                limit_value_W: 0,
              });
              if (this.hasCapability('target_power_mode')) {
                await this.setCapabilityValue('target_power_mode', 'device');
              }
            } else {
              await this.api.setPowerForcedOff(false);
            }
            await this.setCapabilityValue('onoff', true);
          } catch (err) {
            this.error('Failed to enable production for Always on:', err.message);
            throw new Error(this.homey.__('driver.solar.error.command_failed', { message: err.message }));
          }
        }
      }
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

        // Decode the JWT to verify roles using the Envoy API helper method
        const tokenRoleResult = tempApi.evaluateTokenRole(token);
        const { isMaintainer } = tokenRoleResult;
        this.log('Settings role verification completed. Is Maintainer:', isMaintainer);

        this.isMaintainer = isMaintainer;
        await this.setStoreValue('is_maintainer', isMaintainer);
        await this.setStoreValue('enphase_token', token);

        this.initApi(newSettings, token);

        // Perform test write for dynamic production limiting support
        await this.testProductionLimitingSupport();

        // Dynamically update PEL and onoff capabilities based on the upgraded/downgraded role
        await this.ensurePelCapabilities();

        this.log('Settings validated successfully. Token and roles updated.');

        // Trigger status poll immediately via app central coordinator
        this.homey.app.triggerImmediatePoll(newSettings.envoy_serial);

      } catch (err) {
        this.error('Failed to validate new settings:', err.message);
        throw new Error(this.homey.__('driver.solar.error.save_settings_failed', { message: err.message }));
      }
    }

    // Registration, conflict recovery and the requested update interval depend on the *applied* settings, which
    // Homey only persists after this handler resolves. Follow up shortly after (any setting change also
    // re-checks a standing legacy solar conflict).
    if (changedKeys.includes('poll_interval')) {
      this.pollChangePending = true;
    }
    if (this.pollChangePending || this.conflicted || changedKeys.includes('envoy_serial')) {
      this.scheduleFollowUp({
        envoy_serial: newSettings.envoy_serial,
        poll_interval: newSettings.poll_interval,
      });
    }
  }

  /**
   * Run syncRegistration/reconfigureDevice once the new settings are visible through getSetting().
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
    await this.syncRegistration(serial);
    // A fresh registration already picked up poll_interval; an existing one must be told about the change.
    if (this.pollChangePending && wasRegistered && this.registeredSerial === serial) {
      await this.homey.app.reconfigureDevice(serial, this);
    }
    this.pollChangePending = false;
  }

  /**
   * Update the account role dynamically (e.g. from token refresh or auto-downgrade threshold).
   * @param {boolean} isMaintainer
   */
  async updateRole(isMaintainer) {
    if (this.isMaintainer === isMaintainer) return;

    this.log(`Updating role dynamically. Active Maintainer/Installer status: ${isMaintainer}`);
    this.isMaintainer = isMaintainer;
    await this.setStoreValue('is_maintainer', isMaintainer).catch(this.error);

    // If role is upgraded to maintainer, check if production limiting is supported
    if (isMaintainer) {
      await this.testProductionLimitingSupport();
    } else {
      this.productionLimiting = false;
      await this.setStoreValue('production_limiting', false).catch(this.error);
    }

    // Dynamically update capabilities based on the new role
    await this.ensurePelCapabilities();

    await this.setCapabilityValue('control_state', isMaintainer).catch(this.error);
  }

  /**
   * Test the local gateway's Dynamic PEL support and update store value.
   * Only run if both isMetered and isMaintainer are true.
   * @returns {Promise<boolean>} Result of the check
   */
  async testProductionLimitingSupport() {
    // The test is a control write: never while a legacy solar device owns this gateway.
    if (this.conflicted || this.unverified) {
      return false;
    }

    if (!this.isMetered || !this.isMaintainer) {
      this.productionLimiting = false;
      await this.setStoreValue('production_limiting', false).catch(this.error);
      return false;
    }

    this.log('Testing local dynamic production limiting (DPEL) support on Gateway...');
    try {
      // 1. Fetch current settings
      const originalSettings = await this.api.getDpelSettings();

      // 2. Perform test write
      await this.api.setDpelSettings({
        enable: true,
        export_limit: true,
        limit_value_W: 10000,
      });

      this.productionLimiting = true;
      this.log('Dynamic production limiting (DPEL) support verified successfully.');

      // 3. Restore original settings immediately
      const originalEnable = !!(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.enable);
      const originalExportLimit = !(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.export_limit === false);
      const originalLimit = originalSettings && originalSettings.dynamic_pel_settings && typeof originalSettings.dynamic_pel_settings.limit_value_W === 'number'
        ? originalSettings.dynamic_pel_settings.limit_value_W
        : 0;

      await this.api.setDpelSettings({
        enable: originalEnable,
        export_limit: originalExportLimit,
        limit_value_W: originalLimit,
      });

    } catch (err) {
      this.error('DPEL test write failed. Dynamic production limiting is not supported:', err.message);
      this.productionLimiting = false;

      // Try to restore original settings if we can
      try {
        const originalSettings = await this.api.getDpelSettings();
        if (originalSettings && originalSettings.dynamic_pel_settings) {
          const originalEnable = !!originalSettings.dynamic_pel_settings.enable;
          const originalExportLimit = originalSettings.dynamic_pel_settings.export_limit !== false;
          const originalLimit = originalSettings.dynamic_pel_settings.limit_value_W || 0;
          await this.api.setDpelSettings({
            enable: originalEnable,
            export_limit: originalExportLimit,
            limit_value_W: originalLimit,
          });
        }
      } catch (restoreErr) {
        // ignore restore errors
      }
    }

    await this.setStoreValue('production_limiting', this.productionLimiting).catch(this.error);
    return this.productionLimiting;
  }

}

module.exports = SolarDevice;
