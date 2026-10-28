'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('./helpers/homeyStub');

const { shouldLogAgain } = require('../lib/helpers');
const EnphaseController = require('../app');

const SERIAL = '123456789012';
const NOW = 1700000010000;

const field = (status, over = {}) => ({
  observedAt: NOW - 120000, status, source: 'meters', staleAfterMs: 45000, ...over,
});

test.describe('shouldLogAgain', () => {
  test('logs the first time, on a changed signature, and after the interval', () => {
    const seen = new Map();
    assert.equal(shouldLogAgain(seen, 'a', 'stale', 0, 1000), true);
    assert.equal(shouldLogAgain(seen, 'a', 'stale', 500, 1000), false);
    assert.equal(shouldLogAgain(seen, 'a', 'unknown', 600, 1000), true);
    assert.equal(shouldLogAgain(seen, 'a', 'unknown', 1600, 1000), true);
    assert.equal(shouldLogAgain(seen, 'b', 'stale', 1600, 1000), true);
  });

  test('an infinite interval logs an unchanged signature only once', () => {
    const seen = new Map();
    assert.equal(shouldLogAgain(seen, 'a', 'unknown', 0, Infinity), true);
    assert.equal(shouldLogAgain(seen, 'a', 'unknown', 1e12, Infinity), false);
  });
});

test.describe('EnphaseController skipped reading diagnostics', () => {
  const makeApp = () => {
    const lines = [];
    const app = { log: (msg) => lines.push(msg), error: (msg) => lines.push(`ERR ${msg}`) };
    return { app, lines, run: (rt, state) => EnphaseController.prototype._logSkippedReadings.call(app, rt, state) };
  };
  const stateOf = (fields, ts = NOW) => ({ ts, fields });

  test('a stale power reading logs its age and limit once, then again after 5 minutes', () => {
    const { lines, run } = makeApp();
    const rt = { serial: SERIAL, skipLog: new Map() };
    run(rt, stateOf({ solarW: field('stale') }));
    run(rt, stateOf({ solarW: field('stale') }, NOW + 60000));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /solarW reading skipped \(stale, source meters, 120 s old, fresh only up to 45 s\)/);
    run(rt, stateOf({ solarW: field('stale') }, NOW + 300001));
    assert.equal(lines.length, 2);
  });

  test('an unknown reading is logged once, a recovery once, and fresh fields stay silent', () => {
    const { lines, run } = makeApp();
    const rt = { serial: SERIAL };
    run(rt, stateOf({ gridW: field('unknown', { observedAt: null, source: null, staleAfterMs: null }) }));
    run(rt, stateOf({ gridW: field('unknown', { observedAt: null, source: null, staleAfterMs: null }) }, NOW + 900000));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /gridW reading skipped \(unknown, source none, no reading yet\)/);
    run(rt, stateOf({ gridW: field('fresh') }));
    assert.equal(lines.length, 2);
    assert.match(lines[1], /gridW reading is fresh again/);
    run(rt, stateOf({ gridW: field('fresh') }));
    assert.equal(lines.length, 2);
  });

  test('absent and non-power fields are not logged, and a malformed state never throws', () => {
    const { lines, run } = makeApp();
    const rt = { serial: SERIAL };
    run(rt, stateOf({ homeW: field('absent'), batteryW: field('stale') }));
    run(rt, null);
    assert.equal(lines.filter((l) => !l.startsWith('ERR')).length, 0);
  });
});
