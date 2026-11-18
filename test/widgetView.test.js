'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GatewayEnergyModel } = require('../lib/energyModel');
const { WidgetFeed, FLOW_STALE_MS } = require('../lib/widgetFeed');
const { buildWidgetView, allocateFlows } = require('../lib/widgetView');

const SERIAL = '123456789012';
const NOW = 1700000010000;
const SECONDS = NOW / 1000;

// A fully metered system (production + net + total CTs) with fresh readings: 2000 W solar, 500 W export, 1500 W home.
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

// A CT-free system with no battery: solar from the slow tier only, grid and home unknown.
function ctFreeSnapshot(solarW = 1500) {
  const m = new GatewayEnergyModel({ serial: SERIAL });
  m.setMetersConfig(null, true, NOW);
  m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
  m.recordProduction({
    solar: {
      w: solarW, kWh: 1, observedAt: NOW, source: 'inverters',
    },
  }, NOW);
  return m.snapshot(NOW, { fastIntervalSeconds: null });
}

// Hand-built snapshot: every given field fresh from `source` at NOW.
function synthetic(values, { source = 'meters', battery = true, gridStatus = 'closed' } = {}) {
  const fields = {};
  const snap = {
    serial: SERIAL, ts: NOW, fastIntervalSeconds: 15, slowIntervalSeconds: 120, has: { battery }, gridStatus,
  };
  Object.entries(values).forEach(([name, value]) => {
    snap[name] = value;
    fields[name] = { observedAt: NOW, status: 'fresh', source };
  });
  fields.gridStatus = { observedAt: NOW, status: 'fresh', source: 'inventory' };
  snap.fields = fields;
  return snap;
}

const flowMap = (view) => Object.fromEntries(view.flows.map((f) => [`${f.from}>${f.to}`, f.watts]));

test.describe('buildWidgetView', () => {
  test('returns null without a snapshot', () => {
    assert.equal(buildWidgetView(null, NOW), null);
    assert.equal(buildWidgetView({}, NOW), null);
  });

  test('allocates fresh metered readings and reports when the first one turns stale', () => {
    const view = buildWidgetView(meteredSnapshot(), NOW);
    assert.equal(view.serial, SERIAL);
    assert.equal(view.ts, NOW);
    assert.deepEqual(view.readings.solarW, { status: 'ok', value: 2000 });
    assert.deepEqual(view.readings.gridW, { status: 'ok', value: -500 });
    assert.deepEqual(view.readings.homeW, { status: 'ok', value: 1500 });
    assert.deepEqual(flowMap(view), { 'solar>home': 1500, 'solar>grid': 500 });
    assert.deepEqual(view.present, { solar: true, battery: false });
    // Meters run on the fast cadence: stale after 3 x 15 s + 5 s.
    assert.equal(view.validUntil, NOW + 50000);
  });

  test('outdated readings get no flows but the solar node stays', () => {
    const view = buildWidgetView(meteredSnapshot(), NOW + 60000);
    assert.equal(view.readings.solarW.status, 'stale');
    assert.equal(view.readings.gridW.status, 'stale');
    assert.deepEqual(view.flows, []);
    assert.equal(view.present.solar, true);
  });

  test('validUntil moves to the next reading that will turn stale', () => {
    const snap = synthetic({ solarW: 1000, homeW: 1000 });
    snap.fields.homeW = { observedAt: NOW, status: 'fresh', source: 'production' };
    const first = buildWidgetView(snap, NOW);
    assert.equal(first.validUntil, NOW + 50000); // solar on the fast meters cadence
    const later = buildWidgetView(snap, NOW + 50001);
    assert.equal(later.readings.solarW.status, 'stale');
    assert.equal(later.validUntil, NOW + 365000); // home on the slow cadence: 3 x 120 s + 5 s
  });

  test('a CT-free system without grid or home data has solar but no flows', () => {
    const view = buildWidgetView(ctFreeSnapshot(), NOW);
    assert.equal(view.readings.solarW.status, 'ok');
    assert.equal(view.readings.gridW.status, 'unknown');
    assert.equal(view.readings.homeW.status, 'unknown');
    assert.deepEqual(view.flows, []);
    assert.deepEqual(view.present, { solar: true, battery: false });
  });

  test('Flow values age on the Flow window and a derived home is as fresh as its slowest input', () => {
    const feed = new WidgetFeed();
    feed.set(SERIAL, 'gridW', 350, NOW);
    const merged = feed.merge(SERIAL, ctFreeSnapshot(1500), NOW);
    const view = buildWidgetView(merged, NOW);
    assert.deepEqual(view.readings.homeW, { status: 'ok', value: 1850 });
    assert.deepEqual(flowMap(view), { 'solar>home': 1500, 'grid>home': 350 });
    // Solar (slow tier, 365 s) turns stale first; the derived home would last as long as the Flow value.
    assert.equal(view.validUntil, NOW + 365000);
    const late = buildWidgetView(feed.merge(SERIAL, ctFreeSnapshot(1500), NOW), NOW + FLOW_STALE_MS + 1);
    assert.equal(late.readings.gridW.status, 'stale');
    assert.equal(late.readings.homeW.status, 'stale');
  });

  test('persisted readings never turn stale', () => {
    const view = buildWidgetView(synthetic({ solarW: 800, homeW: 800 }, { source: 'persisted' }), NOW + 10 * 86400000);
    assert.equal(view.readings.solarW.status, 'ok');
    assert.equal(view.validUntil, null);
  });

  test('a disconnected grid carries no power', () => {
    const view = buildWidgetView(synthetic({
      solarW: 0, gridW: 400, homeW: 1200, batteryW: -800,
    }, { gridStatus: 'disconnected' }), NOW);
    assert.equal(view.gridDisconnected, true);
    assert.deepEqual(flowMap(view), { 'battery>home': 800 });
  });

  test('battery power is ignored until the battery is known to exist', () => {
    const view = buildWidgetView(synthetic({
      solarW: 2000, gridW: 0, homeW: 500, batteryW: 1500,
    }, { battery: false }), NOW);
    assert.equal(view.present.battery, false);
    assert.deepEqual(flowMap(view), { 'solar>home': 500 });
  });

  test('passes the tariff through', () => {
    const snap = { ...synthetic({ gridW: 100, homeW: 100 }), tariff: { import: 0.24, export: 0.08 } };
    assert.deepEqual(buildWidgetView(snap, NOW).tariff, { import: 0.24, export: 0.08 });
    assert.equal(buildWidgetView(synthetic({ gridW: 100 }), NOW).tariff, null);
  });
});

