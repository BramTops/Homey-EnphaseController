'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMeters,
  parseMeterReadings,
  parseBatteryPower,
  parseInventory,
  deriveGridStatus,
  aggregateSoc,
  BatteryEnergyLedger,
  GatewayEnergyModel,
} = require('../lib/energyModel');

// Shapes follow /ivp/meters, /ivp/meters/readings, /ivp/ensemble/power and /ivp/ensemble/inventory as documented in
// docs/PROTOCOLS.md and observed on real gateways; values are small synthetic examples.
const meter = (eid, measurementType, state = 'enabled') => ({ eid, measurementType, state });
const CT_FULL = [
  meter(704643328, 'production'),
  meter(704643584, 'net-consumption'),
  meter(704643840, 'total-consumption'),
];
const reading = (eid, over = {}) => ({
  eid,
  timestamp: 1700000000,
  activePower: 100,
  actEnergyDlvd: 5000,
  actEnergyRcvd: 2000,
  ...over,
});

const NOW = 1700000010000; // 10 s after the reading timestamps above

function modelWith(cfg = CT_FULL) {
  const m = new GatewayEnergyModel({ serial: '123456789012' });
  m.setMetersConfig(cfg, false, NOW);
  return m;
}

test.describe('classifyMeters', () => {
  test('unknown configuration is tri-state null', () => {
    const cfg = classifyMeters(null);
    assert.equal(cfg.known, false);
    assert.deepEqual(cfg.has, { productionMeter: null, gridMeter: null, homeMeter: null });
  });

  test('full CT set maps every role', () => {
    const cfg = classifyMeters(CT_FULL);
    assert.equal(cfg.known, true);
    assert.equal(cfg.readable, true);
    assert.deepEqual(cfg.has, { productionMeter: true, gridMeter: true, homeMeter: true });
  });

  test('disabled and missing meters are false, not null', () => {
    const cfg = classifyMeters([meter(1, 'production', 'disabled')]);
    assert.deepEqual(cfg.has, { productionMeter: false, gridMeter: false, homeMeter: false });
    assert.equal(cfg.readable, false);
  });

  test('an enabled generic consumption CT is ambiguous: grid and home stay null', () => {
    const cfg = classifyMeters([meter(1, 'production'), meter(2, 'consumption')]);
    assert.equal(cfg.has.productionMeter, true);
    assert.equal(cfg.has.gridMeter, null);
    assert.equal(cfg.has.homeMeter, null);
  });

  test('a typed meter wins over the ambiguity for its own role only', () => {
    const cfg = classifyMeters([meter(1, 'net-consumption'), meter(2, 'consumption')]);
    assert.equal(cfg.has.gridMeter, true);
    assert.equal(cfg.has.homeMeter, null);
  });

  test('a disabled generic consumption CT does not make roles ambiguous', () => {
    const cfg = classifyMeters([meter(1, 'consumption', 'disabled')]);
    assert.equal(cfg.has.gridMeter, false);
    assert.equal(cfg.has.homeMeter, false);
  });

  test('an empty list is known but not readable', () => {
    const cfg = classifyMeters([]);
    assert.equal(cfg.known, true);
    assert.equal(cfg.readable, false);
  });
});

