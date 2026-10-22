'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homeyStub');

const { GatewayEnergyModel } = require('../lib/energyModel');
const { WidgetFeed, FLOW_STALE_MS } = require('../lib/widgetFeed');
const EnphaseController = require('../app');

const SERIAL = '123456789012';
const NOW = 1700000010000;
const SECONDS = NOW / 1000;

const solarDetail = (w) => ({
  solar: {
    w, kWh: 1, observedAt: NOW, source: 'inverters',
  },
});

// A CT-free system with no battery: solar from the slow tier only, grid and home unknown.
function ctFreeSnapshot(solarW = 1500) {
  const m = new GatewayEnergyModel({ serial: SERIAL });
  m.setMetersConfig(null, true, NOW);
  m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
  m.recordProduction(solarDetail(solarW), NOW);
  return m.snapshot(NOW, { fastIntervalSeconds: null });
}

// A fully metered system (production + net + total CTs) with fresh readings.
function meteredSnapshot() {
  const m = new GatewayEnergyModel({ serial: SERIAL });
  m.setMetersConfig([
    { eid: 1, measurementType: 'production', state: 'enabled' },
    { eid: 2, measurementType: 'net-consumption', state: 'enabled' },
    { eid: 3, measurementType: 'total-consumption', state: 'enabled' },
  ], false, NOW);
  m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
  const rd = (eid, activePower) => ({
    eid, timestamp: SECONDS, activePower, actEnergyDlvd: 0, actEnergyRcvd: 0, channels: [{ activePower, voltage: 230 }],
  });
  m.recordMeters([rd(1, 2000), rd(2, -500), rd(3, 1500)], NOW);
  return m.snapshot(NOW, { fastIntervalSeconds: 15 });
}

test.describe('WidgetFeed.set', () => {
  test('rejects values that are not finite numbers and unknown fields', () => {
    const feed = new WidgetFeed();
    [null, undefined, NaN, Infinity, '12', {}].forEach((v) => {
      assert.equal(feed.set(SERIAL, 'gridW', v, NOW), false);
    });
    assert.equal(feed.set(SERIAL, 'bogusW', 1, NOW), false);
    assert.equal(feed.set('', 'gridW', 1, NOW), false);
    const base = ctFreeSnapshot();
    assert.equal(feed.merge(SERIAL, base, NOW), base);
  });

  test('a rejected value does not clear a cached one', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    feed.set(SERIAL, 'gridW', 300, NOW);
    feed.set(SERIAL, 'gridW', null, NOW + 1000);
    assert.equal(feed.merge(SERIAL, base, NOW + 2000).gridW, 300);
  });

  test('solar and home clamp at zero, grid and battery keep their sign', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'solarW', -20, NOW);
    feed.set(SERIAL, 'homeW', -5, NOW);
    feed.set(SERIAL, 'gridW', -700, NOW);
    feed.set(SERIAL, 'batteryW', -400, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(0), NOW);
    assert.equal(merged.solarW, 0);
    assert.equal(merged.homeW, 0);
    assert.equal(merged.gridW, -700);
    assert.equal(merged.batteryW, -400);
  });
});

