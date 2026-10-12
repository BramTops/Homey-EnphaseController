'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homeyStub');

const EnvoyApi = require('../lib/EnvoyApi');
const { isProductionMeterUnwired } = require('../lib/helpers');
const { classifyMeters, GatewayEnergyModel } = require('../lib/energyModel');
const SolarDevice = require('../drivers/solar/device');
const EnphaseController = require('../app');

// Gateway with a production meter that the configuration reports as enabled, but with no CT clamps behind it
// (diagnostic report de76598c, firmware D8.3.5169): the meter reads a few watts of noise while the inverters produce.
const NOW_S = Math.floor(Date.now() / 1000);
const NOW = NOW_S * 1000;
const CT_LESS_PRODUCTION = {
  production: [
    {
      type: 'inverters', activeCount: 9, readingTime: NOW_S - 5, wNow: 147, whLifetime: 5637581,
    },
    {
      type: 'eim', activeCount: 1, measurementType: 'production', readingTime: NOW_S, wNow: 2.478, whLifetime: 243174.693,
    },
  ],
  consumption: [
    {
      type: 'eim', activeCount: 0, measurementType: 'total-consumption', readingTime: NOW_S, wNow: -5.015, whLifetime: 243174.693,
    },
    {
      type: 'eim', activeCount: 0, measurementType: 'net-consumption', readingTime: NOW_S, wNow: -7.493, whLifetime: 0,
    },
  ],
};
const CT_LESS_METERS = [
  { eid: 704643328, measurementType: 'production', state: 'enabled' },
  { eid: 704643584, measurementType: 'net-consumption', state: 'disabled' },
];

function apiWith(production, metersConfig) {
  const api = Object.create(EnvoyApi.prototype);
  api.log = () => { };
  api.getMetersConfig = async () => metersConfig;
  api.getMeterReadings = async () => {
    throw new Error('readings unavailable');
  };
  api._request = async () => ({ ok: true });
  api._json = async () => production;
  return api;
}

test.describe('isProductionMeterUnwired (pairing check)', () => {
  test('meter noise while the inverters produce is an unwired meter', () => {
    assert.equal(isProductionMeterUnwired(2.478, 147), true);
    assert.equal(isProductionMeterUnwired(0, 800), true);
    assert.equal(isProductionMeterUnwired(-3, 800), true);
  });

  test('a meter that follows the inverters is wired', () => {
    assert.equal(isProductionMeterUnwired(3100, 2900), false);
    assert.equal(isProductionMeterUnwired(1500, 1500), false);
  });

  test('a reversed clamp reads a large value and is not "unwired"', () => {
    assert.equal(isProductionMeterUnwired(-2900, 2900), false);
  });

  test('inconclusive samples are never a detection (night, weak light, missing readings)', () => {
    assert.equal(isProductionMeterUnwired(0, 0), false);
    assert.equal(isProductionMeterUnwired(1, 60), false);
    assert.equal(isProductionMeterUnwired(null, 500), false);
    assert.equal(isProductionMeterUnwired(1, null), false);
    assert.equal(isProductionMeterUnwired(undefined, undefined), false);
  });

  test('thresholds: a meter reading at 10 W or 10% of the inverter total is no longer noise', () => {
    assert.equal(isProductionMeterUnwired(9.9, 5000), true);
    assert.equal(isProductionMeterUnwired(10, 5000), false);
    assert.equal(isProductionMeterUnwired(5, 100), true);
    assert.equal(isProductionMeterUnwired(10, 100), false);
  });
});

test.describe('getProductionData on a gateway with an unwired production meter', () => {
  test('default: the enabled meter wins (this is what the setting overrides)', async () => {
    const data = await apiWith(CT_LESS_PRODUCTION, CT_LESS_METERS).getProductionData();
    assert.equal(data.isMetered, true);
    assert.equal(data.wattsNow, 2.478);
    assert.equal(data.kwhLifetime, 243.174693);
    assert.equal(data.solarSource, 'eim');
    assert.equal(data.meterWatts, 2.478);
    assert.equal(data.inverterWatts, 147);
  });

  test('ignoreProductionMeter: inverter totals, unmetered, counter source follows', async () => {
    const api = apiWith(CT_LESS_PRODUCTION, CT_LESS_METERS);
    const data = await api.getProductionData({ ignoreProductionMeter: true });
    assert.equal(data.isMetered, false);
    assert.equal(data.wattsNow, 147);
    assert.equal(data.solarpowerWatts, 147);
    assert.equal(data.kwhLifetime, 5637.581);
    assert.equal(data.solarSource, 'inverters');
    assert.equal(data.connectedInverters, 9);
    assert.equal(api.lastProduction.solar.source, 'inverters');
    assert.equal(api.lastProduction.solar.w, 147);
  });

  test('checkMeterStatus passes the raw readings on for the one-off pairing check', async () => {
    const status = await apiWith(CT_LESS_PRODUCTION, CT_LESS_METERS).checkMeterStatus();
    assert.equal(status.isMetered, true);
    assert.equal(isProductionMeterUnwired(status.meterWatts, status.inverterWatts), true);
  });
});

