'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { GatewayEnergyModel, parseMeterReadings, classifyMeters } = require('../lib/energyModel');
const {
  PhaseCapabilities, SOLAR_PHASE_GROUPS, GRID_PHASE_GROUPS, REMOVE_AFTER_SNAPSHOTS,
} = require('../lib/phaseCapabilities');

const NOW = 1700000010000;
const SECONDS = NOW / 1000;
const meter = (eid, measurementType, state = 'enabled') => ({ eid, measurementType, state });
const ch = (activePower, voltage = 230) => ({ activePower, voltage });
const reading = (eid, channels, over = {}) => ({
  eid, timestamp: SECONDS, activePower: 0, actEnergyDlvd: 0, actEnergyRcvd: 0, channels, ...over,
});

const PROD = 1;
const NET = 2;
const TOTAL = 3;
const NO_BATTERY = [{ type: 'PCU', devices: [] }];
const BATTERY = [{ type: 'ENCHARGE', devices: [{ serial_num: 'B1', percentFull: 50 }] }];

function snapshotOf(cfg, readings, inventory = NO_BATTERY) {
  const m = new GatewayEnergyModel({ serial: '123456789012' });
  m.setMetersConfig(cfg, false, NOW);
  if (inventory) m.recordInventory(inventory, NOW);
  m.recordMeters(readings, NOW);
  return m.snapshot(NOW, { fastIntervalSeconds: 15 });
}

const THREE_PHASE_CTS = [meter(PROD, 'production'), meter(NET, 'net-consumption')];
const THREE_PHASE_READINGS = [
  reading(PROD, [ch(1000), ch(200), ch(-4)]),
  reading(NET, [ch(-600, 231.04), ch(300, 229.96), ch(500, 230)]),
];

test.describe('parseMeterReadings phases', () => {
  const cfg = classifyMeters(THREE_PHASE_CTS);

  test('reads power and voltage per channel', () => {
    const roles = parseMeterReadings([reading(NET, [ch(10, 231), ch(20, 232), ch(30, 233)])], cfg, NOW);
    assert.deepEqual(roles.net.phases, [{ w: 10, v: 231 }, { w: 20, v: 232 }, { w: 30, v: 233 }]);
  });

  test('a single channel, or none, is a single-phase meter', () => {
    assert.equal(parseMeterReadings([reading(NET, [ch(10)])], cfg, NOW).net.phases, null);
    assert.equal(parseMeterReadings([reading(NET, undefined)], cfg, NOW).net.phases, null);
  });

  test('unreadable channel fields stay null instead of becoming zero', () => {
    const roles = parseMeterReadings([reading(NET, [{ activePower: 'n/a' }, ch(5), null])], cfg, NOW);
    assert.deepEqual(roles.net.phases, [{ w: null, v: null }, { w: 5, v: 230 }, { w: null, v: null }]);
  });

  test('more than three channels are cut off at three', () => {
    const roles = parseMeterReadings([reading(NET, [ch(1), ch(2), ch(3), ch(4)])], cfg, NOW);
    assert.equal(roles.net.phases.length, 3);
  });
});

