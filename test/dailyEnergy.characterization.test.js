/* eslint-disable mocha/handle-done-callback -- node:test passes a TestContext, not a done callback */

'use strict';

// Characterization of the CURRENT daily-energy and local-day behavior, recorded before stage 1 of
// .agents/plan/codebase-optimization.md changes it. These tests pin what the code does today, including the known
// weaknesses (marked "KNOWN LIMITATION"), so that stage 1 changes them on purpose and visibly. When stage 1 moves
// the calculation into a shared module, port these cases to it and update the limitation tests together with the
// fix.

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homeyStub');

const SolarDevice = require('../drivers/solar/device');
const GridDevice = require('../drivers/grid/device');
const InvertersDevice = require('../drivers/inverters/device');
const EnphaseController = require('../app');

/** Fake `this` for the device methods: an in-memory store and a call log. */
function fakeDevice(initialStore = {}) {
  const store = { ...initialStore };
  const writes = [];
  return {
    store,
    writes,
    log() { },
    error() { },
    getStoreValue: (key) => store[key],
    async setStoreValue(key, value) {
      store[key] = value;
      writes.push([key, value]);
    },
  };
}

test.describe('solar calculateDailyEnergy (current behavior)', () => {
  const calc = (dev, lifetime, day) => SolarDevice.prototype.calculateDailyEnergy.call(dev, { kwhLifetime: lifetime }, day);

  test('first poll ever: stores the baseline and reports 0', async () => {
    const dev = fakeDevice();
    assert.equal(await calc(dev, 1000, 8), 0);
    assert.equal(dev.store.today_day, 8);
    assert.equal(dev.store.today_start_kwh, 1000);
  });

  test('same day: energy today is lifetime minus the stored baseline, rounded to 0.01 kWh', async () => {
    const dev = fakeDevice({ today_day: 8, today_start_kwh: 1000 });
    assert.equal(await calc(dev, 1003.4567, 8), 3.46);
    assert.deepEqual(dev.writes, []); // nothing rewritten while the baseline is valid
  });

  test('a different day number re-baselines to the current lifetime counter', async () => {
    const dev = fakeDevice({ today_day: 8, today_start_kwh: 1000 });
    assert.equal(await calc(dev, 1010, 9), 0);
    assert.equal(dev.store.today_day, 9);
    assert.equal(dev.store.today_start_kwh, 1010);
  });

  test('a missing or non-numeric baseline value is treated as a new day', async () => {
    const dev = fakeDevice({ today_day: 8, today_start_kwh: '1000' });
    assert.equal(await calc(dev, 1005, 8), 0);
    assert.equal(dev.store.today_start_kwh, 1005);
  });

  test('lifetime counter below the baseline (reset or replacement): baseline follows the counter, today restarts at 0', async () => {
    const dev = fakeDevice({ today_day: 8, today_start_kwh: 1000 });
    assert.equal(await calc(dev, 50, 8), 0);
    assert.equal(dev.store.today_start_kwh, 50);
    assert.equal(dev.store.today_day, 8);
    assert.equal(await calc(dev, 52.5, 8), 2.5); // and accumulation continues from the new baseline
  });

  test('KNOWN LIMITATION: the same day number in a later month looks like the same day', async () => {
    // Documentation only: the input is the same as for "same day" because the stored value has no month, which is the
    // limitation. Baseline stored on the 8th of one month, read on the 8th of the next: no reset, so today shows a
    // month of energy.
    const dev = fakeDevice({ today_day: 8, today_start_kwh: 1000 });
    assert.equal(await calc(dev, 1400, 8), 400);
  });

  test('the stored day is a bare day-of-month number', async () => {
    const dev = fakeDevice();
    await calc(dev, 10, 31);
    assert.equal(typeof dev.store.today_day, 'number');
    assert.equal(dev.store.today_day, 31);
  });
});