test.describe('parseMeterReadings', () => {
  const cfg = classifyMeters(CT_FULL);
  const received = 1700000010000;

  test('maps readings to roles and converts Wh to kWh', () => {
    const roles = parseMeterReadings([reading(704643584, { activePower: -250, actEnergyDlvd: 12345, actEnergyRcvd: 6789 })], cfg, received);
    assert.equal(roles.net.w, -250);
    assert.equal(roles.net.dlvd, 12.345);
    assert.equal(roles.net.rcvd, 6.789);
    assert.equal(roles.production, null);
  });

  test('timestamps in seconds and milliseconds both resolve to epoch ms', () => {
    const seconds = parseMeterReadings([reading(704643328, { timestamp: 1700000000 })], cfg, received);
    const millis = parseMeterReadings([reading(704643328, { timestamp: 1700000000000 })], cfg, received);
    assert.equal(seconds.production.observedAt, 1700000000000);
    assert.equal(millis.production.observedAt, 1700000000000);
  });

  test('a far-future timestamp is a gateway clock error and falls back to the collection time', () => {
    const roles = parseMeterReadings([reading(704643328, { timestamp: 1700009999 })], cfg, received);
    assert.equal(roles.production.observedAt, received);
  });

  test('a missing timestamp falls back to the collection time, an old one is kept', () => {
    const missing = parseMeterReadings([reading(704643328, { timestamp: undefined })], cfg, received);
    const old = parseMeterReadings([reading(704643328, { timestamp: 1699990000 })], cfg, received);
    assert.equal(missing.production.observedAt, received);
    assert.equal(old.production.observedAt, 1699990000000);
  });

  test('absent or non-numeric fields stay null instead of becoming zero', () => {
    const roles = parseMeterReadings([reading(704643328, { activePower: 'n/a', actEnergyDlvd: undefined, actEnergyRcvd: null })], cfg, received);
    assert.equal(roles.production.w, null);
    assert.equal(roles.production.dlvd, null);
    assert.equal(roles.production.rcvd, null);
  });

  test('disabled meters are not read and a non-list response throws', () => {
    const disabled = classifyMeters([meter(7, 'production', 'disabled')]);
    assert.equal(parseMeterReadings([reading(7)], disabled, received).production, null);
    assert.throws(() => parseMeterReadings({}, cfg, received), /not a list/);
  });
});

test.describe('parseBatteryPower', () => {
  test('flips the gateway sign: raw + is discharging, Homey + is charging', () => {
    const { units, totalW } = parseBatteryPower({ devices: [{ serial_num: 'A', real_power_mw: 1500000, soc: 80 }] });
    assert.equal(units[0].w, -1500);
    assert.equal(totalW, -1500);
    assert.equal(units[0].soc, 80);
  });

  test('accepts the "devices:" key quirk and real_power_w', () => {
    const { units } = parseBatteryPower({ 'devices:': [{ serial_num: 7, real_power_w: -400, soc: 50 }] });
    assert.equal(units[0].serial, '7');
    assert.equal(units[0].w, 400);
  });

  test('real_power_mw wins over real_power_w', () => {
    const { units } = parseBatteryPower({ devices: [{ real_power_mw: 1000000, real_power_w: 5 }] });
    assert.equal(units[0].w, -1000);
  });

  test('a unit without readable power makes the total null (no partial sum, no zero)', () => {
    const { units, totalW } = parseBatteryPower({ devices: [{ real_power_mw: 1000 }, { soc: 40 }] });
    assert.equal(units.length, 2);
    assert.equal(totalW, null);
  });

  test('out-of-range SoC is dropped and an empty list has no total', () => {
    assert.equal(parseBatteryPower({ devices: [{ real_power_mw: 0, soc: 140 }] }).units[0].soc, null);
    assert.equal(parseBatteryPower({ devices: [] }).totalW, null);
    assert.equal(parseBatteryPower({}).units.length, 0);
  });

  test('rejects malformed responses', () => {
    assert.throws(() => parseBatteryPower(null), /not an object/);
    assert.throws(() => parseBatteryPower({ devices: 'x' }), /not a list/);
  });
});