test.describe('snapshot phases', () => {
  test('before any reading the phase count is unknown, not zero', () => {
    const m = new GatewayEnergyModel({ serial: '123456789012' });
    m.setMetersConfig(THREE_PHASE_CTS, false, NOW);
    const { phases } = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(phases.solarW.count, null);
    assert.equal(phases.solarW.values, null);
    assert.equal(phases.gridV.status, 'unknown');
    assert.ok(Object.isFrozen(phases.solarW));
  });

  test('solar is clamped to 0 per phase, grid keeps its sign, voltage comes from the grid meter', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, THREE_PHASE_READINGS);
    assert.deepEqual(phases.solarW.values, [1000, 200, 0]);
    assert.deepEqual(phases.gridW.values, [-600, 300, 500]);
    assert.deepEqual(phases.gridV.values, [231, 230, 230]);
    assert.equal(phases.solarW.count, 3);
    assert.equal(phases.solarW.status, 'fresh');
    assert.equal(phases.solarW.source, 'meters');
  });

  test('a measured home consumption meter feeds home per phase, clamped to 0', () => {
    const cfg = [...THREE_PHASE_CTS, meter(TOTAL, 'total-consumption')];
    const { phases } = snapshotOf(cfg, [...THREE_PHASE_READINGS, reading(TOTAL, [ch(400), ch(-2), ch(700)])], BATTERY);
    assert.deepEqual(phases.homeW.values, [400, 0, 700]);
    assert.equal(phases.homeW.source, 'meters');
  });

  test('without a home meter and without a battery, home per phase is solar + grid', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, THREE_PHASE_READINGS);
    assert.deepEqual(phases.homeW.values, [400, 500, 500]);
    assert.equal(phases.homeW.count, 3);
    assert.equal(phases.homeW.source, 'derived');
  });

  test('derived home per phase never goes below 0', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, [
      reading(PROD, [ch(100), ch(100), ch(100)]),
      reading(NET, [ch(-300), ch(0), ch(0)]),
    ]);
    assert.deepEqual(phases.homeW.values, [0, 100, 100]);
  });

  test('with a battery and no home meter there is no home per phase', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, THREE_PHASE_READINGS, BATTERY);
    assert.equal(phases.homeW.count, 0);
    assert.equal(phases.homeW.values, null);
    assert.equal(phases.homeW.status, 'absent');
    // the other fields are unaffected by the battery
    assert.deepEqual(phases.gridW.values, [-600, 300, 500]);
  });

  test('an unknown battery state leaves derived home per phase unknown, not absent', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, THREE_PHASE_READINGS, null);
    assert.equal(phases.homeW.count, null);
    assert.equal(phases.homeW.values, null);
  });

  test('single-phase meters report a count of 0', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, [reading(PROD, [ch(900)]), reading(NET, [ch(50)])]);
    assert.equal(phases.solarW.count, 0);
    assert.equal(phases.gridW.count, 0);
    assert.equal(phases.homeW.count, 0);
  });

  test('a meter that is not installed is absent', () => {
    const { phases } = snapshotOf([meter(NET, 'net-consumption')], [reading(NET, [ch(1), ch(2), ch(3)])]);
    assert.equal(phases.solarW.count, 0);
    assert.equal(phases.solarW.status, 'absent');
    assert.equal(phases.gridW.count, 3);
    assert.equal(phases.homeW.count, 0); // needs the production meter for the derivation
  });

  test('an ignored (unwired) production meter gives no solar per phase', () => {
    const m = new GatewayEnergyModel({ serial: '123456789012' });
    m.setMetersConfig(THREE_PHASE_CTS, false, NOW, { ignoreProduction: true });
    m.recordInventory(NO_BATTERY, NOW);
    m.recordMeters(THREE_PHASE_READINGS, NOW);
    const { phases } = m.snapshot(NOW, { fastIntervalSeconds: 15 });
    assert.equal(phases.solarW.count, 0);
    assert.equal(phases.solarW.values, null);
    assert.deepEqual(phases.gridW.values, [-600, 300, 500]); // the grid meter is unaffected
  });

  test('stale readings keep the phase count but have no values', () => {
    const m = new GatewayEnergyModel({ serial: '123456789012' });
    m.setMetersConfig(THREE_PHASE_CTS, false, NOW);
    m.recordInventory(NO_BATTERY, NOW);
    m.recordMeters(THREE_PHASE_READINGS, NOW);
    const { phases } = m.snapshot(NOW + 600000, { fastIntervalSeconds: 15 });
    assert.equal(phases.gridW.count, 3);
    assert.equal(phases.gridW.status, 'stale');
    assert.equal(phases.gridW.values, null);
    assert.equal(phases.homeW.values, null);
  });

  test('derived home is not produced from meters observed too far apart', () => {
    const { phases } = snapshotOf(THREE_PHASE_CTS, [
      reading(PROD, [ch(1000), ch(200), ch(100)]),
      reading(NET, [ch(1), ch(2), ch(3)], { timestamp: SECONDS - 200 }),
    ]);
    assert.equal(phases.homeW.values, null);
    assert.equal(phases.homeW.count, 3);
  });
});

// Minimal Homey.Device stand-in: tracks capabilities, values and options.
function fakeDevice(initial = []) {
  const caps = new Set(initial);
  const values = new Map();
  const options = new Map();
  const errors = [];
  return {
    caps,
    values,
    options,
    errors,
    destroyed: false,
    hasCapability: (id) => caps.has(id),
    addCapability: async (id) => {
      caps.add(id);
    },
    removeCapability: async (id) => {
      caps.delete(id); values.delete(id);
    },
    setCapabilityOptions: async (id, opts) => {
      options.set(id, opts);
    },
    getCapabilityValue: (id) => (values.has(id) ? values.get(id) : null),
    setCapabilityValue: async (id, v) => {
      values.set(id, v);
    },
    log() {},
    error: (...args) => {
      errors.push(args.join(' '));
    },
  };
}

const block = (count, values, over = {}) => ({
  count, values, observedAt: NOW, status: values ? 'fresh' : 'unknown', source: 'meters', ...over,
});
const stateOf = (phases) => ({ phases });