test.describe('energy model with the production meter ignored', () => {
  test('classifyMeters: production counts as disabled, other roles are untouched', () => {
    const list = [
      { eid: 1, measurementType: 'production', state: 'enabled' },
      { eid: 2, measurementType: 'net-consumption', state: 'enabled' },
    ];
    const cfg = classifyMeters(list, { ignoreProduction: true });
    assert.deepEqual(cfg.has, { productionMeter: false, gridMeter: true, homeMeter: false });
    assert.equal(cfg.readable, true);
    assert.equal(classifyMeters(list).has.productionMeter, true);
  });

  test('a production-only configuration becomes unreadable, so the meter readings are not polled at all', () => {
    const m = new GatewayEnergyModel({ serial: '122014055302' });
    m.setMetersConfig(CT_LESS_METERS.slice(0, 1), false, NOW, { ignoreProduction: true });
    assert.equal(m.shouldReadMeters(), false);
    m.setMetersConfig(CT_LESS_METERS.slice(0, 1), false, NOW, { ignoreProduction: false });
    assert.equal(m.shouldReadMeters(), true);
  });

  test('solar comes from the slow tier (inverter totals) instead of the meter', async () => {
    const api = apiWith(CT_LESS_PRODUCTION, CT_LESS_METERS);
    await api.getProductionData({ ignoreProductionMeter: true });
    const m = new GatewayEnergyModel({ serial: '122014055302' });
    m.setMetersConfig(CT_LESS_METERS, false, NOW, { ignoreProduction: true });
    m.recordProduction(api.lastProduction, NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: null });
    assert.equal(snap.has.productionMeter, false);
    assert.equal(snap.solarW, 147);
    assert.equal(snap.fields.solarW.source, 'production');
  });
});

test.describe('scheduler flag', () => {
  test('any registered device with ignoreProductionMeter === true switches the gateway', () => {
    const ask = (devices) => EnphaseController.prototype._ignoresProductionMeter.call(
      {}, { devices: new Map(devices.map((d) => [d, {}])) },
    );
    assert.equal(ask([{}, { ignoreProductionMeter: false }]), false);
    assert.equal(ask([{}, { ignoreProductionMeter: true }]), true);
    assert.equal(ask([]), false);
  });
});

test.describe('solar daily energy baseline follows the counter source', () => {
  function fakeDevice(initialStore = {}) {
    const store = { ...initialStore };
    return {
      store,
      log() { },
      error() { },
      getStoreValue: (key) => store[key],
      async setStoreValue(key, value) {
        store[key] = value;
      },
    };
  }
  const calc = (dev, prodData, day) => SolarDevice.prototype.calculateDailyEnergy.call(dev, prodData, day);

  test('switching from the meter counter to the inverter counter re-baselines instead of reporting the difference', async () => {
    const dev = fakeDevice({ today_day: 9, today_start_kwh: 243.17, today_source: 'eim' });
    assert.equal(await calc(dev, { kwhLifetime: 5637.58, solarSource: 'inverters' }, 9), 0);
    assert.equal(dev.store.today_start_kwh, 5637.58);
    assert.equal(dev.store.today_source, 'inverters');
    assert.equal(await calc(dev, { kwhLifetime: 5638.08, solarSource: 'inverters' }, 9), 0.5);
  });

  test('a baseline saved before the source was recorded is adopted without a reset', async () => {
    const dev = fakeDevice({ today_day: 9, today_start_kwh: 100 });
    assert.equal(await calc(dev, { kwhLifetime: 102.5, solarSource: 'eim' }, 9), 2.5);
    assert.equal(dev.store.today_source, 'eim');
    assert.equal(dev.store.today_start_kwh, 100);
  });
});
