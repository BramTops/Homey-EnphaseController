'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const EnvoyApi = require('../lib/EnvoyApi');
const { classifyMeters } = require('../lib/energyModel');

// getProductionData() and checkMeterStatus() mix HTTP and parsing. The tests build an instance without the
// constructor (no Homey, no discovery) and replace only the three request methods with fixtures.

const NOW_S = Math.floor(Date.now() / 1000);

function apiWith({ production, metersConfig = null, readings = null }) {
  const api = Object.create(EnvoyApi.prototype);
  api.log = () => { };
  api.getMetersConfig = async () => metersConfig;
  api.getMeterReadings = async () => {
    if (readings === null) throw new Error('readings unavailable');
    return readings;
  };
  api._request = async () => ({ ok: true });
  api._json = async () => production;
  return api;
}

const meter = (eid, measurementType, state = 'enabled') => ({ eid, measurementType, state });

// Shape of /production.json on a metered gateway with production and consumption CTs
const METERED_PRODUCTION = {
  production: [
    {
      type: 'inverters', activeCount: 12, readingTime: NOW_S - 30, wNow: 2900, whLifetime: 8000000,
    },
    {
      type: 'eim', activeCount: 1, measurementType: 'production', readingTime: NOW_S - 5, wNow: 3100.5, whLifetime: 9000000,
    },
  ],
  consumption: [
    {
      type: 'eim', measurementType: 'total-consumption', readingTime: NOW_S - 5, wNow: 1800, whLifetime: 20000000,
    },
    {
      type: 'eim', measurementType: 'net-consumption', readingTime: NOW_S - 5, wNow: -1300, whLifetime: 1000000,
    },
  ],
};

// Gateway without CTs: only the inverters section
const UNMETERED_PRODUCTION = {
  production: [{
    type: 'inverters', activeCount: 8, readingTime: NOW_S - 60, wNow: 1500, whLifetime: 4000000,
  }],
  consumption: [],
};

