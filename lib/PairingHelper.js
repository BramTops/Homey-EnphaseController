'use strict';

const dgram = require('dgram');
const EnvoyApi = require('./EnvoyApi');

/**
 * Direct mDNS scanning fallback via raw UDP sockets to bypass Homey's built-in discovery limitations.
 * Performs dual-stack IPv4 and IPv6 queries in parallel to support diverse network setups.
 */
function scanMdnsDirect(log, error, homey) {
  return new Promise((resolve) => {
    log('Starting direct dual-stack mDNS scan fallback...');

    let clientV4;
    let clientV6;
    let resolved = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        if (homey) {
          homey.clearTimeout(timer);
        } else {
          clearTimeout(timer);
        }
        timer = null;
      }
      if (clientV4) {
        try {
          clientV4.close();
        } catch (e) {}
      }
      if (clientV6) {
        try {
          clientV6.close();
        } catch (e) {}
      }
    };

    const handleMessage = (msg, rinfo, family) => {
      try {
        const cleanStr = msg.toString('ascii').replace(/[^a-zA-Z0-9\-_=. \s]/g, '.');
        log(`Direct mDNS scan [${family}] received response from [${rinfo.address}]:${rinfo.port}`);

        const serialMatch = cleanStr.match(/\b\d{12}\b/);
        if (serialMatch) {
          const serial = serialMatch[0];
          const ip = rinfo.address;
          log(`Direct mDNS scan [${family}] resolved: IP="${ip}", Serial="${serial}"`);
          resolved = true;
          cleanup();
          resolve({ ip, serial });
        }
      } catch (err) {
        error(`Error parsing direct mDNS [${family}] response:`, err.message);
      }
    };

    // Construct standard PTR query for _enphase-envoy._tcp.local
    const serviceName = '_enphase-envoy._tcp.local';
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // Questions count = 1

    const labels = serviceName.split('.');
    const parts = [];
    for (const label of labels) {
      const buf = Buffer.alloc(1 + label.length);
      buf.writeUInt8(label.length, 0);
      buf.write(label, 1);
      parts.push(buf);
    }
    const qname = Buffer.concat([...parts, Buffer.from([0])]);
    const qtypeClass = Buffer.alloc(4);
    qtypeClass.writeUInt16BE(12, 0); // QTYPE = PTR (12)
    qtypeClass.writeUInt16BE(1, 2); // QCLASS = IN (1)

    const query = Buffer.concat([header, qname, qtypeClass]);

    // Setup IPv4 client (Multicast IP: 224.0.0.251)
    try {
      clientV4 = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      clientV4.on('message', (msg, rinfo) => handleMessage(msg, rinfo, 'IPv4'));
      clientV4.on('error', (err) => {
        error('Direct mDNS IPv4 socket error:', err.message);
      });
      clientV4.bind(0, () => {
        try {
          clientV4.send(query, 0, query.length, 5353, '224.0.0.251');
        } catch (err) {
          error('Failed to send direct IPv4 mDNS query:', err.message);
        }
      });
    } catch (err) {
      error('Failed to create udp4 socket:', err.message);
    }

    // Setup IPv6 client (Multicast IP: ff02::fb)
    try {
      clientV6 = dgram.createSocket({ type: 'udp6', reuseAddr: true });
      clientV6.on('message', (msg, rinfo) => handleMessage(msg, rinfo, 'IPv6'));
      clientV6.on('error', (err) => {
        error('Direct mDNS IPv6 socket error:', err.message);
      });
      clientV6.bind(0, () => {
        try {
          clientV6.send(query, 0, query.length, 5353, 'ff02::fb');
        } catch (err) {
          error('Failed to send direct IPv6 mDNS query:', err.message);
        }
      });
    } catch (err) {
      error('Failed to create udp6 socket:', err.message);
    }

    const timerCallback = () => {
      if (!resolved) {
        log('Direct mDNS scan timeout.');
        cleanup();
        resolve(null);
      }
    };

    if (homey) {
      timer = homey.setTimeout(timerCallback, 2500);
    } else {
      // eslint-disable-next-line homey-app/global-timers
      timer = setTimeout(timerCallback, 2500);
    }
  });
}

