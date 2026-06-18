'use strict';

const Homey = require('homey');
const { calculateMedian, calculateTrapezoidalEnergy } = require('../../lib/helpers');

class InvertersDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('Enphase Inverters Device is being initialized...');

    const settings = this.getSettings();

    // Retrieve static inverter serials from store
    const serials = this.getStoreValue('inverters') || [];
    // Sort ascending to maintain stable order & numbering
    serials.sort((a, b) => a.localeCompare(b));
    this.log('Discovered static inverter serials:', serials);

    // Dynamic capability registration
    for (let i = 0; i < serials.length; i++) {
      const serial = serials[i];
      const idx = i + 1;

      // 1. measure_power.<serial>
      const powerCap = `measure_power.${serial}`;
      if (!this.hasCapability(powerCap)) {
        this.log(`Dynamically adding capability: ${powerCap} (Inverter ${idx})`);
        await this.addCapability(powerCap).catch((err) => {
          this.error(`Failed to add capability ${powerCap}:`, err.message);
        });
        await this.setCapabilityOptions(powerCap, {
          title: {
            en: `Inverter ${idx} Power`,
            nl: `Omvormer ${idx} Vermogen`,
          },
        }).catch((err) => {
          this.error(`Failed to set options for ${powerCap}:`, err.message);
        });
      }

      // 2. inverter_status.<serial>
      const statusCap = `inverter_status.${serial}`;
      if (!this.hasCapability(statusCap)) {
        this.log(`Dynamically adding capability: ${statusCap} (Inverter ${idx})`);
        await this.addCapability(statusCap).catch((err) => {
          this.error(`Failed to add capability ${statusCap}:`, err.message);
        });
        await this.setCapabilityOptions(statusCap, {
          title: {
            en: `Inverter ${idx} Status`,
            nl: `Omvormer ${idx} Status`,
          },
        }).catch((err) => {
          this.error(`Failed to set options for ${statusCap}:`, err.message);
        });
      }
    }

    // Load active alerts state
    this.activeAlerts = this.getStoreValue('activeAlerts') || {};
    this.log(`Loaded active alerts: ${Object.keys(this.activeAlerts).length} items`);

    // Register with App-level polling manager
    this.homey.app.registerDevice(settings.envoy_serial, this);

    // Mark device available
    await this.setAvailable();
  }

  /**
   * onUninit is called when the device is removed or the app is stopped.
   */
  async onUninit() {
    this.log('Enphase Inverters Device is being uninitialized.');
    const settings = this.getSettings();
    this.homey.app.unregisterDevice(settings.envoy_serial, this);
  }

  /**
   * Update telemetry details received from the Gateway driver.
   * Runs integrations, updates aggregate/sensor metrics, and evaluates alerts.
   * @param {Array<Object>} inverterData - Live microinverter readings
   */
  async updateTelemetry(inverterData) {
    this.log(`updateTelemetry called with ${Array.isArray(inverterData) ? inverterData.length : 'non-array'} items`);
    if (!Array.isArray(inverterData)) {
      this.error('Invalid inverter telemetry pushed: not an array.');
      return;
    }

    const serials = this.getStoreValue('inverters') || [];
    serials.sort((a, b) => a.localeCompare(b));

    // Step 1: Mismatch Detection
    const isValid = await this.validateTelemetry(inverterData, serials);
    if (!isValid) return;

    const invertersState = this.getStoreValue('invertersData') || {};
    const annualPeaks = this.getStoreValue('inverter_annual_peaks') || {};
    const currentDay = await this.homey.app.getLocalDayOfMonth();

    // Step 2: Midnight Reset & Fallback
    await this.handleNewDay(invertersState, serials, annualPeaks, currentDay);

    // Step 3: Process individual inverter readings
    const aggregates = await this.processInverterReadings(inverterData, serials, invertersState, currentDay);

    // Save updated records
    await this.setStoreValue('invertersData', invertersState);

    // Step 4: Update and save aggregate metrics
    const { averagePower } = await this.updateAggregates(
      inverterData,
      aggregates.totalWatts,
      aggregates.totalInverterLoad,
      aggregates.oldestReportTime,
      aggregates.latestReportTime,
    );

    // Step 5: Alerts engine evaluation
    const readingTime = Math.round(Date.now() / 1000);
    await this.evaluateAlerts(inverterData, readingTime, averagePower, invertersState, serials, annualPeaks);
  }

  /**
   * Validate that the telemetry contains the expected inverter serials.
   * @param {Array<Object>} inverterData
   * @param {Array<string>} serials
   * @returns {Promise<boolean>}
   */
  async validateTelemetry(inverterData, serials) {
    const incomingSerials = inverterData.map((inv) => inv.serialNumber);
    const hasMismatch = serials.length !== incomingSerials.length
      || !serials.every((s) => incomingSerials.includes(s));

    if (hasMismatch) {
      this.error(`Inverter list mismatch! Expected ${serials.length} serials but Envoy returned ${incomingSerials.length}.`);
      await this.raiseAlert('mismatch', 'mismatch', {
        expected: serials.length,
        found: incomingSerials.length,
      });
      // Set status of all dynamically registered panels to Error
      for (const s of serials) {
        await this.setCapabilityValue(`inverter_status.${s}`, 'Error').catch(this.error);
      }
      return false;
    }

    // Resolve mismatch if it was previously active
    await this.clearAlert('mismatch', 'mismatch');
    return true;
  }

  /**
   * Handle the daily limits reset at midnight, with fallback check.
   * @param {Object} invertersState
   * @param {Array<string>} serials
   * @param {Object} annualPeaks
   * @param {number} currentDay
   */
  async handleNewDay(invertersState, serials, annualPeaks, currentDay) {
    const firstSerial = serials[0];
    const isNewDay = firstSerial && invertersState[firstSerial] && invertersState[firstSerial].lastResetDay !== currentDay;

    if (isNewDay) {
      this.log('New day detected. Resetting daily limits...');

      // Fallback check: if we didn't evaluate underperformance yesterday, do it now
      const evaluatedToday = this.getStoreValue('underperfEvaluatedToday') ?? false;
      const hasBeenNonZero = this.getStoreValue('hasBeenNonZeroToday') ?? false;
      if (!evaluatedToday && hasBeenNonZero) {
        this.log('Fallback: Sunset evaluation was missed yesterday. Evaluating now...');
        await this.evaluateUnderperformance(invertersState, serials, annualPeaks, true);
      }

      // Reset daily limits
      for (const serial of serials) {
        if (invertersState[serial]) {
          const stored = invertersState[serial];
          stored.meter_power_today = 0;
          stored.dailyPeakWatts = 0;
          stored.lastResetDay = currentDay;
        }
      }
      await this.setStoreValue('underperfEvaluatedToday', false);
      await this.setStoreValue('hasBeenNonZeroToday', false);
    }
  }

  /**
   * Process individual inverter telemetry readings.
   * @param {Array<Object>} inverterData
   * @param {Array<string>} serials
   * @param {Object} invertersState
   * @param {number} currentDay
   * @returns {Promise<Object>} Aggregated totals for the readings
   */
  async processInverterReadings(inverterData, serials, invertersState, currentDay) {
    let totalWatts = 0;
    let latestReportTime = 0;
    let oldestReportTime = Infinity;
    let totalInverterLoad = 0;

    for (const inv of inverterData) {
      const serial = inv.serialNumber;
      const index = serials.indexOf(serial) + 1;
      const watts = Math.max(0, inv.lastReportWatts);
      const newReportDate = inv.lastReportDate;
      const maxWatts = inv.maxReportWatts;

      totalWatts += watts;
      if (newReportDate > latestReportTime) {
        latestReportTime = newReportDate;
      }
      if (newReportDate < oldestReportTime) {
        oldestReportTime = newReportDate;
      }

      // Retrieve stored record for energy integration and peaks
      if (!invertersState[serial]) {
        invertersState[serial] = {
          lastReportDate: 0,
          lastReportWatts: 0,
          meter_power_today: 0,
          dailyPeakWatts: 0,
          lastResetDay: currentDay,
        };
      }
      const stored = invertersState[serial];

      // Calculate inverter load percentage
      const inverterLoad = (maxWatts && maxWatts > 0) ? (watts / maxWatts) * 100 : 0;
      stored.inverter_load = Math.round(inverterLoad);
      totalInverterLoad += inverterLoad;

      // Record daily peak
      stored.dailyPeakWatts = Math.max(stored.dailyPeakWatts || 0, watts);

      // Energy integration calculation using helper
      if (newReportDate > stored.lastReportDate && stored.lastReportDate > 0) {
        const dtHours = (newReportDate - stored.lastReportDate) / 3600;
        stored.meter_power_today += calculateTrapezoidalEnergy(watts, stored.lastReportWatts, dtHours);
      }

      // Update dynamic capability values
      await this.setCapabilityValue(`measure_power.${serial}`, watts).catch(this.error);

      // Trigger power changed card
      if (watts !== stored.lastReportWatts) {
        const triggerCard = this.homey.flow.getDeviceTriggerCard('inverter_power_changed');
        if (triggerCard) {
          const tokens = {
            inverter_serial: serial,
            inverter_index: index,
            power_watts: watts,
          };
          // Specific serial
          await triggerCard.trigger(this, tokens, { inverter_index: serial }).catch(this.error);
          // 'any' wildcard
          await triggerCard.trigger(this, tokens, { inverter_index: 'any' }).catch(this.error);
        }
      }

      // Update stored record status
      stored.lastReportDate = newReportDate;
      stored.lastReportWatts = watts;
      stored.maxReportWatts = maxWatts;
    }

    return {
      totalWatts,
      latestReportTime,
      oldestReportTime,
      totalInverterLoad,
    };
  }

  /**
   * Calculate and update aggregate values.
   * @param {Array<Object>} inverterData
   * @param {number} totalWatts
   * @param {number} totalInverterLoad
   * @param {number} oldestReportTime
   * @param {number} latestReportTime
   * @returns {Promise<Object>} Aggregated average values
   */
  async updateAggregates(inverterData, totalWatts, totalInverterLoad, oldestReportTime, latestReportTime) {
    const averagePower = inverterData.length === 0 ? 0 : Math.round((totalWatts / inverterData.length) * 10) / 10;
    const averageLoad = inverterData.length === 0 ? 0 : Math.round(totalInverterLoad / inverterData.length);
    const oldestStr = oldestReportTime === Infinity ? '-' : await this.homey.app.formatTimeLocal(oldestReportTime);
    const latestStr = latestReportTime === 0 ? '-' : await this.homey.app.formatTimeLocal(latestReportTime);

    this.log(
      'Calculated aggregates: '
      + `averagePower=${averagePower}, averageLoad=${averageLoad}, `
      + `oldestStr=${oldestStr}, latestStr=${latestStr}`,
    );

    // Update aggregate capabilities
    await this.setCapabilityValue('inverters_average_power', averagePower).catch(this.error);
    await this.setCapabilityValue('inverters_average_load', averageLoad).catch(this.error);

    // Save latest and oldest updates internally in the device store
    await this.setStoreValue('inverters_latest_update', latestStr).catch(this.error);
    await this.setStoreValue('inverters_oldest_update', oldestStr).catch(this.error);

    return { averagePower, oldestStr, latestStr };
  }

  /**
   * Evaluate alerts engine rules.
   * @param {Array<Object>} inverterData
   * @param {number} readingTime
   * @param {number} averagePower
   * @param {Object} invertersState
   * @param {Array<string>} serials
   * @param {Object} annualPeaks
   */
  async evaluateAlerts(inverterData, readingTime, averagePower, invertersState, serials, annualPeaks) {
    // Sunset evaluation trigger: check underperformance immediately when power drops to 0
    const evaluatedToday = this.getStoreValue('underperfEvaluatedToday') ?? false;
    let hasBeenNonZero = this.getStoreValue('hasBeenNonZeroToday') ?? false;

    if (averagePower > 0 && !hasBeenNonZero) {
      hasBeenNonZero = true;
      await this.setStoreValue('hasBeenNonZeroToday', true);
    }

    if (hasBeenNonZero && !evaluatedToday && averagePower === 0) {
      this.log('Inverter average power became 0 for the first time today. Evaluating underperformance immediately...');
      await this.evaluateUnderperformance(invertersState, serials, annualPeaks, false);
    }

    const settings = this.getSettings();
    const staleTimeoutHours = settings.stale_timeout ?? 24;
    const staleTimeoutSeconds = staleTimeoutHours * 3600;

    for (const inv of inverterData) {
      const { serialNumber: serial, lastReportDate } = inv;

      // Rule B: Stale / Offline
      const ageSeconds = readingTime - lastReportDate;
      if (ageSeconds > staleTimeoutSeconds) {
        const hoursStale = Math.round(ageSeconds / 3600);

        await this.raiseAlert(serial, 'stale', {
          hours: String(hoursStale),
        });
      } else {
        await this.clearAlert(serial, 'stale');
      }

      // Resolve final panel status capability
      await this.updateInverterStatusCapability(serial).catch(this.error);
    }
  }

  /**
   * Evaluate underperformance alerts based on daily peak values.
   * @param {Object} invertersState - Inverter data state
   * @param {Array<string>} serials - Inverter serials
   * @param {Object} annualPeaks - Annual peaks history
   * @param {boolean} isYesterday - Whether we are evaluating yesterday's peaks (for fallback date calculation)
   */
  async evaluateUnderperformance(invertersState, serials, annualPeaks, isYesterday = false) {
    const peaks = [];
    for (const serial of serials) {
      if (invertersState[serial] && typeof invertersState[serial].dailyPeakWatts === 'number') {
        peaks.push(invertersState[serial].dailyPeakWatts);
      }
    }

    const medianPeak = calculateMedian(peaks);
    this.log(`Evaluating underperformance (isYesterday=${isYesterday}). Median peak power: ${medianPeak} W`);

    if (medianPeak > 25) {
      const settings = this.getSettings();
      const underperfThreshold = settings.underperformance_threshold ?? 15;
      for (const serial of serials) {
        const peak = invertersState[serial] ? invertersState[serial].dailyPeakWatts || 0 : 0;
        const underperformPercent = Math.round(((medianPeak - peak) / medianPeak) * 100);

        if (underperformPercent >= underperfThreshold) {
          await this.raiseAlert(serial, 'underperformance', {
            difference: String(underperformPercent),
          });
        } else {
          await this.clearAlert(serial, 'underperformance');
        }
      }
    }

    const dateOffset = isYesterday ? 86400000 : 0;
    const dateStr = new Date(Date.now() - dateOffset).toISOString().split('T')[0];

    for (const serial of serials) {
      if (invertersState[serial]) {
        const stored = invertersState[serial];
        if (!annualPeaks[serial]) {
          annualPeaks[serial] = [];
        }
        annualPeaks[serial].push({
          date: dateStr,
          maxWatts: stored.dailyPeakWatts || 0,
        });

        const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
        annualPeaks[serial] = annualPeaks[serial].filter((p) => {
          return new Date(p.date).getTime() > oneYearAgo;
        });
      }
    }

    await this.setStoreValue('inverter_annual_peaks', annualPeaks);
    await this.setStoreValue('underperfEvaluatedToday', true);
  }

  /**
   * Raise a new alert and trigger Homey flow card if it's not a duplicate.
   * @param {string} serial - Inverter serial number (or 'mismatch')
   * @param {string} type - Alert type (underperformance, stale, mismatch)
   * @param {Object} messageArgs - Localized replacement keys
   */
  async raiseAlert(serial, type, messageArgs) {
    const alertKey = `${serial}_${type}`;
    const existing = this.activeAlerts[alertKey];

    // Deduplicate: trigger flow and update state only if arguments changed
    if (!existing || JSON.stringify(existing.messageArgs) !== JSON.stringify(messageArgs)) {
      this.log(`Raising Alert: Key=${alertKey}, Args=${JSON.stringify(messageArgs)}`);

      // Compile localized text
      const message = this.homey.__(`inverters.alert.message.${type}`, messageArgs || {});

      this.activeAlerts[alertKey] = {
        serial,
        type,
        messageArgs,
        message,
        timestamp: new Date().toISOString(),
      };

      await this.setStoreValue('activeAlerts', this.activeAlerts);

      // Trigger flow card execution
      await this.triggerAlertFlow(serial, type, message);
    }
  }

  /**
   * Clear an active alert if it exists.
   * @param {string} serial - Inverter serial number
   * @param {string} type - Alert type
   */
  async clearAlert(serial, type) {
    const alertKey = `${serial}_${type}`;
    if (this.activeAlerts[alertKey]) {
      this.log(`Resolving Alert: Key=${alertKey}`);
      delete this.activeAlerts[alertKey];
      await this.setStoreValue('activeAlerts', this.activeAlerts);

      // Update capability value immediately
      if (serial === 'mismatch') {
        const serials = this.getStoreValue('inverters') || [];
        for (const s of serials) {
          await this.updateInverterStatusCapability(s).catch(this.error);
        }
      } else {
        await this.updateInverterStatusCapability(serial).catch(this.error);
      }
    }
  }

  /**
   * Clear all active alerts on the device.
   */
  async clearAllAlerts() {
    this.log(`Clearing all active alerts on device ${this.getName()}`);
    this.activeAlerts = {};
    await this.setStoreValue('activeAlerts', this.activeAlerts);

    const serials = this.getStoreValue('inverters') || [];
    for (const serial of serials) {
      await this.setCapabilityValue(`inverter_status.${serial}`, 'OK').catch(this.error);
    }
  }

  /**
   * Clear active alert for a specific inverter.
   * @param {string} serial - Inverter serial number
   */
  async clearInverterAlert(serial) {
    this.log(`Clearing active alerts for inverter ${serial} on device ${this.getName()}`);

    const keys = Object.keys(this.activeAlerts).filter((k) => k.startsWith(`${serial}_`));
    for (const k of keys) {
      delete this.activeAlerts[k];
    }
    await this.setStoreValue('activeAlerts', this.activeAlerts);
    await this.updateInverterStatusCapability(serial).catch(this.error);
  }

  /**
   * Helper to update status capability of a specific inverter based on current active alerts.
   * @param {string} serial - Inverter serial number
   */
  async updateInverterStatusCapability(serial) {
    const panelAlerts = Object.values(this.activeAlerts).filter((a) => a.serial === serial);
    if (panelAlerts.length > 0) {
      const types = panelAlerts.map((a) => a.type);
      let statusText = 'Error';
      if (types.includes('stale')) {
        statusText = 'Offline';
      } else if (types.includes('underperformance')) {
        statusText = 'Underperforming';
      }
      await this.setCapabilityValue(`inverter_status.${serial}`, statusText).catch(this.error);
    } else {
      await this.setCapabilityValue(`inverter_status.${serial}`, 'OK').catch(this.error);
    }
  }

  /**
   * Helper to trigger the alert flow card.
   */
  async triggerAlertFlow(serial, type, message) {
    const serials = this.getStoreValue('inverters') || [];
    const index = serials.indexOf(serial) !== -1 ? serials.indexOf(serial) + 1 : null;

    const triggerCard = this.homey.flow.getDeviceTriggerCard('inverter_alert_triggered');
    if (triggerCard) {
      const tokens = {
        inverter_serial: serial === 'mismatch' ? '' : serial,
        inverter_index: index,
        alert_type: type,
        alert_message: message,
      };

      this.log('triggerAlertFlow triggering with tokens:', JSON.stringify(tokens));

      // Trigger card
      await triggerCard.trigger(this, tokens, { alert_type: type }).catch((err) => {
        this.error('Failed to trigger alert flow card:', err.message);
      });
    }
  }

}

module.exports = InvertersDevice;