test.describe('WidgetFeed.merge', () => {
  test('returns the very same snapshot when nothing is cached', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    assert.equal(feed.merge(SERIAL, base, NOW), base);
    assert.equal(feed.merge(SERIAL, null, NOW), null);
  });

  test('does not modify the raw snapshot', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    feed.set(SERIAL, 'gridW', 250, NOW);
    const merged = feed.merge(SERIAL, base, NOW);
    assert.notEqual(merged, base);
    assert.equal(base.gridW, null);
    assert.equal(base.fields.gridW.source !== 'flow', true);
    assert.equal(merged.gridW, 250);
  });

  test('fills grid, battery and home on a system without CTs or battery', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 400, NOW);
    feed.set(SERIAL, 'batteryW', 300, NOW);
    const base = ctFreeSnapshot(1500);
    assert.equal(base.has.battery, false);
    const merged = feed.merge(SERIAL, base, NOW);
    assert.equal(merged.gridW, 400);
    assert.deepEqual(merged.fields.gridW, { observedAt: NOW, status: 'fresh', source: 'flow' });
    assert.equal(merged.batteryW, 300);
    assert.equal(merged.has.battery, true);
    // Home is derived: 1500 + 400 - 300.
    assert.equal(merged.homeW, 1600);
    assert.equal(merged.fields.homeW.source, 'derived');
    assert.equal(merged.fields.homeW.status, 'fresh');
  });

  test('a missing battery counts as 0 in the derivation but never becomes a value or a visible battery', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', -200, NOW);

    // Known absent: the gateway reports 0 with status 'absent'.
    const absent = feed.merge(SERIAL, ctFreeSnapshot(1000), NOW);
    assert.equal(absent.homeW, 800);
    assert.equal(absent.has.battery, false);
    assert.equal(absent.fields.batteryW.status, 'absent');

    // Presence not known yet: batteryW is null and stays null.
    const m = new GatewayEnergyModel({ serial: SERIAL });
    m.setMetersConfig(null, true, NOW);
    m.recordProduction(solarDetail(1000), NOW);
    const unknown = feed.merge(SERIAL, m.snapshot(NOW, { fastIntervalSeconds: null }), NOW);
    assert.equal(unknown.has.battery, null);
    assert.equal(unknown.batteryW, null);
    assert.equal(unknown.homeW, 800);
  });

  test('a battery that exists but is outdated blocks the derivation', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 400, NOW);
    const base = ctFreeSnapshot(1000);
    const withBattery = {
      ...base,
      batteryW: null,
      has: { ...base.has, battery: true },
      fields: { ...base.fields, batteryW: { observedAt: NOW - 3600000, status: 'stale', source: 'batteryPower' } },
    };
    const merged = feed.merge(SERIAL, withBattery, NOW);
    assert.equal(merged.homeW, null);
    assert.equal(merged.has.battery, true);
  });

  test('missing solar counts as 0 in the derivation but an outdated one blocks it', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 300, NOW);
    const noSolar = new GatewayEnergyModel({ serial: SERIAL });
    noSolar.setMetersConfig(null, true, NOW);
    noSolar.recordInventory([{ type: 'PCU', devices: [] }], NOW);
    const bare = noSolar.snapshot(NOW, { fastIntervalSeconds: null });
    assert.equal(bare.solarW, null);
    const merged = feed.merge(SERIAL, bare, NOW);
    assert.equal(merged.homeW, 300);
    assert.equal(merged.solarW, null);

    const stale = {
      ...bare,
      fields: { ...bare.fields, solarW: { observedAt: NOW - 3600000, status: 'stale', source: 'production' } },
    };
    assert.equal(feed.merge(SERIAL, stale, NOW).homeW, null);
  });

  test('grid is derived from home when only home is supplied', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'homeW', 1200, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(1000), NOW);
    assert.equal(merged.gridW, 200);
    assert.equal(merged.fields.gridW.source, 'derived');
    assert.equal(merged.fields.homeW.source, 'flow');

    feed.set(SERIAL, 'batteryW', 500, NOW); // charging: grid = home - solar + battery
    assert.equal(feed.merge(SERIAL, ctFreeSnapshot(1000), NOW).gridW, 700);
  });

  test('nothing is derived when grid and home are both unknown', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'batteryW', 500, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(1000), NOW);
    assert.equal(merged.gridW, null);
    assert.equal(merged.homeW, null);
  });

  test('an explicit home value wins over derivation', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 400, NOW);
    feed.set(SERIAL, 'homeW', 999, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(1500), NOW);
    assert.equal(merged.homeW, 999);
    assert.equal(merged.fields.homeW.source, 'flow');
  });

  test('flow values go stale after the window but stay readable', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 400, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(), NOW + FLOW_STALE_MS + 1);
    assert.equal(merged.gridW, 400);
    assert.equal(merged.fields.gridW.status, 'stale');
    // No fresh grid, so home is not derived from it.
    assert.equal(merged.homeW, null);
  });

  test('newest observation wins when the gateway fills the same field', () => {
    const feed = new WidgetFeed();
    const base = meteredSnapshot(); // grid -500 observed at NOW
    assert.equal(base.gridW, -500);

    feed.set(SERIAL, 'gridW', 123, NOW - 5000); // older than the gateway reading
    assert.equal(feed.merge(SERIAL, base, NOW).gridW, -500);

    feed.set(SERIAL, 'gridW', 456, NOW + 5000); // newer
    const merged = feed.merge(SERIAL, base, NOW + 5000);
    assert.equal(merged.gridW, 456);
    assert.equal(merged.fields.gridW.source, 'flow');
    // The gateway's other fields are left alone.
    assert.equal(merged.solarW, base.solarW);
    assert.equal(merged.fields.solarW.source, base.fields.solarW.source);
  });

  test('a null gateway value never competes', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    assert.equal(base.gridW, null);
    feed.set(SERIAL, 'gridW', 10, NOW - 60 * 1000);
    assert.equal(feed.merge(SERIAL, base, NOW).gridW, 10);
  });

  test('clear forgets the cache', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    feed.set(SERIAL, 'gridW', 10, NOW);
    feed.clear(SERIAL);
    assert.equal(feed.merge(SERIAL, base, NOW), base);
  });
});

