'use strict';

const Homey = require('homey');

class EnphaseController extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Enphase Controller has been initialized');
  }

}

module.exports = EnphaseController;