test.describe('allocateFlows', () => {
  test('solar feeds home, then battery, then grid', () => {
    assert.deepEqual(allocateFlows({
      solarW: 4200, gridW: -1300, batteryW: 2000, homeW: 900,
    }), [
      { from: 'solar', to: 'home', watts: 900 },
      { from: 'solar', to: 'battery', watts: 2000 },
      { from: 'solar', to: 'grid', watts: 1300 },
    ]);
  });

  test('battery and grid together feed the home; grid can charge the battery', () => {
    assert.deepEqual(allocateFlows({
      solarW: 300, gridW: 1500, batteryW: -2500, homeW: 4300,
    }), [
      { from: 'solar', to: 'home', watts: 300 },
      { from: 'battery', to: 'home', watts: 2500 },
      { from: 'grid', to: 'home', watts: 1500 },
    ]);
    assert.deepEqual(allocateFlows({
      solarW: 0, gridW: 3000, batteryW: 2500, homeW: 500,
    }), [
      { from: 'grid', to: 'home', watts: 500 },
      { from: 'grid', to: 'battery', watts: 2500 },
    ]);
  });

  // The Energy flow widget used to allocate itself, zeroing a grid reading inside its deadzone first. Allocating
  // everything and dropping flows at or below the deadzone afterwards must draw exactly the same flows.
  test('filtering by deadzone afterwards matches zeroing the grid inside the deadzone first', () => {
    const legacy = ({
      solarW, gridW, batteryW, homeW,
    }, dz) => {
      const out = [];
      const push = (from, to, w) => {
        if (w > dz) out.push({ from, to, watts: Math.round(w * 10) / 10 });
      };
      const g = Math.abs(gridW) >= dz ? gridW : 0;
      let s = Math.max(solarW, 0); let gi = Math.max(g, 0); let bd = Math.max(-batteryW, 0);
      let h = Math.max(homeW, 0); let ge = Math.max(-g, 0); let bc = Math.max(batteryW, 0); let t;
      t = Math.min(s, h); push('solar', 'home', t); s -= t; h -= t;
      t = Math.min(s, bc); push('solar', 'battery', t); s -= t; bc -= t;
      t = Math.min(s, ge); push('solar', 'grid', t); s -= t; ge -= t;
      t = Math.min(bd, h); push('battery', 'home', t); bd -= t; h -= t;
      t = Math.min(bd, ge); push('battery', 'grid', t); bd -= t; ge -= t;
      t = Math.min(gi, h); push('grid', 'home', t); gi -= t; h -= t;
      t = Math.min(gi, bc); push('grid', 'battery', t);
      return out;
    };
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = (max) => Math.round((rnd() * 2 - 1) * max * 10) / 10;
    for (let i = 0; i < 5000; i += 1) {
      const dz = [0, 25, 100, 500][i % 4];
      const small = rnd() < 0.3; // exercise values around the deadzone
      const input = {
        solarW: Math.abs(pick(small ? 120 : 6000)),
        gridW: pick(small ? 120 : 6000),
        batteryW: pick(small ? 120 : 4000),
        homeW: Math.abs(pick(small ? 120 : 6000)),
      };
      const filtered = allocateFlows(input).filter((f) => f.watts > dz);
      assert.deepEqual(filtered, legacy(input, dz), JSON.stringify({ input, dz }));
    }
  });
});