test.describe('getProductionData', () => {
  test('metered gateway: eim section wins over inverters and keeps the legacy shape', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: [meter(1, 'production'), meter(2, 'net-consumption'), meter(3, 'total-consumption')],
    });
    const data = await api.getProductionData();
    assert.equal(data.isMetered, true);
    assert.equal(data.wattsNow, 3100.5);
    assert.equal(data.solarpowerWatts, 3100.5);
    assert.equal(data.kwhLifetime, 9000);
    assert.equal(data.solarpowerKwhLifetime, 9000);
    assert.equal(data.connectedInverters, 12);
    assert.equal(data.hasGridpower, true);
    assert.equal(data.hasHomepower, true);
    assert.equal(data.gridpowerWatts, -1300);
    assert.equal(data.gridpowerKwhImported, 1000);
    assert.equal(data.homepowerWatts, 1800);
    assert.equal(data.homepowerKwhImported, 20000);
    // The legacy export counters only come from the readings enrichment
    assert.equal(data.gridpowerKwhExported, 0);
    assert.equal(data.homepowerKwhExported, 0);
  });

  test('records per-section detail with reading times for the energy model', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: [meter(1, 'production'), meter(2, 'net-consumption'), meter(3, 'total-consumption')],
    });
    await api.getProductionData();
    const detail = api.lastProduction;
    assert.equal(detail.solar.source, 'eim');
    assert.equal(detail.solar.kWh, 9000);
    assert.equal(detail.solar.observedAt, (NOW_S - 5) * 1000);
    assert.equal(detail.grid.w, -1300);
    assert.equal(detail.grid.exportKWh, null); // production.json has no export counter
    assert.equal(detail.home.importKWh, 20000);
  });

  test('unmetered gateway falls back to the inverters section', async () => {
    const api = apiWith({ production: UNMETERED_PRODUCTION, metersConfig: [] });
    const data = await api.getProductionData();
    assert.equal(data.isMetered, false);
    assert.equal(data.wattsNow, 1500);
    assert.equal(data.kwhLifetime, 4000);
    assert.equal(data.hasGridpower, false);
    assert.equal(data.hasHomepower, false);
    assert.equal(api.lastProduction.solar.source, 'inverters');
    assert.equal(api.lastProduction.grid, null);
  });

  test('a production CT that is configured but disabled is not metered even when an eim entry exists', async () => {
    const api = apiWith({ production: METERED_PRODUCTION, metersConfig: [meter(1, 'production', 'disabled')] });
    const data = await api.getProductionData();
    assert.equal(data.isMetered, false);
    assert.equal(data.wattsNow, 2900);
    assert.equal(api.lastProduction.solar.source, 'inverters');
  });

  test('without a meters configuration, metering is inferred from a populated eim section', async () => {
    const api = apiWith({ production: METERED_PRODUCTION, metersConfig: null });
    const data = await api.getProductionData();
    assert.equal(data.isMetered, true);
    assert.equal(data.hasGridpower, true);
    assert.equal(data.hasHomepower, true);
  });

  test('negative production watts are clamped to zero', async () => {
    const production = {
      production: [{
        type: 'eim', readingTime: NOW_S, wNow: -4, whLifetime: 1000,
      }, { type: 'inverters', wNow: 0, whLifetime: 900 }],
    };
    const api = apiWith({ production, metersConfig: [meter(1, 'production')] });
    assert.equal((await api.getProductionData()).wattsNow, 0);
  });

  test('/ivp/meters/readings enrichment supplies the import/export counters and overrides production.json', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: [meter(1, 'production'), meter(2, 'net-consumption'), meter(3, 'total-consumption')],
      readings: [
        {
          eid: 2, activePower: -1250, actEnergyDlvd: 1500000, actEnergyRcvd: 7000000,
        },
        {
          eid: 3, activePower: 1750, actEnergyDlvd: 21000000, actEnergyRcvd: 3000,
        },
      ],
    });
    const data = await api.getProductionData();
    assert.equal(data.gridpowerKwhImported, 1500);
    assert.equal(data.gridpowerKwhExported, 7000);
    assert.equal(data.gridpowerWatts, -1250);
    assert.equal(data.homepowerKwhImported, 21000);
    assert.equal(data.homepowerKwhExported, 3);
    // The energy model detail keeps the production.json values; enrichment only affects the legacy shape.
    assert.equal(api.lastProduction.grid.w, -1300);
  });

  test('a failing readings request falls back to production.json values', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: [meter(1, 'production'), meter(2, 'net-consumption'), meter(3, 'total-consumption')],
      readings: null,
    });
    const data = await api.getProductionData();
    assert.equal(data.gridpowerKwhImported, 1000);
    assert.equal(data.hasGridpower, true);
  });

  test('generic consumption meter (older firmware) counts as both grid and home in the legacy path', async () => {
    const api = apiWith({
      production: { production: UNMETERED_PRODUCTION.production, consumption: [] },
      metersConfig: [meter(1, 'production', 'disabled'), meter(9, 'consumption')],
      readings: [{
        eid: 9, activePower: 640, actEnergyDlvd: 5000, actEnergyRcvd: 1000,
      }],
    });
    const data = await api.getProductionData();
    assert.equal(data.hasGridpower, true);
    assert.equal(data.hasHomepower, true);
    assert.equal(data.gridpowerKwhImported, 5);
    assert.equal(data.homepowerKwhImported, 5);
  });

  test('a response without a production array is an error', async () => {
    const api = apiWith({ production: { consumption: [] } });
    await assert.rejects(() => api.getProductionData(), /production array/);
  });
});