test.describe('PhaseCapabilities', () => {
  test('stays out of the way while the setting is off', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, false);
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3]) }));
    assert.equal(dev.caps.size, 0);
  });

  test('adds a titled capability per phase when on and the meter has three phases, then writes values', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [1000, 200, 0]) }));
    assert.deepEqual([...dev.caps].sort(), ['measure_power.l1', 'measure_power.l2', 'measure_power.l3']);
    assert.equal(dev.options.get('measure_power.l2').title.nl, 'Zonnevermogen L2');
    assert.equal(dev.values.get('measure_power.l1'), 1000);
    assert.equal(dev.values.get('measure_power.l3'), 0);
  });

  test('a two-phase meter gets L1 and L2 only', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(2, [5, 6]) }));
    assert.deepEqual([...dev.caps].sort(), ['measure_power.l1', 'measure_power.l2']);
  });

  test('the grid device gets grid power, grid voltage and home power families', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, GRID_PHASE_GROUPS, true);
    await pc.update(stateOf({
      gridW: block(3, [-1, 2, 3]), gridV: block(3, [231, 230, 229]), homeW: block(3, [4, 5, 6]),
    }));
    assert.equal(dev.caps.size, 9);
    assert.equal(dev.values.get('measure_voltage.l3'), 229);
    assert.equal(dev.values.get('measure_power.home_l2'), 5);
    assert.equal(dev.values.get('measure_power.l1'), -1);
    assert.equal(dev.options.get('measure_voltage.l1').title.en, 'Grid voltage L1');
  });

  test('home power per phase is skipped when it is not available, the rest still works', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, GRID_PHASE_GROUPS, true);
    await pc.update(stateOf({
      gridW: block(3, [1, 2, 3]), gridV: block(3, [230, 230, 230]), homeW: block(0, null, { status: 'absent' }),
    }));
    assert.equal(dev.caps.size, 6);
    assert.equal(dev.caps.has('measure_power.home_l1'), false);
  });

  test('turning the setting off removes the capabilities straight away', async () => {
    const dev = fakeDevice(['measure_power.l1', 'measure_power.l2', 'measure_power.l3']);
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    pc.setEnabled(false);
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3]) }));
    assert.equal(dev.caps.size, 0);
  });

  test('turning off works without a snapshot, turning on waits for one', async () => {
    const dev = fakeDevice(['measure_power.l1']);
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    pc.setEnabled(false);
    await pc.update(null);
    assert.equal(dev.caps.size, 0);
    pc.setEnabled(true);
    await pc.update(null);
    assert.equal(dev.caps.size, 0);
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3]) }));
    assert.equal(dev.caps.size, 3);
  });

  test('a stale, unknown or briefly missing phase set neither removes capabilities nor writes zero', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [10, 20, 30]) }));
    await pc.update(stateOf({ solarW: block(3, null, { status: 'stale' }) }));
    await pc.update(stateOf({ solarW: block(null, null, { status: 'unknown' }) }));
    await pc.update(null);
    for (let i = 0; i < REMOVE_AFTER_SNAPSHOTS - 1; i++) {
      await pc.update(stateOf({ solarW: block(0, null, { status: 'absent' }) }));
    }
    assert.equal(dev.caps.size, 3);
    assert.equal(dev.values.get('measure_power.l1'), 10);
  });

  test('capabilities are removed after consecutive "not available" snapshots, and a good one resets the count', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3]) }));
    for (let i = 0; i < REMOVE_AFTER_SNAPSHOTS - 1; i++) {
      await pc.update(stateOf({ solarW: block(0, null, { status: 'absent' }) }));
    }
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3], { observedAt: NOW + 1 }) }));
    for (let i = 0; i < REMOVE_AFTER_SNAPSHOTS - 1; i++) {
      await pc.update(stateOf({ solarW: block(0, null, { status: 'absent' }) }));
    }
    assert.equal(dev.caps.size, 3);
    await pc.update(stateOf({ solarW: block(0, null, { status: 'absent' }) }));
    assert.equal(dev.caps.size, 0);
  });

  test('an older observation does not overwrite a newer value', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [1, 1, 1], { observedAt: NOW }) }));
    await pc.update(stateOf({ solarW: block(3, [9, 9, 9], { observedAt: NOW - 5000 }) }));
    assert.equal(dev.values.get('measure_power.l1'), 1);
  });

  test('null entries are skipped and a failing device call does not break the queue', async () => {
    const dev = fakeDevice();
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [null, 20, 30]) }));
    assert.equal(dev.values.has('measure_power.l1'), false);
    assert.equal(dev.values.get('measure_power.l2'), 20);

    dev.setCapabilityValue = async () => {
      throw new Error('boom');
    };
    await pc.update(stateOf({ solarW: block(3, [7, 8, 9], { observedAt: NOW + 10 }) }));
    assert.ok(dev.errors.some((l) => l.includes('boom')));
    dev.setCapabilityValue = async (id, v) => {
      dev.values.set(id, v);
    };
    await pc.update(stateOf({ solarW: block(3, [7, 8, 9], { observedAt: NOW + 20 }) }));
    assert.equal(dev.values.get('measure_power.l1'), 7);
  });

  test('a destroyed device is left alone', async () => {
    const dev = fakeDevice();
    dev.destroyed = true;
    const pc = new PhaseCapabilities(dev, SOLAR_PHASE_GROUPS, true);
    await pc.update(stateOf({ solarW: block(3, [1, 2, 3]) }));
    assert.equal(dev.caps.size, 0);
  });
});