/**
 * Configure standard pairing session handlers for Envoy/Gateway/Inverter drivers.
 * @param {Object} context - Object containing homey, log, error, discovery strategy, and device-specific options
 * @param {Homey.PairSession} session - The pairing session
 * @param {Object} options - Custom overrides (e.g. deviceNameKey, deviceIdSuffix, errorKeys)
 */
function setupPairingSession(context, session, options = {}) {
  const { homey, log, error } = context;
  const {
    deviceNameKey = 'driver.gateway.name',
    deviceIdSuffix = '',
    errorPrefix = 'driver.gateway',
  } = options;

  log('Pairing session started (shared helper)...');
  let pairedDeviceData = null;

  // Register active mDNS discovery listener for real-time frontend auto-detection updates
  const discoveryStrategy = context.getDiscoveryStrategy();
  let discoveryResultListener = null;

  if (discoveryStrategy) {
    log('Pair session: registering result listener to feed pairing screen...');

    discoveryResultListener = (result) => {
      if (!result) return;
      log('Pair session: received live discovery advertisement:', JSON.stringify(result));

      const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
      log(`Pair session: parsed live advertisement: IP="${ip}", Serial="${serial}"`);

      if (ip || serial) {
        log(`Pair session discovery update: IP="${ip}", Serial="${serial}"`);
        session.emit('discovery_update', {
          ip,
          serial,
        }).catch((err) => {
          error('Failed to emit discovery update to pairing screen:', err.message);
        });
      }
    };

    discoveryStrategy.on('result', discoveryResultListener);

    // Also trigger direct IPv6 multicast query to speed up detection if Homey's client is laggy
    scanMdnsDirect(log, error, homey).then((directResult) => {
      if (directResult && directResult.ip && directResult.serial) {
        log(`Direct scan auto-fill: IP="${directResult.ip}", Serial="${directResult.serial}"`);
        session.emit('discovery_update', {
          ip: directResult.ip,
          serial: directResult.serial,
        }).catch((err) => {
          error('Failed to emit direct discovery update:', err.message);
        });
      }
    }).catch((err) => {
      error('Direct scan failed:', err.message);
    });
  }

  // Clean up dynamic discovery listener when pairing session closes
  session.setHandler('disconnect', async () => {
    log('Pairing session disconnected.');
    if (discoveryStrategy && discoveryResultListener) {
      discoveryStrategy.removeListener('result', discoveryResultListener);
      log('Removed dynamic pairing discovery result listener.');
    }
  });

  // Handler to send the auto-discovered parameters to the HTML view
  session.setHandler('get_discovered_ip', async () => {
    log('Performing auto-detection for Envoy IP using discovery strategy...');

    let discoveredIp = '';
    let discoveredSerial = '';
    let discoveryResults = {};

    try {
      if (discoveryStrategy) {
        discoveryResults = discoveryStrategy.getDiscoveryResults();
        log('Raw getDiscoveryResults:', JSON.stringify(discoveryResults));
      } else {
        log('Discovery strategy is not available (returned null).');
      }
    } catch (err) {
      error('Failed to retrieve discovery strategy or results:', err.message);
    }

    for (const result of Object.values(discoveryResults)) {
      if (result) {
        log('Discovered mDNS entry:', JSON.stringify(result));
        const { ip, serial } = EnvoyApi.parseDiscoveryResult(result);
        if (ip || serial) {
          discoveredIp = ip;
          discoveredSerial = serial;
          log(`Auto-detection resolved: IP="${discoveredIp}", Serial="${discoveredSerial}"`);
          break;
        }
      }
    }

    // Fallback: If not found via built-in discovery, run direct mDNS scan
    if (!discoveredIp && !discoveredSerial) {
      const directResult = await scanMdnsDirect(log, error, homey);
      if (directResult) {
        discoveredIp = directResult.ip;
        discoveredSerial = directResult.serial;
      }
    }

    // Fallback 2: Check if there are other paired devices we can copy IP/serial from
    if (!discoveredIp && !discoveredSerial) {
      for (const driverId of ['gateway', 'inverters', 'homeload']) {
        try {
          const driver = homey.drivers.getDriver(driverId);
          if (driver) {
            const devices = driver.getDevices();
            for (const dev of devices) {
              const settings = dev.getSettings();
              if (settings.envoy_ip && settings.envoy_serial) {
                discoveredIp = settings.envoy_ip;
                discoveredSerial = settings.envoy_serial;
                log(`Reusing settings from paired ${driverId} device: IP="${discoveredIp}", Serial="${discoveredSerial}"`);
                break;
              }
            }
          }
          if (discoveredIp && discoveredSerial) break;
        } catch (err) {
          // ignore
        }
      }
    }

    return {
      ip: discoveredIp || '',
      serial: discoveredSerial || '',
    };
  });

  // Handler to retrieve cached credentials from global settings
  session.setHandler('get_cached_credentials', async () => {
    const email = homey.settings.get('user_email') || '';
    const password = homey.settings.get('password') || '';
    return {
      user_email: email,
      password,
    };
  });

  // Handler to authenticate and verify roles
  session.setHandler('login', async (data) => {
    const {
      user_email: userEmail,
      password,
      envoy_serial: envoySerial,
      envoy_ip: envoyIp,
    } = data;

    if (!userEmail || !password || !envoySerial || !envoyIp) {
      throw new Error(homey.__(`${errorPrefix}.error.fields_required`));
    }

    if (!/^\d{12}$/.test(envoySerial)) {
      throw new Error(homey.__(`${errorPrefix}.error.invalid_serial`));
    }

    log(`Attempting login for email: ${userEmail}, Serial: ${envoySerial}, IP: ${envoyIp}`);

    // Create a temporary API client to test credentials with the provided IP
    const api = new EnvoyApi({
      log: (msg, ...args) => log(`[API Temp] ${msg}`, ...args),
      userEmail,
      password,
      envoySerial,
      envoyIp,
    });

    try {
      // Fetch a new token to verify credentials and get the JWT
      const token = await api.fetchNewToken();
      log('Token fetched successfully during pairing.');

      // Verify local connection and authenticate with Envoy using JWT
      log('Testing local connection and authentication with Envoy gateway...');
      await api.getSessionCookie(token, true);
      log('Local connection and Envoy authentication verified successfully.');

      // Fetch inverters serial numbers during pairing
      log('Fetching microinverters list during pairing verification...');
      let inverterSerials = [];
      try {
        const invertersData = await api.getInvertersData();
        inverterSerials = invertersData.map((inv) => inv.serialNumber);
        log(`Successfully discovered ${inverterSerials.length} inverters during pairing.`);
      } catch (err) {
        error('Failed to retrieve microinverters during pairing verification:', err.message);
      }

      // Check meter status during pairing
      let isMetered = false;
      let hasGridpower = false;
      let hasHomepower = false;
      try {
        const meterStatus = await api.checkMeterStatus();
        isMetered = meterStatus.isMetered;
        hasGridpower = meterStatus.hasGridpower;
        hasHomepower = meterStatus.hasHomepower;
      } catch (err) {
        error('Failed to check meter status during pairing verification:', err.message);
      }

      // Decode the JWT to verify roles using the Envoy API helper method
      const tokenRoleResult = api.evaluateTokenRole(token);
      const { isMaintainer } = tokenRoleResult;
      log(`Token evaluation completed. Is Maintainer: ${isMaintainer}`);

      // Check dynamic production export limiting (DPEL) support during pairing
      let productionLimiting = false;
      if (isMetered && isMaintainer) {
        log('Testing dynamic production limiting (DPEL) support during pairing verification...');
        try {
          const originalSettings = await api.getDpelSettings();
          log('Envoy active settings fetched. Sending test write request...');
          await api.setDpelSettings({
            enable: true,
            export_limit: true,
            limit_value_W: 10000,
          });
          productionLimiting = true;
          log('Dynamic production limiting (DPEL) test write succeeded.');

          // Restore original settings immediately
          const originalEnable = !!(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.enable);
          const originalExportLimit = !(originalSettings && originalSettings.dynamic_pel_settings && originalSettings.dynamic_pel_settings.export_limit === false);
          const originalLimit = originalSettings && originalSettings.dynamic_pel_settings && typeof originalSettings.dynamic_pel_settings.limit_value_W === 'number'
            ? originalSettings.dynamic_pel_settings.limit_value_W
            : 0;

          log(`Restoring original settings: enable=${originalEnable}, exportLimit=${originalExportLimit}, limit=${originalLimit}W...`);
          await api.setDpelSettings({
            enable: originalEnable,
            export_limit: originalExportLimit,
            limit_value_W: originalLimit,
          });
          log('Original settings restored.');
        } catch (err) {
          error('DPEL test write failed. Dynamic production limiting is not supported on this gateway:', err.message);
          productionLimiting = false;

          // Attempt to restore original settings if the error occurred after a successful write
          try {
            const originalSettings = await api.getDpelSettings();
            if (originalSettings && originalSettings.dynamic_pel_settings) {
              const originalEnable = !!originalSettings.dynamic_pel_settings.enable;
              const originalExportLimit = originalSettings.dynamic_pel_settings.export_limit !== false;
              const originalLimit = originalSettings.dynamic_pel_settings.limit_value_W || 0;
              await api.setDpelSettings({
                enable: originalEnable,
                export_limit: originalExportLimit,
                limit_value_W: originalLimit,
              });
            }
          } catch (restoreErr) {
            // ignore
          }
        }
      }

      // Keep device data in memory for the list_devices step
      pairedDeviceData = {
        name: homey.__(deviceNameKey),
        data: {
          id: deviceIdSuffix ? `${envoySerial}_${deviceIdSuffix}` : envoySerial,
        },
        settings: {
          user_email: userEmail,
          password,
          envoy_serial: envoySerial,
          envoy_ip: envoyIp,
        },
        store: {
          enphase_token: token,
          is_maintainer: isMaintainer,
          inverters: inverterSerials,
          is_metered: isMetered,
          has_gridpower: hasGridpower,
          has_homepower: hasHomepower,
          production_limiting: productionLimiting,
        },
      };

      // Return role status and meter information back to frontend
      return {
        success: true,
        isMaintainer,
        isMetered,
        hasGridpower,
        hasHomepower,
        productionLimiting,
      };

    } catch (err) {
      error('Authentication test failed during pairing:', err.message);
      throw new Error(homey.__(`${errorPrefix}.error.auth_failed`, { message: err.message }));
    }
  });

  // Handler to return list of devices to pair
  session.setHandler('list_devices', async () => {
    if (!pairedDeviceData) {
      throw new Error('No device was successfully authenticated yet.');
    }

    log('Saving authentication credentials globally to App settings...');
    await homey.settings.set('user_email', pairedDeviceData.settings.user_email);
    await homey.settings.set('password', pairedDeviceData.settings.password);

    log('Adding devices to Homey...');

    const deviceObj = {
      name: pairedDeviceData.name,
      data: pairedDeviceData.data,
      settings: {
        envoy_serial: pairedDeviceData.settings.envoy_serial,
        envoy_ip: pairedDeviceData.settings.envoy_ip,
      },
      store: pairedDeviceData.store,
    };

    return [deviceObj];
  });
}

module.exports = {
  setupPairingSession,
  scanMdnsDirect,
};
