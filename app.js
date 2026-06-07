'use strict';

const Homey = require('homey');
const EnvoyApi = require('./lib/EnvoyApi');

class EnphaseController extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.apiInstances = new Map();
    this.registeredDevices = new Map();
    this.pollingIntervals = new Map();
    this.firstFailedPollTimes = new Map();
    this.consecutiveMaintainerFailures = new Map();
    this.activePolls = new Set();
    this.pendingPolls = new Set();
    this._timezone = 'UTC';
    this.log('Enphase Controller has been initialized');
  }

  /**
   * Resolve the Homey Pro timezone. Refreshes each call to handle DST transitions.
   * @returns {Promise<string>} IANA timezone string (e.g. 'Europe/Amsterdam')
   */
  async getTimezone() {
    try {
      if (this.homey && this.homey.clock && typeof this.homey.clock.getTimezone === 'function') {
        this._timezone = await this.homey.clock.getTimezone();
      }
    } catch (err) {
      this.error('Failed to resolve Homey timezone:', err.message);
    }
    return this._timezone;
  }

  /**
   * Format a Unix epoch timestamp (seconds) to HH:mm string in local timezone.
   * @param {number} timestampSeconds - Unix epoch in seconds
   * @returns {Promise<string>} Formatted time string (e.g. '14:30') or '-' if falsy
   */
  async formatTimeLocal(timestampSeconds) {
    if (!timestampSeconds) return '-';
    const timezone = await this.getTimezone();
    try {
      const date = new Date(timestampSeconds * 1000);
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return formatter.format(date);
    } catch (err) {
      this.error('Failed to format timestamp with timezone:', err.message);
      const date = new Date(timestampSeconds * 1000);
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
  }

  /**
   * Get the current local day of the month based on the Homey timezone.
   * @returns {Promise<number>} Day of month (1-31)
   */
  async getLocalDayOfMonth() {
    const timezone = await this.getTimezone();
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        day: 'numeric',
      });
      return Number(formatter.format(new Date()));
    } catch (err) {
      this.error('Failed to calculate local day of month:', err.message);
      return new Date().getDate();
    }
  }

  /**
   * Get or create a shared EnvoyApi instance for a gateway serial number.
   * @param {Object} opts
   * @param {string} opts.serial - 12-digit Envoy serial number
   * @param {string} opts.ip - Local Envoy IP address
   * @param {string} [opts.userEmail] - Enlighten Email (optional fallback)
   * @param {string} [opts.password] - Enlighten Password (optional fallback)
   * @returns {EnvoyApi}
   */
  getApiInstance({
    serial,
    ip,
    userEmail,
    password,
    initialToken,
  }) {
    if (!this.apiInstances) {
      this.apiInstances = new Map();
    }

    let api = this.apiInstances.get(serial);
    if (!api) {
      this.log(`Creating new shared EnvoyApi client instance for SN ${serial}...`);

      const email = userEmail || this.homey.settings.get('user_email');
      const pass = password || this.homey.settings.get('password');

      api = new EnvoyApi({
        homey: this.homey,
        enableDiscovery: true,
        log: (msg, ...args) => this.log(`[API ${serial}] ${msg}`, ...args),
        userEmail: email,
        password: pass,
        envoySerial: serial,
        envoyIp: ip,
        initialToken: initialToken || null,
        onTokenUpdated: async (newToken) => {
          this.log(`Token updated for gateway serial: ${serial}. Saving to devices...`);

          const roleResult = api.evaluateTokenRole(newToken);
          const isNewTokenMaintainer = roleResult.isMaintainer;
          this.log(`New token evaluated. Is Maintainer: ${isNewTokenMaintainer}`);

          // Propagate new token to all envoy (legacy) devices with matching serial
          try {
            const envoyDriver = this.homey.drivers.getDriver('envoy');
            if (envoyDriver) {
              const devices = envoyDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  this.log(`Saving new token and updating role for Envoy gateway (legacy) device: ${dev.getName()}`);
                  await dev.setStoreValue('enphase_token', newToken).catch((err) => {
                    this.error(`Failed to save token to Envoy device ${dev.getName()}:`, err.message);
                  });
                  if (typeof dev.updateRole === 'function') {
                    await dev.updateRole(isNewTokenMaintainer).catch((err) => {
                      this.error(`Failed to update role for Envoy device ${dev.getName()}:`, err.message);
                    });
                  }
                }
              }
            }
          } catch (err) {
            this.log('Envoy driver not loaded or not resolved for token propagation.');
          }

          // Propagate new token to all gateway devices with matching serial
          try {
            const gatewayDriver = this.homey.drivers.getDriver('gateway');
            if (gatewayDriver) {
              const devices = gatewayDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  this.log(`Saving new token and updating role for Enphase Gateway device: ${dev.getName()}`);
                  await dev.setStoreValue('enphase_token', newToken).catch((err) => {
                    this.error(`Failed to save token to Gateway device ${dev.getName()}:`, err.message);
                  });
                  if (typeof dev.updateRole === 'function') {
                    await dev.updateRole(isNewTokenMaintainer).catch((err) => {
                      this.error(`Failed to update role for Gateway device ${dev.getName()}:`, err.message);
                    });
                  }
                }
              }
            }
          } catch (err) {
            this.log('Gateway driver not loaded or not resolved for token propagation.');
          }

          // Propagate new token to all inverters devices with matching serial
          try {
            const invertersDriver = this.homey.drivers.getDriver('inverters');
            if (invertersDriver) {
              const devices = invertersDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  this.log(`Saving new token to Enphase Inverters device: ${dev.getName()}`);
                  await dev.setStoreValue('enphase_token', newToken).catch((err) => {
                    this.error(`Failed to save token to Inverters device ${dev.getName()}:`, err.message);
                  });
                }
              }
            }
          } catch (err) {
            // Driver 'inverters' might not be registered or loaded yet
            this.log('Inverters driver not loaded yet. Skipping token sync.');
          }
        },
        onIpUpdated: async (newIp) => {
          this.log(`IP updated for gateway serial: ${serial} to ${newIp}. Propagating to devices...`);

          // Propagate new IP to all envoy (legacy) devices with matching serial
          try {
            const envoyDriver = this.homey.drivers.getDriver('envoy');
            if (envoyDriver) {
              const devices = envoyDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  if (dev.getSettings().envoy_ip !== newIp) {
                    this.log(`Updating IP setting for Envoy gateway (legacy) device: ${dev.getName()}`);
                    await dev.setSettings({ envoy_ip: newIp }).catch((err) => {
                      this.error(`Failed to update IP setting for Envoy device ${dev.getName()}:`, err.message);
                    });
                  }
                }
              }
            }
          } catch (err) {
            this.log('Envoy driver not loaded or not resolved for IP propagation.');
          }

          // Propagate new IP to all gateway devices with matching serial
          try {
            const gatewayDriver = this.homey.drivers.getDriver('gateway');
            if (gatewayDriver) {
              const devices = gatewayDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  if (dev.getSettings().envoy_ip !== newIp) {
                    this.log(`Updating IP setting for Enphase Gateway device: ${dev.getName()}`);
                    await dev.setSettings({ envoy_ip: newIp }).catch((err) => {
                      this.error(`Failed to update IP setting for Gateway device ${dev.getName()}:`, err.message);
                    });
                  }
                }
              }
            }
          } catch (err) {
            this.log('Gateway driver not loaded or not resolved for IP propagation.');
          }

          // Propagate new IP to all inverters devices with matching serial
          try {
            const invertersDriver = this.homey.drivers.getDriver('inverters');
            if (invertersDriver) {
              const devices = invertersDriver.getDevices();
              for (const dev of devices) {
                if (dev.getSettings().envoy_serial === serial) {
                  if (dev.getSettings().envoy_ip !== newIp) {
                    this.log(`Updating IP setting for Enphase Inverters device: ${dev.getName()}`);
                    await dev.setSettings({ envoy_ip: newIp }).catch((err) => {
                      this.error(`Failed to update IP setting for Inverters device ${dev.getName()}:`, err.message);
                    });
                  }
                }
              }
            }
          } catch (err) {
            this.log('Inverters driver not loaded yet. Skipping IP sync.');
          }
        },
      });

      this.apiInstances.set(serial, api);
    } else if (ip && api.envoyIp !== ip) {
      // Keep local IP up to date in case it changed via discovery
      this.log(`Updating IP for shared EnvoyApi client SN ${serial} from ${api.envoyIp} to ${ip}`);
      api.envoyIp = ip;
    }

    return api;
  }

  /**
   * Register a device (Gateway, Envoy legacy, or Inverters) for polling.
   * @param {string} serial - Gateway serial number
   * @param {Homey.Device} device - Device instance
   */
  registerDevice(serial, device) {
    if (!serial || !device) return;
    this.log(`[Manager] Registering device: ${device.getName()} for serial: ${serial}`);
    this.log(`[Manager] Device settings: ${JSON.stringify(device.getSettings())}`);

    if (!this.registeredDevices) this.registeredDevices = new Map();
    if (!this.pollingIntervals) this.pollingIntervals = new Map();
    if (!this.firstFailedPollTimes) this.firstFailedPollTimes = new Map();

    if (!this.registeredDevices.has(serial)) {
      this.registeredDevices.set(serial, new Set());
    }
    const deviceSet = this.registeredDevices.get(serial);
    deviceSet.add(device);

    this.log(`[Manager] Serial ${serial} now has ${deviceSet.size} registered device(s)`);

    // If this is the first device registered for this serial, start the polling loop
    if (deviceSet.size === 1) {
      this.log(`[Manager] Starting polling loop for serial: ${serial}`);
      this.pollGateway(serial).catch((err) => {
        this.error(`[Manager] Initial poll failed for serial ${serial}:`, err.message);
      });

      const timer = this.homey.setInterval(() => {
        this.pollGateway(serial).catch((err) => {
          this.error(`[Manager] Interval poll failed for serial ${serial}:`, err.message);
        });
      }, 120000); // 120 seconds
      this.pollingIntervals.set(serial, timer);
    } else {
      this.log(`[Manager] New device registered for serial: ${serial}. Triggering instant poll to populate telemetry.`);
      this.triggerImmediatePoll(serial).catch(this.error);
    }
  }

  /**
   * Unregister a device when it is deleted or uninitialized.
   * @param {string} serial - Gateway serial number
   * @param {Homey.Device} device - Device instance
   */
  unregisterDevice(serial, device) {
    if (!serial || !device) return;
    this.log(`[Manager] Unregistering device: ${device.getName()} for serial: ${serial}`);

    if (this.registeredDevices && this.registeredDevices.has(serial)) {
      const deviceSet = this.registeredDevices.get(serial);
      deviceSet.delete(device);
      this.log(`[Manager] Serial ${serial} has ${deviceSet.size} registered device(s) remaining`);

      if (deviceSet.size === 0) {
        this.log(`[Manager] Stopping polling loop for serial: ${serial} (no devices remaining)`);
        if (this.pollingIntervals && this.pollingIntervals.has(serial)) {
          const timer = this.pollingIntervals.get(serial);
          this.homey.clearInterval(timer);
          this.pollingIntervals.delete(serial);
        }
        if (this.firstFailedPollTimes) {
          this.firstFailedPollTimes.delete(serial);
        }
        if (this.consecutiveMaintainerFailures) {
          this.consecutiveMaintainerFailures.delete(serial);
        }
        this.registeredDevices.delete(serial);
      }
    }
  }

  /**
   * Central poll handler for a specific serial number.
   * @param {string} serial - Gateway serial number
   */
  async pollGateway(serial) {
    if (!this.activePolls) this.activePolls = new Set();
    if (!this.pendingPolls) this.pendingPolls = new Set();

    if (this.activePolls.has(serial)) {
      this.log(`[Manager] Poll already in progress for serial: ${serial}. Scheduling a pending poll on completion.`);
      this.pendingPolls.add(serial);
      return;
    }

    this.activePolls.add(serial);

    try {
      this.log(`[Manager] Polling Envoy serial: ${serial}...`);

      if (!this.registeredDevices || !this.registeredDevices.has(serial)) {
        this.log(`[Manager] No registered devices for serial: ${serial}. Skipping poll.`);
        return;
      }

      const deviceSet = this.registeredDevices.get(serial);
      if (deviceSet.size === 0) return;

      const devices = [...deviceSet];
      // Find any gateway device first to get settings
      const gatewayDev = devices.find((d) => d.driver.id === 'gateway' || d.driver.id === 'envoy');
      const representative = gatewayDev || devices[0];
      const settings = representative.getSettings();
      const token = representative.getStoreValue('enphase_token');

      // Get shared API instance
      const api = this.getApiInstance({
        serial,
        ip: settings.envoy_ip,
        userEmail: settings.user_email || this.homey.settings.get('user_email'),
        password: settings.password || this.homey.settings.get('password'),
        initialToken: token || null,
      });

      // Determine device types registered
      let hasGateway = false;
      let hasInverters = false;
      let isMaintainer = false;

      for (const dev of devices) {
        const driverId = dev.driver.id;
        if (driverId === 'gateway' || driverId === 'envoy') {
          hasGateway = true;
          if (dev.isMaintainer) {
            isMaintainer = true;
          }
        } else if (driverId === 'inverters') {
          hasInverters = true;
        }
      }

      try {
        let prodData = null;
        let powerForcedOff = false;
        let invertersData = null;

        // 1. Fetch production telemetry if Gateway device is paired
        if (hasGateway) {
          if (isMaintainer) {
            try {
              powerForcedOff = await api.getPowerForcedOffstate();
              if (this.consecutiveMaintainerFailures) {
                this.consecutiveMaintainerFailures.delete(serial);
              }
            } catch (err) {
              this.error(`[Manager] Failed to fetch power mode for serial ${serial}:`, err.message);

              if (err.message && err.message.includes('401')) {
                const fails = (this.consecutiveMaintainerFailures.get(serial) || 0) + 1;
                this.consecutiveMaintainerFailures.set(serial, fails);
                this.log(`[Manager] Consecutive power mode 401 failures for serial ${serial}: ${fails}/3`);

                if (fails >= 3) {
                  this.log(`[Manager] Threshold reached. Automatically downgrading serial ${serial} to System Owner.`);
                  for (const dev of devices) {
                    if (dev.driver.id === 'gateway' || dev.driver.id === 'envoy') {
                      if (typeof dev.updateRole === 'function') {
                        await dev.updateRole(false).catch((e) => this.error(`[Manager] Failed to demote ${dev.getName()}:`, e.message));
                      }
                    }
                  }
                  isMaintainer = false;
                }
              }
            }
          }
          prodData = await api.getProductionData();
        }

        // 2. Fetch individual inverter telemetry if Inverters device is paired
        if (hasInverters) {
          invertersData = await api.getInvertersData();
        }

        // 3. Dispatch telemetry to registered devices
        for (const dev of devices) {
          const driverId = dev.driver.id;
          if (driverId === 'gateway' || driverId === 'envoy') {
            if (prodData) {
              await dev.updateTelemetry(prodData, powerForcedOff).catch((err) => {
                this.error(`[Manager] Device ${dev.getName()} updateTelemetry failed:`, err.message);
              });
            }
          } else if (driverId === 'inverters') {
            if (invertersData) {
              await dev.updateTelemetry(invertersData).catch((err) => {
                this.error(`[Manager] Device ${dev.getName()} updateTelemetry failed:`, err.message);
              });
            }
          }
          // Mark device as available on success
          await dev.setAvailable().catch((err) => {
            this.error(`[Manager] Failed to set device ${dev.getName()} available:`, err.message);
          });
        }

        // Reset failure tracker
        if (this.firstFailedPollTimes) {
          this.firstFailedPollTimes.delete(serial);
        }
        this.log(`[Manager] Completed poll cycle for serial: ${serial}`);

      } catch (err) {
        this.error(`[Manager] Polling error for serial ${serial}:`, err.message);

        if (!this.firstFailedPollTimes.has(serial)) {
          this.firstFailedPollTimes.set(serial, new Date());
        }

        const firstFail = this.firstFailedPollTimes.get(serial);
        const elapsedMs = Date.now() - firstFail.getTime();
        const thirtyMinutesMs = 30 * 60 * 1000;

        if (elapsedMs >= thirtyMinutesMs) {
          this.log(`[Manager] Polling failure persisted for serial ${serial}. Setting all devices unavailable.`);
          for (const dev of devices) {
            await dev.setUnavailable(err.message || 'Offline').catch((e) => {
              this.error(`[Manager] Failed to set device ${dev.getName()} unavailable:`, e.message);
            });
          }
        } else {
          const remainingMinutes = Math.round((thirtyMinutesMs - elapsedMs) / 60000);
          this.log(`[Manager] Transient poll error for serial ${serial}. Devices kept online (grace period remaining: ${remainingMinutes}m).`);
        }

        // If credentials expired, clear the stored tokens
        if (err.message && (err.message.includes('login failed') || err.message.includes('verify email and password'))) {
          this.log(`[Manager] Invalid credentials detected for serial ${serial}. Clearing tokens.`);
          api.token = null;
          for (const dev of devices) {
            await dev.setStoreValue('enphase_token', null).catch((e) => {
              this.error(`[Manager] Failed to clear token in store for device ${dev.getName()}:`, e.message);
            });
          }
        }
      }
    } finally {
      this.activePolls.delete(serial);
      if (this.pendingPolls.has(serial)) {
        this.pendingPolls.delete(serial);
        this.log(`[Manager] Executing scheduled pending poll for serial: ${serial}`);
        this.pollGateway(serial).catch((err) => {
          this.error(`[Manager] Pending poll failed for serial ${serial}:`, err.message);
        });
      }
    }
  }

  /**
   * Force an immediate poll for a serial number.
   * @param {string} serial - Gateway serial number
   */
  async triggerImmediatePoll(serial) {
    if (!serial) return;
    this.log(`[Manager] Triggering immediate poll for serial: ${serial}`);
    this.pollGateway(serial).catch((err) => {
      this.error(`[Manager] Immediate poll failed for serial: ${serial}:`, err.message);
    });
  }

}

module.exports = EnphaseController;
