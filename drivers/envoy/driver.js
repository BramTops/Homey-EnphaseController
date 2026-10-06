'use strict';

const Homey = require('homey');

const PairingHelper = require('../../lib/PairingHelper');

class EnvoyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Envoy Driver has been initialized');
  }

  /**
   * onPair is called when a user pairs a new Envoy device.
   * @param {Homey.PairSession} session - The pairing session
   */
  async onPair(session) {
    PairingHelper.setupPairingSession(this, session, {
      deviceNameKey: 'driver.envoy.name',
      errorPrefix: 'driver.envoy',
    });
  }

}

module.exports = EnvoyDriver;
