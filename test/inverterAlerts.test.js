'use strict';

// Inverter list validation and the alert Flow trigger tokens. Field case (2.0.4): a restarting gateway returned an
// empty inverter list, which raised a false mismatch, and the mismatch trigger failed because inverter_index was null.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homeyStub');

const InvertersDevice = require('../drivers/inverters/device');

function fakeDevice(store = {}) {
  const triggers = [];
  const statuses = [];
  const dev = {
    store: { ...store },
    triggers,
    statuses,
    activeAlerts: {},
    log() { },
    error() { },
    getStoreValue(key) {
      return dev.store[key];
    },
    async setStoreValue(key, value) {
      dev.store[key] = value;
    },
    async setInverterStatus(serial, status) {
      statuses.push([serial, status]);
    },
    updateInverterStatusCapability: async () => { },
    homey: {
      __: (key) => key,
      flow: {
        getDeviceTriggerCard: (id) => ({
          trigger: async (device, tokens, state) => {
            triggers.push({ id, tokens, state });
          },
        }),
      },
    },
  };
  dev.raiseAlert = InvertersDevice.prototype.raiseAlert.bind(dev);
  dev.clearAlert = InvertersDevice.prototype.clearAlert.bind(dev);
  dev.triggerAlertFlow = InvertersDevice.prototype.triggerAlertFlow.bind(dev);
  return dev;
}

const validate = (dev, data, serials) => InvertersDevice.prototype.validateTelemetry.call(dev, data, serials);
const reading = (serialNumber) => ({ serialNumber });

test.describe('inverters validateTelemetry', () => {
  test('an empty list from the gateway skips the poll without an alert or status change', async () => {
    const dev = fakeDevice({ inverters: ['A', 'B'] });
    assert.equal(await validate(dev, [], ['A', 'B']), false);
    assert.deepEqual(dev.activeAlerts, {});
    assert.deepEqual(dev.triggers, []);
    assert.deepEqual(dev.statuses, []);
  });

  test('a non-empty list that does not match raises a mismatch with a numeric inverter_index of 0', async () => {
    const dev = fakeDevice({ inverters: ['A', 'B'] });
    assert.equal(await validate(dev, [reading('A')], ['A', 'B']), false);
    assert.ok(dev.activeAlerts.mismatch_mismatch);
    assert.equal(dev.triggers.length, 1);
    assert.equal(dev.triggers[0].id, 'inverter_alert_triggered');
    assert.equal(dev.triggers[0].tokens.inverter_index, 0);
    assert.equal(dev.triggers[0].tokens.inverter_serial, '');
    assert.deepEqual(dev.statuses, [['A', 'Error'], ['B', 'Error']]);
  });

  test('a matching list is valid', async () => {
    const dev = fakeDevice({ inverters: ['A', 'B'] });
    assert.equal(await validate(dev, [reading('B'), reading('A')], ['A', 'B']), true);
  });
});

test.describe('inverters triggerAlertFlow', () => {
  test('an alert for a known inverter carries its 1-based position', async () => {
    const dev = fakeDevice({ inverters: ['A', 'B', 'C'] });
    await dev.triggerAlertFlow('C', 'stale', 'msg');
    assert.equal(dev.triggers[0].tokens.inverter_index, 3);
    assert.equal(dev.triggers[0].tokens.inverter_serial, 'C');
  });

  test('inverter_index is always a number', async () => {
    const dev = fakeDevice({ inverters: ['A'] });
    await dev.triggerAlertFlow('mismatch', 'mismatch', 'msg');
    await dev.triggerAlertFlow('unknown', 'stale', 'msg');
    for (const t of dev.triggers) assert.equal(typeof t.tokens.inverter_index, 'number');
  });
});