test.describe('parseInventory and deriveGridStatus', () => {
  test('a response without ENCHARGE devices proves there is no battery', () => {
    const parsed = parseInventory([{ type: 'PCU', devices: [{ serial_num: '1' }] }]);
    assert.equal(parsed.hasBattery, false);
    assert.equal(parsed.units.length, 0);
  });

  test('parses units, validates percentFull and capacity', () => {
    const parsed = parseInventory([{
      type: 'ENCHARGE',
      devices: [
        {
          serial_num: 'B1', part_num: '830-01760-r37', encharge_capacity: 3360, percentFull: 55, reported_enc_grid_state: 'grid-tied',
        },
        { serial_num: 'B2', percentFull: 120, encharge_capacity: 0 },
      ],
    }]);
    assert.equal(parsed.hasBattery, true);
    assert.equal(parsed.units[0].capacity, 3360);
    assert.equal(parsed.units[0].percentFull, 55);
    assert.equal(parsed.units[1].percentFull, null);
    assert.equal(parsed.units[1].capacity, null);
    assert.equal(parsed.gridStatus, 'connected');
  });

  test('grid status: ENPOWER first, then batteries, otherwise unknown', () => {
    assert.equal(deriveGridStatus([{ type: 'ENPOWER', devices: [{ mains_oper_state: 'open' }] }]), 'disconnected');
    assert.equal(deriveGridStatus([{ type: 'ENPOWER', devices: [{ mains_oper_state: 'closed' }] }]), 'connected');
    assert.equal(deriveGridStatus([{ type: 'ENCHARGE', devices: [{ reported_enc_grid_state: 'off-grid' }, { reported_enc_grid_state: 'off-grid' }] }]), 'disconnected');
    assert.equal(deriveGridStatus([{ type: 'ENCHARGE', devices: [{}] }]), 'unknown');
    assert.equal(deriveGridStatus([]), 'unknown');
  });

  test('rejects a non-list response', () => {
    assert.throws(() => parseInventory({}), /not a list/);
  });
});

test.describe('aggregateSoc', () => {
  test('a single unit passes through', () => {
    assert.equal(aggregateSoc([{ serial: 'A', soc: 42.34 }], []), 42.3);
  });

  test('capacity-weighted mean when every capacity is known', () => {
    const inv = [{ serial: 'A', capacity: 1000 }, { serial: 'B', capacity: 3000 }];
    assert.equal(aggregateSoc([{ serial: 'A', soc: 100 }, { serial: 'B', soc: 0 }], inv), 25);
  });

  test('plain mean only when all units share one part number', () => {
    const same = [{ serial: 'A', partNum: 'X' }, { serial: 'B', partNum: 'X' }];
    const mixed = [{ serial: 'A', partNum: 'X' }, { serial: 'B', partNum: 'Y' }];
    const socs = [{ serial: 'A', soc: 20 }, { serial: 'B', soc: 60 }];
    assert.equal(aggregateSoc(socs, same), 40);
    assert.equal(aggregateSoc(socs, mixed), null);
  });

  test('no units, or unknown unit metadata, gives null', () => {
    assert.equal(aggregateSoc([], []), null);
    assert.equal(aggregateSoc([{ serial: 'A', soc: 1 }, { serial: 'B', soc: 2 }], []), null);
  });
});

