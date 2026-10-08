'use strict';

const Homey = require('homey');

const PairingHelper = require('../../lib/PairingHelper');

class BatteryDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Enphase Battery Driver has been initialized');
  }

  /**
   * onPair is called when a user pairs a new Enphase Battery device.
   * Read-only: pairing never writes production/storage settings. Battery presence is probed read-only and a missing or
   * undetectable battery only produces a warning (pairing is never blocked).
   * No repair flow: the device uses the same credential/IP settings keys as the other drivers, so they can be edited in
   * the device settings.
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    PairingHelper.setupPairingSession(this, session, {
      deviceNameKey: 'driver.battery.name',
      deviceIdSuffix: 'battery',
      errorPrefix: 'driver.battery',
      allowProductionLimitProbe: false,
      blockLegacySolar: false,
      probeBattery: true,
      reuseKey: 'battery',
    });
  }

}

module.exports = BatteryDriver;