test.describe('grid calculateDailyEnergy (current behavior)', () => {
  const calc = (dev, lifetime, day, suffix) => GridDevice.prototype.calculateDailyEnergy.call(dev, lifetime, day, suffix);

  test('the four counters keep independent baselines under suffixed store keys', async () => {
    const dev = fakeDevice();
    const suffixes = ['_gridpower_import', '_gridpower_export', '_homepower_import', '_homepower_export'];
    const lifetimes = [100, 200, 300, 400];
    for (let i = 0; i < suffixes.length; i += 1) {
      assert.equal(await calc(dev, lifetimes[i], 8, suffixes[i]), 0);
    }
    for (let i = 0; i < suffixes.length; i += 1) {
      assert.equal(dev.store[`today_day${suffixes[i]}`], 8);
      assert.equal(dev.store[`today_start_kwh${suffixes[i]}`], lifetimes[i]);
    }
    assert.equal(await calc(dev, 101.25, 8, suffixes[0]), 1.25);
    assert.equal(await calc(dev, 200, 8, suffixes[1]), 0);
  });

  test('a reset of one counter does not touch the others', async () => {
    const dev = fakeDevice({
      today_day_gridpower_import: 8,
      today_start_kwh_gridpower_import: 100,
      today_day_gridpower_export: 8,
      today_start_kwh_gridpower_export: 200,
    });
    assert.equal(await calc(dev, 5, 8, '_gridpower_import'), 0);
    assert.equal(dev.store.today_start_kwh_gridpower_import, 5);
    assert.equal(dev.store.today_start_kwh_gridpower_export, 200);
  });

  test('new day re-baselines; same day accumulates; rounding is 0.01 kWh', async () => {
    const dev = fakeDevice({ today_day_gridpower_import: 8, today_start_kwh_gridpower_import: 100 });
    assert.equal(await calc(dev, 102.499, 8, '_gridpower_import'), 2.5);
    assert.equal(await calc(dev, 110, 9, '_gridpower_import'), 0);
    assert.equal(dev.store.today_start_kwh_gridpower_import, 110);
  });

  test('without a suffix the unsuffixed keys are used', async () => {
    const dev = fakeDevice();
    await calc(dev, 7, 3);
    assert.equal(dev.store.today_day, 3);
    assert.equal(dev.store.today_start_kwh, 7);
  });

  test('KNOWN LIMITATION: same day number in a later month is not detected', async () => {
    // Documentation only (see the solar case): without a month in the stored day this input is a normal same-day read.
    const dev = fakeDevice({ today_day_homepower_import: 8, today_start_kwh_homepower_import: 100 });
    assert.equal(await calc(dev, 600, 8, '_homepower_import'), 500);
  });
});

test.describe('inverters handleNewDay (current behavior)', () => {
  const run = async (state, day, serials = ['A'], store = {}) => {
    const dev = fakeDevice(store);
    dev.fallbackCalls = [];
    dev.evaluateUnderperformance = async (...args) => {
      dev.fallbackCalls.push(args);
    };
    const annualPeaks = {};
    await InvertersDevice.prototype.handleNewDay.call(dev, state, serials, annualPeaks, day);
    dev.annualPeaks = annualPeaks;
    return dev;
  };

  test('new day clears the per-day evaluation flags', async () => {
    const state = { A: { lastResetDay: 8, meter_power_today: 1, dailyPeakWatts: 1 } };
    const dev = await run(state, 9, ['A'], { underperfEvaluatedToday: true, hasBeenNonZeroToday: true });
    assert.equal(dev.store.underperfEvaluatedToday, false);
    assert.equal(dev.store.hasBeenNonZeroToday, false);
  });

  test('new day runs the missed-sunset underperformance fallback only when it was not evaluated and power was seen', async () => {
    const mk = () => ({ A: { lastResetDay: 8, meter_power_today: 1, dailyPeakWatts: 1 } });
    const missed = await run(mk(), 9, ['A'], { underperfEvaluatedToday: false, hasBeenNonZeroToday: true });
    assert.equal(missed.fallbackCalls.length, 1);
    assert.equal(missed.fallbackCalls[0][3], true); // forced evaluation
    const done = await run(mk(), 9, ['A'], { underperfEvaluatedToday: true, hasBeenNonZeroToday: true });
    assert.equal(done.fallbackCalls.length, 0);
    const idle = await run(mk(), 9, ['A'], { underperfEvaluatedToday: false, hasBeenNonZeroToday: false });
    assert.equal(idle.fallbackCalls.length, 0);
  });

  test('the fallback runs before the daily values are reset', async () => {
    const state = { A: { lastResetDay: 8, meter_power_today: 5, dailyPeakWatts: 7 } };
    const seen = [];
    const dev = fakeDevice({ underperfEvaluatedToday: false, hasBeenNonZeroToday: true });
    dev.evaluateUnderperformance = async (s) => {
      seen.push({ ...s.A });
    };
    await InvertersDevice.prototype.handleNewDay.call(dev, state, ['A'], {}, 9);
    assert.equal(seen[0].meter_power_today, 5);
    assert.equal(seen[0].dailyPeakWatts, 7);
  });

  test('unchanged day leaves the evaluation flags alone', async () => {
    const state = { A: { lastResetDay: 8, meter_power_today: 1, dailyPeakWatts: 1 } };
    const dev = await run(state, 8, ['A'], { underperfEvaluatedToday: true, hasBeenNonZeroToday: true });
    assert.equal(dev.store.underperfEvaluatedToday, true);
    assert.equal(dev.store.hasBeenNonZeroToday, true);
    assert.deepEqual(dev.writes, []);
  });

  test('resets the daily energy and peak of every inverter when the stored day differs', async () => {
    const state = {
      A: { lastResetDay: 8, meter_power_today: 1.5, dailyPeakWatts: 300 },
      B: { lastResetDay: 8, meter_power_today: 2, dailyPeakWatts: 200 },
    };
    await run(state, 9, ['A', 'B']);
    assert.deepEqual(state.A, { lastResetDay: 9, meter_power_today: 0, dailyPeakWatts: 0 });
    assert.equal(state.B.meter_power_today, 0);
  });

  test('keeps the values while the stored day matches', async () => {
    const state = { A: { lastResetDay: 8, meter_power_today: 1.5, dailyPeakWatts: 300 } };
    await run(state, 8);
    assert.equal(state.A.meter_power_today, 1.5);
  });

  test('KNOWN LIMITATION: only the day of month is compared, so a same-numbered day in a later month is not a new day', async () => {
    // Documentation only: identical to the "stored day matches" input, because lastResetDay has no month.
    const state = { A: { lastResetDay: 8, meter_power_today: 9.9, dailyPeakWatts: 300 } };
    await run(state, 8);
    assert.equal(state.A.meter_power_today, 9.9);
  });

  test('the first inverter decides: no state for it means no reset', async () => {
    const state = { B: { lastResetDay: 1, meter_power_today: 4, dailyPeakWatts: 1 } };
    await run(state, 9, ['A', 'B']);
    assert.equal(state.B.meter_power_today, 4);
  });
});