test.describe('checkMeterStatus', () => {
  test('/ivp/meters refines the production.json result per role', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: [meter(1, 'production'), meter(2, 'net-consumption', 'disabled'), meter(3, 'total-consumption')],
    });
    assert.deepEqual(await api.checkMeterStatus(), { isMetered: true, hasGridpower: false, hasHomepower: true });
  });

  test('a generic consumption meter switches both grid and home on or off together', async () => {
    const on = apiWith({ production: UNMETERED_PRODUCTION, metersConfig: [meter(9, 'consumption')] });
    assert.deepEqual(await on.checkMeterStatus(), { isMetered: false, hasGridpower: true, hasHomepower: true });
    const off = apiWith({ production: METERED_PRODUCTION, metersConfig: [meter(9, 'consumption', 'disabled')] });
    const status = await off.checkMeterStatus();
    assert.equal(status.hasGridpower, false);
    assert.equal(status.hasHomepower, false);
  });
});

// The generic `consumption` CT (older firmware) is interpreted by four rule sets today. These tests pin where they
// disagree for the same /ivp/meters list so that stage 6 changes them deliberately:
//   1. getProductionData() config rules: a typed meter wins for its own role, the generic one fills in otherwise
//   2. getProductionData() readings enrichment: any enabled meter of a grid/home type (generic included) forces the flag on
//   3. checkMeterStatus(): an existing generic meter overrides the typed ones, in both directions
//   4. classifyMeters() (energy model, new snapshot): the generic meter is ambiguous (null) and never decides a role
test.describe('generic consumption meter: rule sets disagree', () => {
  const typedOnGenericOff = [meter(2, 'net-consumption'), meter(9, 'consumption', 'disabled')];
  const typedOffGenericOn = [meter(2, 'net-consumption', 'disabled'), meter(9, 'consumption')];

  test('enabled typed net meter + disabled generic meter: checkMeterStatus turns grid off, getProductionData keeps it on', async () => {
    const production = await apiWith({ production: METERED_PRODUCTION, metersConfig: typedOnGenericOff }).getProductionData();
    assert.equal(production.hasGridpower, true);
    assert.equal(production.hasHomepower, false);
    const status = await apiWith({ production: METERED_PRODUCTION, metersConfig: typedOnGenericOff }).checkMeterStatus();
    assert.equal(status.hasGridpower, false); // the generic meter overrides the typed one
    assert.equal(status.hasHomepower, false);
    assert.equal(classifyMeters(typedOnGenericOff).has.gridMeter, true);
  });

  test('disabled typed net meter + enabled generic meter: checkMeterStatus turns grid on, getProductionData and the model keep it off/ambiguous', async () => {
    const production = await apiWith({ production: METERED_PRODUCTION, metersConfig: typedOffGenericOn }).getProductionData();
    assert.equal(production.hasGridpower, false); // typed meter wins in the config rules
    assert.equal(production.hasHomepower, true); // no typed total meter in the config: the generic one fills in
    const status = await apiWith({ production: METERED_PRODUCTION, metersConfig: typedOffGenericOn }).checkMeterStatus();
    assert.equal(status.hasGridpower, true);
    assert.equal(status.hasHomepower, true);
    const { has } = classifyMeters(typedOffGenericOn);
    assert.equal(has.gridMeter, false);
    assert.equal(has.homeMeter, null);
  });

  test('config rules alone: an enabled generic meter fills in grid and home when no typed meter is configured', async () => {
    // Fixture without consumption entries and without readings, so neither the production.json fallback nor the
    // readings enrichment can produce the flags.
    const api = apiWith({ production: UNMETERED_PRODUCTION, metersConfig: [meter(9, 'consumption')], readings: null });
    const data = await api.getProductionData();
    assert.equal(data.hasGridpower, true);
    assert.equal(data.hasHomepower, true);
  });

  test('readings enrichment forces hasHomepower on for an enabled generic meter even when the typed total meter is disabled', async () => {
    const config = [meter(3, 'total-consumption', 'disabled'), meter(9, 'consumption')];
    const without = await apiWith({ production: UNMETERED_PRODUCTION, metersConfig: config, readings: null }).getProductionData();
    assert.equal(without.hasHomepower, false); // typed meter wins in the config rules
    const data = await apiWith({
      production: UNMETERED_PRODUCTION,
      metersConfig: config,
      readings: [{
        eid: 9, activePower: 640, actEnergyDlvd: 5000, actEnergyRcvd: 1000,
      }],
    }).getProductionData();
    assert.equal(data.hasHomepower, true);
    assert.equal(data.homepowerKwhImported, 5);
    assert.equal(data.homepowerKwhExported, 1);
  });

  test('readings enrichment forces hasGridpower on for an enabled generic meter even when the typed net meter is disabled', async () => {
    const api = apiWith({
      production: METERED_PRODUCTION,
      metersConfig: typedOffGenericOn,
      readings: [{
        eid: 9, activePower: 640, actEnergyDlvd: 5000, actEnergyRcvd: 1000,
      }],
    });
    const data = await api.getProductionData();
    assert.equal(data.hasGridpower, true);
    assert.equal(data.gridpowerKwhImported, 5);
    assert.equal(data.gridpowerKwhExported, 1);
  });
});

