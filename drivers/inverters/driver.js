'use strict';

const Homey = require('homey');

const PairingHelper = require('../../lib/PairingHelper');

class InvertersDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Enphase Inverters Driver has been initialized');

    // Register autocomplete listeners for flow cards
    this.registerFlowAutocompleteListeners();
  }

  /**
   * onPair is called when a user pairs a new Enphase Inverters device.
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    PairingHelper.setupPairingSession(this, session, {
      deviceNameKey: 'driver.inverters.name',
      deviceIdSuffix: 'inverters',
      errorPrefix: 'driver.gateway',
    });
  }

  /**
   * Register autocomplete listeners for card arguments.
   */
  registerFlowAutocompleteListeners() {
    // 1. Trigger Card: inverter_power_changed
    try {
      const powerChangedTrigger = this.homey.flow.getDeviceTriggerCard('inverter_power_changed');
      if (powerChangedTrigger) {
        powerChangedTrigger.registerArgumentAutocompleteListener('inverter_index', async (query, args) => {
          return this.resolveAutocompleteInverters(query, args.device);
        });
      }
    } catch (err) {
      this.error('Failed to register autocomplete for inverter_power_changed:', err.message);
    }

    // 2. Action Card: clear_inverter_alert
    try {
      const clearAlertAction = this.homey.flow.getActionCard('clear_inverter_alert');
      if (clearAlertAction) {
        clearAlertAction.registerArgumentAutocompleteListener('inverter_index', async (query, args) => {
          return this.resolveAutocompleteInverters(query, args.device);
        });
      }
    } catch (err) {
      this.error('Failed to register autocomplete for clear_inverter_alert:', err.message);
    }

    // 3. Trigger Card: inverter_alert_triggered
    // No registerRunListener required as there are no dropdown/filter arguments.
  }

  /**
   * Helper to resolve autocomplete list of inverters from device store.
   * @param {string} query
   * @param {Homey.Device} device
   * @returns {Promise<Array<Object>>}
   */
  async resolveAutocompleteInverters(query, device) {
    if (!device) return [];

    const serials = device.getStoreValue('inverters') || [];
    const list = [
      {
        id: 'any',
        name: this.homey.__('driver.inverters.autocomplete.any') || 'Any Inverter',
      },
      ...serials.map((serial, idx) => ({
        id: serial,
        name: `Inverter ${idx + 1} (${serial})`,
      })),
    ];

    return list.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  }

  /**
   * onRepair is called when a user repairs an Enphase Inverters device.
   * @param {Homey.PairSession} session - The repair session
   * @param {Homey.Device} device - The device instance being repaired
   */
  async onRepair(session, device) {
    this.log(`Repair session started for: ${device.getName()}`);

    // Handler to retrieve current inverters and alert threshold settings
    session.setHandler('get_repair_data', async () => {
      const settings = device.getSettings();
      const serials = device.getStoreValue('inverters') || [];
      const invertersState = device.getStoreValue('invertersData') || {};
      const activeAlerts = device.activeAlerts || {};

      const list = serials.map((serial, idx) => {
        const data = invertersState[serial] || {};
        // Find if there is any active alert for this serial
        const activeAlert = Object.values(activeAlerts).find((a) => a.serial === serial) || null;

        // Resolve localized alert details if any
        let alertDetails = null;
        if (activeAlert) {
          alertDetails = {
            type: activeAlert.type,
            message: this.homey.__(`inverters.alert.message.${activeAlert.type}`, activeAlert.messageArgs || {}),
          };
        }

        const statusCap = `inverter_status.${serial}`;
        let statusValue = 'OK';
        try {
          statusValue = device.getCapabilityValue(statusCap) || 'OK';
        } catch (err) {
          // ignore
        }

        return {
          index: idx + 1,
          serial,
          lastReportWatts: data.lastReportWatts ?? 0,
          lastReportDate: data.lastReportDate ?? 0,
          meter_power_today: data.meter_power_today ?? 0,
          maxReportWatts: data.maxReportWatts ?? 0,
          status: statusValue,
          alert: alertDetails,
        };
      });

      return {
        inverters: list,
        settings: {
          underperformanceThreshold: settings.underperformance_threshold ?? 15,
          staleTimeout: settings.stale_timeout ?? 24,
        },
      };
    });

    // Handler to save modified settings
    session.setHandler('save_settings', async (data) => {
      const { underperformanceThreshold, staleTimeout } = data;
      this.log(`Saving thresholds: Underperformance=${underperformanceThreshold}%, StaleTimeout=${staleTimeout}s`);

      await device.setSettings({
        underperformance_threshold: Number(underperformanceThreshold),
        stale_timeout: Number(staleTimeout),
      });

      return { success: true };
    });

    // Handler to clear all active alerts manually
    session.setHandler('clear_alerts', async () => {
      this.log(`Clearing all active alerts for ${device.getName()} via repair UI...`);
      await device.clearAllAlerts();
      return { success: true };
    });
  }

}

module.exports = InvertersDriver;