test.describe('app.getLocalDayOfMonth (current behavior)', () => {
  // Returns dayAt(iso, timezone): the local day of month at that instant. The mocked clock is enabled once per test
  // and only moved afterwards.
  const clock = (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    return async (iso, timezone, errors = []) => {
      t.mock.timers.setTime(new Date(iso).getTime());
      const app = { getTimezone: async () => timezone, error: (...args) => errors.push(args) };
      return EnphaseController.prototype.getLocalDayOfMonth.call(app);
    };
  };

  test('uses the Homey timezone, not UTC: just after local midnight is already the next day', async (t) => {
    const dayAt = clock(t);
    // 2026-01-14 23:30 UTC is 00:30 on the 15th in Amsterdam (UTC+1)
    assert.equal(await dayAt('2026-01-14T23:30:00Z', 'Europe/Amsterdam'), 15);
  });

  test('just before local midnight is still the same day', async (t) => {
    const dayAt = clock(t);
    assert.equal(await dayAt('2026-01-14T22:59:00Z', 'Europe/Amsterdam'), 14);
  });

  test('DST: spring forward (UTC+1 to UTC+2, 2026-03-29)', async (t) => {
    const dayAt = clock(t);
    assert.equal(await dayAt('2026-03-28T23:30:00Z', 'Europe/Amsterdam'), 29); // 00:30 CET
    assert.equal(await dayAt('2026-03-29T21:59:00Z', 'Europe/Amsterdam'), 29); // 23:59 CEST
    assert.equal(await dayAt('2026-03-29T22:00:00Z', 'Europe/Amsterdam'), 30); // 00:00 CEST
  });

  test('DST: fall back (UTC+2 to UTC+1, 2026-10-25)', async (t) => {
    const dayAt = clock(t);
    assert.equal(await dayAt('2026-10-24T22:00:00Z', 'Europe/Amsterdam'), 25); // 00:00 CEST
    assert.equal(await dayAt('2026-10-25T22:59:00Z', 'Europe/Amsterdam'), 25); // 23:59 CET
    assert.equal(await dayAt('2026-10-25T23:00:00Z', 'Europe/Amsterdam'), 26); // 00:00 CET
  });

  test('month and year rollover only change the day number, which is all that is returned', async (t) => {
    const dayAt = clock(t);
    assert.equal(await dayAt('2026-12-31T23:30:00Z', 'Europe/Amsterdam'), 1); // 00:30 on 1 January
    assert.equal(await dayAt('2026-02-28T23:30:00Z', 'Europe/Amsterdam'), 1); // 00:30 on 1 March
  });

  test('an invalid timezone falls back to the process clock day', async (t) => {
    const dayAt = clock(t);
    const errors = [];
    assert.equal(await dayAt('2026-06-10T12:00:00Z', 'Not/AZone', errors), new Date().getDate());
    assert.equal(errors.length, 1); // the failure is reported, not swallowed
  });
});