test.describe('parseDiscoveryResult', () => {
  test('prefers a 12-digit result.id and an IPv4 address', () => {
    const parsed = EnvoyApi.parseDiscoveryResult({ id: '123456789012', addresses: ['fe80::1', '192.168.1.20'] });
    assert.deepEqual(parsed, { ip: '192.168.1.20', serial: '123456789012' });
  });

  test('extracts the serial from other fields when id is not a serial', () => {
    const parsed = EnvoyApi.parseDiscoveryResult({ id: 'envoy', name: 'envoy 123456789012', address: '10.0.0.5' });
    assert.deepEqual(parsed, { ip: '10.0.0.5', serial: '123456789012' });
  });

  test('skips link-local IPv6 but accepts a routeable one when no IPv4 exists', () => {
    assert.equal(EnvoyApi.parseDiscoveryResult({ addresses: ['fe80::1'] }).ip, '');
    assert.equal(EnvoyApi.parseDiscoveryResult({ addresses: ['fe80::1', '2001:db8::5'] }).ip, '2001:db8::5');
  });

  test('empty input is empty output', () => {
    assert.deepEqual(EnvoyApi.parseDiscoveryResult(null), { ip: '', serial: '' });
  });
});

test.describe('token decoding', () => {
  const makeToken = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  const api = () => {
    const a = Object.create(EnvoyApi.prototype);
    a.log = () => { };
    return a;
  };

  test('validateToken checks only the exp claim', () => {
    const a = api();
    const future = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(a.validateToken(makeToken({ exp: future })), true);
    assert.equal(a.validateToken(makeToken({ exp: 1000 })), false);
    assert.equal(a.validateToken(makeToken({})), true);
  });

  test('malformed tokens are invalid and never throw', () => {
    const a = api();
    assert.equal(a.validateToken(''), false);
    assert.equal(a.validateToken('onlyonepart'), false);
    assert.equal(a.validateToken('h.!!!notjson.s'), false);
  });

  test('evaluateTokenRole detects installer and maintainer by claim or role list', () => {
    const a = api();
    assert.equal(a.evaluateTokenRole(makeToken({ enphaseUser: 'installer', exp: 5 })).isMaintainer, true);
    assert.equal(a.evaluateTokenRole(makeToken({ roles: ['maintainer'] })).isMaintainer, true);
    const owner = a.evaluateTokenRole(makeToken({ enphaseUser: 'owner', exp: 9 }));
    assert.equal(owner.isMaintainer, false);
    assert.equal(owner.exp, 9);
  });

  test('evaluateTokenRole returns a safe default for malformed input', () => {
    const a = api();
    assert.deepEqual(a.evaluateTokenRole(null), { token: null, isMaintainer: false, exp: 0 });
    assert.deepEqual(a.evaluateTokenRole('abc'), { token: 'abc', isMaintainer: false, exp: 0 });
    const bad = a.evaluateTokenRole('h.@@@.s');
    assert.equal(bad.isMaintainer, false);
    assert.equal(bad.exp, 0);
  });
});