test.describe('GatewayEnergyModel snapshot', () => {
  test('before any observation every field is unknown with a null value, never zero', () => {
    const snap = modelWith().snapshot(NOW, { fastIntervalSeconds: 15 });
    for (const name of ['solarW', 'gridW', 'homeW', 'solarKWh', 'gridImportKWh']) {
      assert.equal(snap[name], null, name);
      assert.equal(snap.fields[name].status, 'unknown', name);
    }
    assert.equal(snap.has.battery, null);
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.fields.solarW));
  });

  test('a fresh meter reading gives measured values with the right sign and unit', () => {
    const m = modelWith();
    m.recordMeters([
      reading(704643328, { activePower: 3000, actEnergyDlvd: 9000000 }),
      reading(704643584, { activePower: -1200, actEnergyDlvd: 1000, actEnergyRcvd: 2000 }),
      reading(704643840, { activePower: 1800 }),
    ], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.solarW, 3000);
    assert.equal(snap.gridW, -1200);
    assert.equal(snap.homeW, 1800);
    assert.equal(snap.solarKWh, 9000);
    assert.equal(snap.gridImportKWh, 1);
    assert.equal(snap.gridExportKWh, 2);
    assert.equal(snap.fields.gridW.status, 'fresh');
    assert.equal(snap.fields.gridW.source, 'meters');
  });

  test('negative production is clamped to 0 before derivation, grid keeps its sign', () => {
    const m = modelWith();
    m.recordMeters([reading(704643328, { activePower: -3 }), reading(704643584, { activePower: -10 })], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.solarW, 0);
    assert.equal(snap.gridW, -10);
  });

  test('freshness: fresh up to three intervals, stale after, and stale keeps the last value as null-valued metadata', () => {
    const m = modelWith();
    m.setFastIntervalMs(15000);
    m.recordMeters([reading(704643328, { timestamp: NOW / 1000 })], NOW);
    const fresh = m.snapshot(NOW + 45000, { fastIntervalSeconds: 15 });
    assert.equal(fresh.fields.solarW.status, 'fresh');
    const stale = m.snapshot(NOW + 45001, { fastIntervalSeconds: 15 });
    assert.equal(stale.fields.solarW.status, 'stale');
    assert.equal(stale.solarW, null);
    assert.equal(stale.fields.solarW.observedAt, NOW);
  });

  test('an old gateway timestamp stays stale even though the HTTP request just succeeded', () => {
    const m = modelWith();
    m.setFastIntervalMs(15000);
    m.recordMeters([reading(704643328, { timestamp: NOW / 1000 - 600 })], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.fields.solarW.status, 'stale');
  });

  test('the meters staleness threshold follows a smoothed measured cadence slower than the poll', () => {
    const m = modelWith();
    m.setFastIntervalMs(15000);
    const t0 = NOW;
    const record = (t) => m.recordMeters([reading(704643328, { timestamp: t / 1000 })], t);
    record(t0);
    record(t0 + 60000); // cadence 60 s
    record(t0 + 180000); // 120 s step: 0.7 x 60 + 0.3 x 120 = 78 s, threshold 3 x 78 s = 234 s
    const last = t0 + 180000;
    const at = (t) => m.snapshot(t, { fastIntervalSeconds: 15 });
    assert.equal(at(last + 234000).fields.solarW.status, 'fresh');
    assert.equal(at(last + 234001).fields.solarW.status, 'stale');
  });

  test('a late-arriving older meter response is ignored', () => {
    const m = modelWith();
    assert.equal(m.recordMeters([reading(704643328, { timestamp: NOW / 1000 })], NOW), true);
    assert.equal(m.recordMeters([reading(704643328, { timestamp: NOW / 1000 - 30, activePower: 1 })], NOW + 5000), false);
    assert.equal(m.snapshot(NOW + 5000, { fastIntervalSeconds: 15 }).solarW, 100);
  });

  test('home is derived from fresh solar + grid - battery when there is no total CT', () => {
    const m = modelWith([meter(1, 'production'), meter(2, 'net-consumption')]);
    m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
    m.recordMeters([reading(1, { activePower: 2000, timestamp: NOW / 1000 }), reading(2, { activePower: 500, timestamp: NOW / 1000 })], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.homeW, 2500);
    assert.equal(snap.fields.homeW.source, 'derived');
  });

  test('derived home is not produced from inputs observed too far apart', () => {
    const m = modelWith([meter(1, 'production'), meter(2, 'net-consumption')]);
    m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
    m.recordMeters([
      reading(1, { activePower: 2000, timestamp: NOW / 1000 }),
      reading(2, { activePower: 500, timestamp: NOW / 1000 - 200 }),
    ], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 60 });
    assert.equal(snap.homeW, null);
  });

  test('a generic consumption CT never yields a grid or home reading', () => {
    const m = modelWith([meter(1, 'production'), meter(2, 'consumption')]);
    m.recordMeters([reading(1, { activePower: 2000 }), reading(2, { activePower: 700 })], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.has.gridMeter, null);
    assert.notEqual(snap.fields.gridW.source, 'meters');
    assert.equal(snap.gridW, null);
  });

  test('without a production CT the slow tier supplies solar, and it goes stale after three slow intervals (6 minutes)', () => {
    const m = modelWith([]);
    m.recordProduction({
      solar: {
        w: 800, kWh: 1234.5, observedAt: NOW, source: 'inverters',
      },
    }, NOW);
    const at = (t) => m.snapshot(t, { fastIntervalSeconds: null });
    assert.equal(at(NOW + 360000).fields.solarW.status, 'fresh');
    assert.equal(at(NOW + 360001).fields.solarW.status, 'stale');
    assert.equal(at(NOW).solarW, 800);
    assert.equal(at(NOW).solarKWh, 1234.5);
    assert.equal(at(NOW).fields.solarW.source, 'production');
  });

  // PRODUCTION_MIN_STALE_MS (6 min) equals 3 x the slow interval, so the floor itself never binds; what moves the
  // threshold is a measured gateway cadence slower than the poll.
  test('a measured production cadence slower than the poll raises the threshold, capped at 15 minutes', () => {
    const m = modelWith([]);
    const sample = (t) => ({
      solar: {
        w: 800, kWh: 1, observedAt: t, source: 'inverters',
      },
    });
    m.recordProduction(sample(NOW), NOW);
    m.recordProduction(sample(NOW + 300000), NOW + 300000); // gateway only refreshes every 5 minutes
    const last = NOW + 300000;
    const at = (t) => m.snapshot(t, { fastIntervalSeconds: null });
    assert.equal(at(last + 900000).fields.solarW.status, 'fresh'); // 3 x 300 s = 15 min (also the cap)
    assert.equal(at(last + 900001).fields.solarW.status, 'stale');
  });

  test('battery: absent when the inventory proves none (valid zero), unknown otherwise', () => {
    const m = modelWith();
    assert.equal(m.snapshot(NOW, { fastIntervalSeconds: 15 }).fields.batteryW.status, 'unknown');
    m.recordInventory([{ type: 'PCU', devices: [] }], NOW);
    const snap = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(snap.fields.batteryW.status, 'absent');
    assert.equal(snap.batteryW, 0);
    assert.equal(snap.fields.soc.status, 'absent');
    assert.equal(snap.sources.batteryPower.status, 'absent');
    assert.equal(snap.has.battery, false);
  });

  test('battery power and SoC come from the power endpoint while fresh, inventory is the SoC fallback', () => {
    const m = modelWith();
    m.setFastIntervalMs(15000);
    m.recordInventory([{ type: 'ENCHARGE', devices: [{ serial_num: 'B1', percentFull: 61 }] }], NOW);
    m.recordBatteryPower({ devices: [{ serial_num: 'B1', real_power_mw: 2000000, soc: 62 }] }, NOW, 1000);
    const fresh = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(fresh.batteryW, -2000);
    assert.equal(fresh.soc, 62);
    assert.equal(fresh.fields.soc.source, 'batteryPower');
    const later = m.snapshot(NOW + 100000, { fastIntervalSeconds: 15 });
    assert.equal(later.fields.batteryW.status, 'stale');
    assert.equal(later.batteryW, null);
    // The power reading is stale, so SoC falls back to the (still fresh) inventory instead of mixing sources.
    assert.equal(later.fields.soc.status, 'fresh');
    assert.equal(later.fields.soc.source, 'inventory');
    assert.equal(later.soc, 61);
  });

  test('a failed attempt keeps the last good observation; staleness follows from its age', () => {
    const m = modelWith();
    m.setFastIntervalMs(15000);
    m.recordMeters([reading(704643328, { timestamp: NOW / 1000 })], NOW);
    m.recordFailure('meters', new Error('timeout'), NOW + 20000);
    assert.equal(m.snapshot(NOW + 20000, { fastIntervalSeconds: 15 }).solarW, 100);
    assert.equal(m.snapshot(NOW + 60000, { fastIntervalSeconds: 15 }).fields.solarW.status, 'stale');
  });

  test('meters source is absent when the configuration is known but nothing is enabled', () => {
    const m = modelWith([meter(1, 'production', 'disabled')]);
    assert.equal(m.snapshot(NOW, { fastIntervalSeconds: 15 }).sources.meters.status, 'absent');
    assert.equal(m.shouldReadMeters(), false);
  });
});