test.describe('which clock each driver uses for its day (current behavior)', () => {
  // The wiring between "what day is it" and the daily baseline is the code stage 1 changes. solar and grid use the
  // PROCESS clock (`new Date().getDate()`, UTC on Homey Pro, to be confirmed on hardware); inverters ask the app for
  // the day in Homey's timezone. Each fake exposes a Homey-timezone day (SENTINEL) that is deliberately unlike any
  // real day of month, so it is clear which source reached the stored value.
  const SENTINEL = 99;

  const homeyWithLocalDay = () => ({
    app: {
      localDayCalls: 0,
      async getLocalDayOfMonth() {
        this.localDayCalls += 1;
        return SENTINEL;
      },
    },
    flow: { getDeviceTriggerCard: () => null },
  });

  test('grid.updateTelemetry baselines on the process-clock day, not the Homey-timezone day', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-14T23:30:00Z').getTime() });
    const dev = fakeDevice();
    Object.assign(dev, {
      homey: homeyWithLocalDay(),
      hasHomepower: false,
      hasGridpower: true,
      isMetered: true,
      hasCapability: () => false,
      setCapabilityValue: async () => { },
      calculateDailyEnergy: GridDevice.prototype.calculateDailyEnergy,
    });
    await GridDevice.prototype.updateTelemetry.call(dev, {
      gridpowerKwhImported: 100,
      gridpowerKwhExported: 50,
      hasHomepower: false,
      hasGridpower: true,
      isMetered: true,
    });
    assert.equal(dev.store.today_day_gridpower_import, new Date().getDate());
    assert.equal(dev.store.today_day_gridpower_export, new Date().getDate());
    assert.notEqual(dev.store.today_day_gridpower_import, SENTINEL);
    assert.equal(dev.homey.app.localDayCalls, 0);
  });

  test('grid.updateTelemetry gives the home counters the same process-clock day', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-14T23:30:00Z').getTime() });
    const dev = fakeDevice();
    Object.assign(dev, {
      homey: homeyWithLocalDay(),
      hasHomepower: true,
      hasGridpower: true,
      isMetered: true,
      hasCapability: () => false,
      getCapabilityValue: () => null,
      setCapabilityValue: async () => { },
      calculateDailyEnergy: GridDevice.prototype.calculateDailyEnergy,
    });
    await GridDevice.prototype.updateTelemetry.call(dev, {
      gridpowerKwhImported: 1,
      gridpowerKwhExported: 2,
      homepowerKwhImported: 3,
      homepowerKwhExported: 4,
      hasHomepower: true,
      hasGridpower: true,
      isMetered: true,
    });
    const day = new Date().getDate();
    assert.equal(dev.store.today_day_homepower_import, day);
    assert.equal(dev.store.today_day_homepower_export, day);
  });

  test('solar.updateTelemetry baselines on the process-clock day, not the Homey-timezone day', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-14T23:30:00Z').getTime() });
    const dev = fakeDevice();
    Object.assign(dev, {
      homey: homeyWithLocalDay(),
      isMetered: false,
      isMaintainer: false,
      productionLimiting: false,
      hasCapability: () => false,
      checkForCloudOverride: async () => false,
      calculateDailyEnergy: SolarDevice.prototype.calculateDailyEnergy,
      updateMeteredStatus: async () => { },
      ensurePelCapabilities: async () => { },
      updateDeviceCapabilities: async () => { },
    });
    await SolarDevice.prototype.updateTelemetry.call(dev, { kwhLifetime: 1000, isMetered: false }, false, null);
    assert.equal(dev.store.today_day, new Date().getDate());
    assert.notEqual(dev.store.today_day, SENTINEL);
    assert.equal(dev.homey.app.localDayCalls, 0);
  });

  test('inverters.updateTelemetry uses the Homey-timezone day for new records and for the daily reset', async () => {
    const dev = fakeDevice({ inverters: ['A'], invertersData: {} });
    Object.assign(dev, {
      homey: homeyWithLocalDay(),
      setCapabilityValue: async () => { },
      validateTelemetry: async () => true,
      updateAggregates: async () => ({ averagePower: 0 }),
      evaluateAlerts: async () => { },
      evaluateUnderperformance: async () => { },
      handleNewDay: InvertersDevice.prototype.handleNewDay,
      processInverterReadings: InvertersDevice.prototype.processInverterReadings,
    });
    const reading = [{
      serialNumber: 'A', lastReportWatts: 100, lastReportDate: 1700000000, maxReportWatts: 250,
    }];

    await InvertersDevice.prototype.updateTelemetry.call(dev, reading);
    assert.equal(dev.store.invertersData.A.lastResetDay, SENTINEL);

    // A later poll on another Homey-timezone day resets the daily values and records the new day.
    dev.store.invertersData.A.meter_power_today = 3;
    dev.homey.app.getLocalDayOfMonth = async () => SENTINEL + 1;
    await InvertersDevice.prototype.updateTelemetry.call(dev, reading);
    assert.equal(dev.store.invertersData.A.lastResetDay, SENTINEL + 1);
    assert.equal(dev.store.invertersData.A.meter_power_today, 0);
  });
});