test.describe('WidgetFeed tariff', () => {
  test('rides along on the merged snapshot without touching the power fields', () => {
    const feed = new WidgetFeed();
    const base = meteredSnapshot();
    assert.equal(feed.setTariff(SERIAL, 0.24, 0.08), true);
    const merged = feed.merge(SERIAL, base, NOW);
    assert.deepEqual(merged.tariff, { import: 0.24, export: 0.08 });
    assert.equal(merged.gridW, base.gridW);
    assert.equal(merged.ts, base.ts);
    assert.equal(base.tariff, undefined);
  });

  test('combines with power overlays', () => {
    const feed = new WidgetFeed();
    feed.setTariff(SERIAL, 0.24, 0.08);
    feed.set(SERIAL, 'gridW', 350, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(), NOW);
    assert.equal(merged.gridW, 350);
    assert.deepEqual(merged.tariff, { import: 0.24, export: 0.08 });
  });

  test('accepts negative prices, never expires, ignores invalid ones without clearing', () => {
    const feed = new WidgetFeed();
    assert.equal(feed.setTariff(SERIAL, 0.3, -0.02), true);
    assert.equal(feed.setTariff(SERIAL, 'abc', null), false);
    assert.equal(feed.setTariff(SERIAL, NaN, 0.05), true);
    assert.equal(feed.setTariff('', 1, 1), false);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(), NOW + 10 * FLOW_STALE_MS);
    assert.deepEqual(merged.tariff, { import: 0.3, export: 0.05 });
  });

  test('clear forgets the tariff', () => {
    const feed = new WidgetFeed();
    const base = ctFreeSnapshot();
    feed.setTariff(SERIAL, 0.24, 0.08);
    feed.clear(SERIAL);
    assert.equal(feed.merge(SERIAL, base, NOW), base);
  });
});

test.describe('EnphaseController widget wiring', () => {
  const proto = EnphaseController.prototype;
  const makeApp = (rt) => {
    const emitted = [];
    const app = {
      widgetFeed: new WidgetFeed(),
      gateways: new Map(rt ? [[SERIAL, rt]] : []),
      _realtime: (event, data) => emitted.push([event, data]),
      getLatestState: proto.getLatestState,
      _emitWidgetState: proto._emitWidgetState,
    };
    return { app, emitted };
  };

  test('setWidgetValue caches, emits the merged snapshot and leaves the raw snapshot alone', () => {
    const raw = ctFreeSnapshot();
    const { app, emitted } = makeApp({ serial: SERIAL, latest: raw });
    assert.equal(proto.setWidgetValue.call(app, SERIAL, 'gridW', 350), true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0][0], 'enphase:flow');
    assert.equal(emitted[0][1].gridW, 350);
    assert.equal(app.gateways.get(SERIAL).latest, raw);
    assert.equal(raw.gridW, null);
    assert.equal(proto.getLatestState.call(app, SERIAL).gridW, 350);
  });

  test('setWidgetValue ignores unknown gateways and invalid values', () => {
    const { app, emitted } = makeApp({ serial: SERIAL, latest: ctFreeSnapshot() });
    assert.equal(proto.setWidgetValue.call(app, '999999999999', 'gridW', 350), false);
    assert.equal(proto.setWidgetValue.call(app, SERIAL, 'gridW', null), false);
    assert.equal(proto.setWidgetValue.call(app, SERIAL, 'gridW', 'abc'), false);
    assert.equal(emitted.length, 0);
    assert.equal(proto.getLatestState.call(app, SERIAL).gridW, null);
  });

  test('setWidgetTariff caches, emits the merged snapshot and ignores unknown gateways and invalid prices', () => {
    const { app, emitted } = makeApp({ serial: SERIAL, latest: ctFreeSnapshot() });
    assert.equal(proto.setWidgetTariff.call(app, '999999999999', 0.2, 0.1), false);
    assert.equal(proto.setWidgetTariff.call(app, SERIAL, null, 'x'), false);
    assert.equal(emitted.length, 0);
    assert.equal(proto.setWidgetTariff.call(app, SERIAL, 0.24, 0.08), true);
    assert.equal(emitted.length, 1);
    assert.deepEqual(emitted[0][1].tariff, { import: 0.24, export: 0.08 });
  });

  test('a value cached before the first snapshot shows up once it exists', () => {
    const rt = { serial: SERIAL, latest: null };
    const { app, emitted } = makeApp(rt);
    assert.equal(proto.setWidgetValue.call(app, SERIAL, 'gridW', 350), true);
    assert.equal(emitted.length, 0);
    assert.equal(proto.getLatestState.call(app, SERIAL), null);
    rt.latest = ctFreeSnapshot();
    assert.equal(proto.getLatestState.call(app, SERIAL).gridW, 350);
  });
});