test.describe('BatteryEnergyLedger', () => {
  test('integrates fresh consecutive samples with the trapezoid rule and splits charge from discharge', () => {
    const ledger = new BatteryEnergyLedger(null);
    ledger.integrate(1000, 0, 60000, 1);
    ledger.integrate(1000, 3600000, 4000000, 2); // 1 kW for 1 h
    ledger.integrate(-2000, 7200000, 4000000, 3); // average -500 W for 1 h
    const totals = ledger.totals();
    assert.ok(Math.abs(totals.charged - 1) < 1e-9);
    assert.ok(Math.abs(totals.discharged - 0.5) < 1e-9);
  });

  test('never integrates across a gap longer than the allowed maximum', () => {
    const ledger = new BatteryEnergyLedger(null);
    ledger.integrate(1000, 0, 30000, 1);
    ledger.integrate(1000, 120000, 30000, 2);
    assert.equal(ledger.totals(), null);
  });

  test('totals survive a serialize / restore round trip and sanitize rejects corrupt state', () => {
    const ledger = new BatteryEnergyLedger(null);
    ledger.start();
    ledger.integrate(500, 0, 60000, 1);
    ledger.integrate(500, 60000, 60000, 2);
    const restored = new BatteryEnergyLedger(ledger.serialize());
    assert.deepEqual(restored.totals(), ledger.totals());
    assert.equal(BatteryEnergyLedger.sanitize('not json'), null);
    assert.equal(BatteryEnergyLedger.sanitize({ charged: -1, discharged: 0 }), null);
  });

  test('storage meter counters are not trusted before the direction is verified', () => {
    const ledger = new BatteryEnergyLedger(null);
    ledger.start();
    ledger.observeMeter({ id: 1, rcvd: 10, dlvd: 10 }, 0);
    assert.notEqual(ledger.source, 'storage-meter');
    ledger.observeMeter({ id: 1, rcvd: 0, dlvd: 0 }, 60000); // counters went backwards before any verification
    assert.deepEqual(ledger.totals(), { charged: 0, discharged: 0 });
  });

  // Drives the ledger into storage-meter mode: 1 kW charging for 1 h per round, with the 'rcvd' counter rising by
  // 1 kWh per round. Three consistent votes are required.
  const HOUR = 3600000;
  const verifiedMeterLedger = () => {
    const ledger = new BatteryEnergyLedger(null);
    ledger.start();
    ledger.integrate(1000, 0, 2 * HOUR, 0);
    ledger.observeMeter({ id: 1, rcvd: 10, dlvd: 5 }, 0);
    for (let i = 1; i <= 3; i += 1) {
      ledger.integrate(1000, i * HOUR, 2 * HOUR, i * HOUR);
      ledger.observeMeter({ id: 1, rcvd: 10 + i, dlvd: 5 }, i * HOUR);
    }
    return ledger;
  };

  test('three consistent votes switch the totals to the storage meter counters', () => {
    const ledger = verifiedMeterLedger();
    assert.equal(ledger.source, 'storage-meter');
    assert.deepEqual(ledger.totals(), { charged: 3, discharged: 0 });
    ledger.observeMeter({ id: 1, rcvd: 14.5, dlvd: 5 }, 4 * HOUR);
    assert.deepEqual(ledger.totals(), { charged: 4.5, discharged: 0 });
  });

  test('a storage meter counter reset only re-seeds: totals never drop and keep growing from the new baseline', () => {
    const ledger = verifiedMeterLedger();
    ledger.observeMeter({ id: 1, rcvd: 0, dlvd: 0 }, 4 * HOUR); // counters went backwards
    assert.equal(ledger.source, 'storage-meter');
    assert.deepEqual(ledger.totals(), { charged: 3, discharged: 0 });
    ledger.observeMeter({ id: 1, rcvd: 0.5, dlvd: 0 }, 5 * HOUR);
    assert.deepEqual(ledger.totals(), { charged: 3.5, discharged: 0 });
  });

  test('a replaced storage meter (new id) falls back to integration and never adds a jump', () => {
    const ledger = verifiedMeterLedger();
    ledger.observeMeter({ id: 2, rcvd: 900, dlvd: 800 }, 4 * HOUR);
    assert.equal(ledger.source, 'integrated');
    assert.deepEqual(ledger.totals(), { charged: 3, discharged: 0 });
  });
});
