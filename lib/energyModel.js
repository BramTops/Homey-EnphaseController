/* eslint-disable max-classes-per-file, no-nested-ternary */

'use strict';

/**
 * Energy model: the one place for sign conventions, unit conversions, derivations, freshness rules and battery
 * energy counters of the per-gateway state snapshot. No network, no Homey objects: callers feed raw gateway
 * responses in and get a frozen snapshot out.
 *
 * Portions adapted from nklerk/nl.nielsdeklerk.enphase @728201bf, MIT License, Copyright (c) 2026 Niels de Klerk
 * (grid-tie status detection, the `devices:` key quirk, the milliwatt battery power key and the sign flip).
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 * Conventions (snapshot, Homey side):
 *  - power in W, energy in kWh, SoC in %; timestamps are epoch milliseconds.
 *  - gridW: + import, - export. Source: net-consumption CT `activePower`, + = import. This matches the legacy
 *    homeload behaviour; upstream marks the sign as not verified against a clear import/export event.
 *  - batteryW: + charging, - discharging. The gateway reports the opposite (raw + = discharging, - = charging,
 *    confirmed once against the Enlighten live view by upstream, consistent with the Enphase brief's livedata
 *    sample). The flip happens exactly once, in parseBatteryPower().
 *  - solarW is clamped >= 0 BEFORE any derivation (production CT can read slightly negative at night).
 *  - homeW is clamped >= 0. Measured: total-consumption CT. Derived: solarW + gridW - batteryW. A negative raw
 *    result means the inputs were sampled at slightly different moments (timing skew), not negative consumption.
 *  - null = unknown/unreadable. Zero is a valid measured idle value and the value of a known-absent battery.
 */

const SLOW_INTERVAL_SECONDS = 120;
const GRID_SIGN = 1; // net-consumption activePower: + = import
const BATTERY_SIGN = -1; // raw gateway battery power -> Homey (+ charging)

// Freshness: stale begins after at most three expected update intervals of the source. The expected
// interval is the fast tier interval, or the source's measured cadence when the gateway updates slower than we
// poll. Gateway reading timestamps are used where present (an old report stays stale even if HTTP succeeded).
const MIN_STALE_MS = 15000;
const MAX_STALE_MS = 900000; // Enphase brief: several gateway aggregates update only every 5 minutes
const PRODUCTION_MIN_STALE_MS = 360000; // 3 x the 120 s slow tier
const INVENTORY_STALE_MS = 180000; // 3 x the 60 s inventory refresh while a battery is present
const INVENTORY_ABSENT_STALE_MS = 1800000; // 3 x the 10 min re-detection cadence when no battery was found
const MAX_FUTURE_SKEW_MS = 600000; // reading timestamps further ahead than this are treated as gateway clock errors

// Battery counters
const PERSIST_INTERVAL_MS = 60000;
const MAX_METER_KW = 25; // plausibility bound for a storage-meter counter jump
const VOTES_REQUIRED = 3; // consistent direction observations before storage-meter counters are trusted

const monoMs = () => Number(process.hrtime.bigint() / 1000000n);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v));
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits) => {
  if (!finite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/**
 * Gateway reading timestamp (epoch seconds, or milliseconds) -> epoch ms. A timestamp unreasonably far in the future
 * is a clock error and falls back to the collection time; an old timestamp is kept so the reading goes stale.
 */
function readingTimeMs(value, receivedAt) {
  const n = num(value);
  if (n === null || n <= 0) return receivedAt;
  const ms = n > 1e11 ? n : n * 1000;
  if (ms - receivedAt > MAX_FUTURE_SKEW_MS) return receivedAt;
  return Math.min(ms, receivedAt);
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    Object.keys(obj).forEach((k) => deepFreeze(obj[k]));
  }
  return obj;
}

/**
 * Classify the /ivp/meters configuration list. Readings carry only an eid, the role lives here.
 * has.* is tri-state: null while the configuration is unknown. A generic `consumption` CT (older firmware) is
 * ambiguous between grid and home and is never used for either without configuration evidence, so with only a
 * generic CT enabled gridMeter/homeMeter stay null.
 * @param {Array<Object>|null} list - /ivp/meters response (null = unknown)
 * @returns {Object} { known, production, net, total, generic, storage, readable, has }
 */
function classifyMeters(list) {
  const out = {
    known: false, production: null, net: null, total: null, generic: null, storage: null, readable: false,
  };
  if (Array.isArray(list)) {
    out.known = true;
    const roleOf = {
      production: 'production', 'net-consumption': 'net', 'total-consumption': 'total', consumption: 'generic', storage: 'storage',
    };
    for (const m of list) {
      if (!m || m.eid === undefined || m.eid === null) continue;
      const role = roleOf[m.measurementType];
      if (role && !out[role]) out[role] = { eid: m.eid, enabled: m.state === 'enabled' };
    }
    out.readable = [out.production, out.net, out.total, out.storage].some((r) => r && r.enabled);
  }
  const on = (r) => !!(r && r.enabled);
  const ambiguous = on(out.generic);
  out.has = {
    productionMeter: out.known ? on(out.production) : null,
    gridMeter: out.known ? (on(out.net) ? true : (ambiguous && !out.net ? null : false)) : null,
    homeMeter: out.known ? (on(out.total) ? true : (ambiguous && !out.total ? null : false)) : null,
  };
  return out;
}

/**
 * Extract the enabled meters' readings from /ivp/meters/readings.
 * @param {Array<Object>} json - Readings response
 * @param {Object} cfg - classifyMeters() result
 * @param {number} receivedAt - Collection time (ms)
 * @returns {Object} roles: { production, net, total, storage } each { w, dlvd, rcvd, observedAt } (kWh) or null
 */
function parseMeterReadings(json, cfg, receivedAt) {
  if (!Array.isArray(json)) throw new Error('Meter readings response is not a list');
  const roles = {
    production: null, net: null, total: null, storage: null,
  };
  Object.keys(roles).forEach((role) => {
    const rec = cfg[role];
    if (!rec || !rec.enabled) return;
    const entry = json.find((e) => e && e.eid === rec.eid);
    if (!entry) return;
    const dlvd = num(entry.actEnergyDlvd);
    const rcvd = num(entry.actEnergyRcvd);
    roles[role] = {
      eid: rec.eid,
      w: num(entry.activePower),
      dlvd: dlvd === null ? null : dlvd / 1000,
      rcvd: rcvd === null ? null : rcvd / 1000,
      observedAt: readingTimeMs(entry.timestamp, receivedAt),
    };
  });
  return roles;
}

/**
 * Parse /ivp/ensemble/power. The unit list is under `devices` or, on observed firmware, the literal key `devices:`.
 * Power: `real_power_mw` (milliwatts), else `real_power_w` (watts, where present). An upstream `realPower`-as-watts
 * fallback is unverified and deliberately not used. Raw + = discharging; flipped here to the Homey sign. A unit with
 * no readable power makes the total null (a partial sum would be wrong); null never becomes 0.
 * @param {Object} json - Ensemble power response
 * @returns {{ units: Array<{serial: string|null, w: number|null, soc: number|null}>, totalW: number|null }}
 */
function parseBatteryPower(json) {
  if (!json || typeof json !== 'object') throw new Error('Ensemble power response is not an object');
  const list = json.devices || json['devices:'];
  if (list !== undefined && !Array.isArray(list)) throw new Error('Ensemble power device list is not a list');
  const units = (list || []).filter((d) => d && typeof d === 'object').map((d) => {
    const mw = num(d.real_power_mw);
    const watts = mw !== null ? mw / 1000 : num(d.real_power_w);
    const soc = num(d.soc);
    return {
      serial: d.serial_num !== undefined && d.serial_num !== null ? String(d.serial_num) : null,
      w: watts === null ? null : BATTERY_SIGN * watts,
      soc: soc !== null && soc >= 0 && soc <= 100 ? soc : null,
    };
  });
  const totalW = units.length > 0 && units.every((u) => u.w !== null) ? units.reduce((s, u) => s + u.w, 0) : null;
  return { units, totalW };
}

/**
 * Grid-tie status from the Ensemble inventory (adapted from upstream): ENPOWER (system controller) first, then the
 * batteries' reported grid state. Unknown when nothing reports; we never claim 'disconnected' without evidence.
 * @param {Array<Object>} groups - Inventory groups
 * @returns {'connected'|'disconnected'|'unknown'}
 */
function deriveGridStatus(groups) {
  const devicesOf = (type) => {
    const g = groups.find((x) => x && x.type === type);
    return g && Array.isArray(g.devices) ? g.devices : [];
  };
  const enpower = devicesOf('ENPOWER');
  if (enpower.length > 0) {
    const d = enpower[0];
    if (d.mains_oper_state === 'open' || /off.?grid|island/i.test(d.Enpwr_grid_mode || '')) return 'disconnected';
    if (d.mains_oper_state === 'closed' || /on.?grid/i.test(d.Enpwr_grid_mode || '')) return 'connected';
  }
  const states = devicesOf('ENCHARGE').map((e) => e.reported_enc_grid_state).filter(Boolean);
  if (states.length > 0) {
    if (states.every((s) => /off.?grid|island/i.test(s))) return 'disconnected';
    if (states.some((s) => /grid.?tied|on.?grid/i.test(s))) return 'connected';
  }
  return 'unknown';
}

/**
 * Parse /ivp/ensemble/inventory (array of groups { type, devices }). A successful response without ENCHARGE devices
 * proves there is no battery. `part_num` and `encharge_capacity` are used by pyenphase but unverified on our
 * hardware: optional, never required (missing -> SoC falls to the next rule tier or null). Capacity is assumed Wh.
 * @param {Array<Object>} json - Inventory response
 * @returns {{ hasBattery: boolean, units: Array<Object>, gridStatus: string }}
 */
function parseInventory(json) {
  if (!Array.isArray(json)) throw new Error('Ensemble inventory response is not a list');
  const group = json.find((g) => g && g.type === 'ENCHARGE');
  const devices = group && Array.isArray(group.devices) ? group.devices : [];
  const units = devices.filter((d) => d && typeof d === 'object').map((d) => {
    const pct = num(d.percentFull);
    const cap = num(d.encharge_capacity);
    return {
      serial: d.serial_num !== undefined && d.serial_num !== null ? String(d.serial_num) : null,
      partNum: typeof d.part_num === 'string' && d.part_num ? d.part_num : null,
      capacity: cap !== null && cap > 0 ? cap : null,
      percentFull: pct !== null && pct >= 0 && pct <= 100 ? pct : null,
    };
  });
  return { hasBattery: units.length > 0, units, gridStatus: deriveGridStatus(json) };
}

/**
 * Aggregate SoC: capacity-weighted mean when every unit's capacity is known; plain mean only when all
 * units share the same part number (a single unit qualifies); otherwise null. A gateway aggregate (priority 1) is
 * not read. Different battery models never get an unweighted mean.
 * @param {Array<{serial: string|null, soc: number}>} socUnits - One SoC per unit, from ONE source (never mixed)
 * @param {Array<Object>} invUnits - Inventory units (capacity / part number lookup by serial)
 * @returns {number|null}
 */
function aggregateSoc(socUnits, invUnits) {
  if (!socUnits || socUnits.length === 0) return null;
  const bySerial = new Map((invUnits || []).filter((u) => u.serial).map((u) => [u.serial, u]));
  let value = null;
  if (socUnits.length === 1) {
    value = socUnits[0].soc;
  } else {
    const info = socUnits.map((u) => bySerial.get(u.serial) || null);
    if (info.every((i) => i && i.capacity)) {
      const total = info.reduce((s, i) => s + i.capacity, 0);
      value = socUnits.reduce((s, u, idx) => s + u.soc * info[idx].capacity, 0) / total;
    } else if (info.every((i) => i && i.partNum) && new Set(info.map((i) => i.partNum)).size === 1) {
      value = socUnits.reduce((s, u) => s + u.soc, 0) / socUnits.length;
    }
  }
  return value === null ? null : round(clamp(value, 0, 100), 1);
}

/**
 * Battery lifetime counters per gateway serial, persisted independently of any device (re-pairing never resets them).
 *
 * Two sources: a verified storage-meter's own lifetime counters (preferred) or integration of fresh battery power.
 * Totals are reported values: they only ever grow. Meters are never trusted until their direction is verified by
 * correlating counter deltas with integrated energy (consistent votes), and switching source / replacing a meter /
 * a meter reset only re-seeds a raw baseline, it never adds or removes energy from the totals.
 *
 * Integration uses the trapezoid of two consecutive fresh samples on a monotonic clock, never across restarts,
 * failed or stale samples, source changes, or gaps over two effective battery intervals. One counter gets each
 * interval (net sign of the averaged power), so a sign change never adds the same interval to both.
 * Abrupt-stop loss is bounded to the unpersisted window (<= 60 s of deltas); power is never extrapolated to
 * recover it. Integrated totals are estimates.
 */
class BatteryEnergyLedger {
  constructor(stored, log) {
    this.log = log || (() => { });
    this.s = BatteryEnergyLedger.sanitize(stored);
    this.started = this.s !== null;
    if (!this.s) {
      this.s = {
        v: 1, charged: 0, discharged: 0, source: null, dir: null, meter: null, votes: null, since: null, changes: 0, updatedAt: null,
      };
    }
    this.dirty = false;
    this.urgent = false;
    this.sessionUpdated = false;
    this.last = null; // last valid power sample { mono, w } of this process run
    this.coverage = false; // integrated energy since the meter baseline is gap-free
    this.acc = { c: 0, d: 0 }; // integrated kWh since the meter baseline (direction verification only)
  }

  static sanitize(stored) {
    let obj = stored;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch (err) {
        return null;
      }
    }
    if (!obj || typeof obj !== 'object' || !finite(obj.charged) || !finite(obj.discharged) || obj.charged < 0 || obj.discharged < 0) return null;
    const meter = obj.meter && finite(obj.meter.rcvd) && finite(obj.meter.dlvd) && finite(obj.meter.at) && obj.meter.id !== undefined
      ? {
        id: obj.meter.id, rcvd: obj.meter.rcvd, dlvd: obj.meter.dlvd, at: obj.meter.at,
      } : null;
    const dir = obj.dir === 'rcvd' || obj.dir === 'dlvd' ? obj.dir : null;
    const source = obj.source === 'integrated' || (obj.source === 'storage-meter' && dir && meter) ? obj.source : null;
    return {
      v: 1,
      charged: obj.charged,
      discharged: obj.discharged,
      source,
      dir,
      meter,
      votes: null,
      since: finite(obj.since) ? obj.since : null,
      changes: finite(obj.changes) ? obj.changes : 0,
      updatedAt: finite(obj.updatedAt) ? obj.updatedAt : null,
    };
  }

  get source() {
    return this.s.source;
  }

  /** Mark totals as existing (a battery was detected). */
  start() {
    if (!this.started) {
      this.started = true;
      this.dirty = true;
    }
  }

  totals() {
    return this.started ? { charged: this.s.charged, discharged: this.s.discharged } : null;
  }

  serialize() {
    return JSON.stringify(this.s);
  }

  /** Forget the previous power sample: no integration across failed/stale samples or restarts. */
  invalidate() {
    this.last = null;
    this.coverage = false;
  }

  _setSource(source) {
    if (this.s.source === source) return;
    this.log(`[Energy] Battery energy source ${this.s.source} -> ${source}`);
    this.s.source = source;
    this.s.since = Date.now();
    this.s.changes += 1;
    this.dirty = true;
    this.urgent = true; // persist right away on source changes
  }

  _touch(now) {
    this.s.updatedAt = now;
    this.sessionUpdated = true;
    this.dirty = true;
  }

  /**
   * Integrate one fresh battery power sample.
   * @param {number} w - Aggregate battery power (W, Homey sign)
   * @param {number} mono - Monotonic ms of the sample
   * @param {number} maxGapMs - Two effective battery intervals
   * @param {number} now - Wall clock ms (provenance only)
   */
  integrate(w, mono, maxGapMs, now) {
    if (this.s.source === 'storage-meter') { // the meter's counters cover this energy, including gaps
      this.invalidate();
      return;
    }
    const prev = this.last;
    this.last = { mono, w };
    if (!prev) return;
    const dt = mono - prev.mono;
    if (!(dt > 0) || dt > maxGapMs) {
      this.coverage = false;
      return;
    }
    this.start();
    this._setSource('integrated');
    const avg = (prev.w + w) / 2;
    const kWh = (Math.abs(avg) * (dt / 3600000)) / 1000;
    if (kWh > 0) {
      if (avg > 0) {
        this.s.charged += kWh; this.acc.c += kWh;
      } else {
        this.s.discharged += kWh; this.acc.d += kWh;
      }
    }
    this._touch(now);
  }

  _seed(reading, now) {
    this.s.meter = {
      id: reading.id, rcvd: reading.rcvd, dlvd: reading.dlvd, at: now,
    };
    this.acc = { c: 0, d: 0 };
    this.coverage = this.last !== null;
    this.dirty = true;
  }

  /**
   * Observe the storage meter's lifetime counters (kWh), or pass null when the config shows no enabled storage meter.
   * @param {{id: *, rcvd: number, dlvd: number}|null} reading
   * @param {number} now - Wall clock ms
   */
  observeMeter(reading, now) {
    if (!reading) {
      if (this.s.meter || this.s.source === 'storage-meter') {
        if (this.s.source === 'storage-meter') this._setSource('integrated');
        this.s.meter = null;
        this.s.dir = null;
        this.s.votes = null;
        this.dirty = true;
      }
      return;
    }
    const m = this.s.meter;
    if (!m || m.id !== reading.id) { // first sight or replaced meter: new baseline only, never a jump
      if (this.s.source === 'storage-meter') this._setSource('integrated');
      this.s.dir = null;
      this.s.votes = null;
      this._seed(reading, now);
      return;
    }
    const r = reading.rcvd - m.rcvd;
    const d = reading.dlvd - m.dlvd;
    const maxKWh = MAX_METER_KW * (Math.max(0, now - m.at) / 3600000) + 0.05;
    if (r < 0 || d < 0 || r > maxKWh || d > maxKWh) { // meter reset or implausible jump: re-seed, keep totals
      this.log('[Energy] Storage meter counters reset or jumped; re-seeding baseline.');
      this._seed(reading, now);
      return;
    }
    if (this.s.source === 'storage-meter') {
      const chargeDelta = this.s.dir === 'rcvd' ? r : d;
      const dischargeDelta = this.s.dir === 'rcvd' ? d : r;
      this.s.charged += chargeDelta;
      this.s.discharged += dischargeDelta;
      this._seed(reading, now);
      this._touch(now);
      return;
    }
    // Still integrating: verify the counter direction before trusting the meter.
    if (!this.coverage) {
      this._seed(reading, now); return;
    }
    const ic = this.acc.c;
    const id = this.acc.d;
    if (ic + id < 0.02) return; // too little energy to judge; keep accumulating against the same baseline
    const big = (x, y) => x > 3 * y;
    const within = (x, ref) => x >= 0.5 * ref && x <= 2 * ref;
    let vote = null;
    if (big(ic, id)) { // net charging: the bigger counter is the charge counter
      if (big(r, d) && within(r, ic)) vote = 'rcvd';
      else if (big(d, r) && within(d, ic)) vote = 'dlvd';
      else vote = 'bad';
    } else if (big(id, ic)) { // net discharging
      if (big(d, r) && within(d, id)) vote = 'rcvd';
      else if (big(r, d) && within(r, id)) vote = 'dlvd';
      else vote = 'bad';
    }
    this._seed(reading, now);
    if (vote === 'bad') {
      this.s.votes = null;
    } else if (vote) {
      const v = this.s.votes;
      this.s.votes = v && v.dir === vote ? { dir: vote, n: v.n + 1 } : { dir: vote, n: 1 };
      if (this.s.votes.n >= VOTES_REQUIRED) {
        this.s.dir = vote;
        this._setSource('storage-meter');
      }
    }
  }
}

/**
 * Per-gateway energy model: keeps the latest raw observations per source, tracks freshness, and builds the frozen
 * state snapshot. Fast sources: meters, batteryPower. Background: inventory, meter configuration.
 * Slow source: production (production.json with its inverter-derived fallback).
 */
class GatewayEnergyModel {
  /**
   * @param {Object} opts
   * @param {string} opts.serial - Gateway serial
   * @param {Function} [opts.log]
   * @param {{get: Function, set: Function}} [opts.storage] - Persistence for `battery_energy_<serial>`
   */
  constructor({ serial, log, storage }) {
    this.serial = serial;
    this.log = log || (() => { });
    this.storage = storage || null;
    this.storageKey = `battery_energy_${serial}`;

    let stored = null;
    try {
      stored = this.storage ? this.storage.get(this.storageKey) : null;
    } catch (err) {
      this.log('[Energy] Failed to read persisted battery energy:', err.message);
    }
    this.ledger = new BatteryEnergyLedger(stored, this.log);
    this.lastPersistAt = 0;
    this.persistFailures = 0;

    this.cfg = classifyMeters(null);
    this.cfgAt = null;
    this.cfgAbsent = false; // /ivp/meters answered 404: this gateway has no meter support
    this.meters = null;
    this.production = null;
    this.battery = null;
    this.inventory = null;
    this.invHas = null; // tri-state from the inventory: true | false | null
    this.fails = {
      meters: null, production: null, batteryPower: null, inventory: null,
    };
    this.fastMs = null;
    this.cadence = { meters: 0, production: 0 };
    this._prevObs = { meters: null, production: null };
  }

  /** @param {number|null} ms - Effective fast interval (null while no device requests the fast tier) */
  setFastIntervalMs(ms) {
    this.fastMs = ms || null;
  }

  /**
   * Feed the cached /ivp/meters configuration.
   * @param {Array<Object>|null} list
   * @param {boolean} absent - Definitive 404 on /ivp/meters
   * @param {number|null} fetchedAt
   */
  setMetersConfig(list, absent, fetchedAt) {
    if (absent) {
      this.cfg = classifyMeters([]);
      this.cfgAbsent = true;
    } else if (Array.isArray(list)) {
      this.cfg = classifyMeters(list);
      this.cfgAbsent = false;
    }
    if (this.cfg.known) this.cfgAt = fetchedAt || this.cfgAt;
    if (this.cfg.known && this.hasBattery() !== false && !(this.cfg.storage && this.cfg.storage.enabled)) this.ledger.observeMeter(null, Date.now());
  }

  /** @returns {boolean} true when meter readings can be mapped and at least one meter is enabled */
  shouldReadMeters() {
    return this.cfg.known && this.cfg.readable;
  }

  /** @returns {boolean} true when the meters configuration is not known yet */
  needsMetersConfig() {
    return !this.cfg.known;
  }

  /** @returns {boolean} battery power is read unless a definitive answer says there is no battery */
  shouldReadBattery() {
    return this.hasBattery() !== false;
  }

  /** @returns {boolean|null} battery presence: true (power or inventory proved), false (inventory proved absence), null */
  hasBattery() {
    if (this.battery && this.battery.units.length > 0) return true;
    return this.invHas;
  }

  _track(kind, observedAt) {
    const prev = this._prevObs[kind];
    if (prev !== null && observedAt > prev) {
      const delta = Math.min(observedAt - prev, 600000);
      this.cadence[kind] = this.cadence[kind] ? (0.7 * this.cadence[kind]) + (0.3 * delta) : delta;
    }
    if (prev === null || observedAt > prev) this._prevObs[kind] = observedAt;
  }

  /**
   * Record a /ivp/meters/readings response. A response older than the stored sample is ignored (late arrival).
   * @param {Array<Object>} json
   * @param {number} receivedAt - Request completion (ms)
   * @returns {boolean} accepted
   */
  recordMeters(json, receivedAt) {
    const roles = parseMeterReadings(json, this.cfg, receivedAt);
    const times = Object.values(roles).filter(Boolean).map((r) => r.observedAt);
    const observedAt = times.length > 0 ? Math.max(...times) : receivedAt;
    if (this.meters && observedAt < this.meters.observedAt) return false;
    this._track('meters', observedAt);
    this.meters = { observedAt, receivedAt, roles };
    this.fails.meters = null;
    const st = roles.storage;
    if (st && finite(st.rcvd) && finite(st.dlvd) && this.hasBattery() !== false) {
      this.ledger.observeMeter({ id: st.eid, rcvd: st.rcvd, dlvd: st.dlvd }, receivedAt);
    }
    return true;
  }

  /**
   * Record a /ivp/ensemble/power response.
   * @param {Object} json
   * @param {number} receivedAt - Request completion (ms; the endpoint carries no timestamp, so this is observedAt)
   * @param {number} mono - Monotonic ms at completion
   * @returns {{ accepted: boolean, units: number }}
   */
  recordBatteryPower(json, receivedAt, mono) {
    const parsed = parseBatteryPower(json);
    if (this.battery && receivedAt < this.battery.receivedAt) return { accepted: false, units: parsed.units.length };
    this.battery = {
      observedAt: receivedAt, receivedAt, units: parsed.units, totalW: parsed.totalW,
    };
    this.fails.batteryPower = null;
    if (parsed.units.length > 0) {
      this.ledger.start();
      if (parsed.totalW !== null) {
        const gap = 2 * (this.fastMs || 15000);
        this.ledger.integrate(parsed.totalW, mono, gap, receivedAt);
      } else {
        this.ledger.invalidate();
      }
    } else {
      this.ledger.invalidate();
    }
    return { accepted: true, units: parsed.units.length };
  }

  /** Record a successful /ivp/ensemble/inventory response (a response without ENCHARGE devices proves no battery). */
  recordInventory(json, receivedAt) {
    const parsed = parseInventory(json);
    if (this.inventory && receivedAt < this.inventory.receivedAt) return;
    this.inventory = {
      observedAt: receivedAt, receivedAt, parsed, absent: false,
    };
    this.invHas = parsed.hasBattery;
    this.fails.inventory = null;
    if (parsed.hasBattery) {
      this.ledger.start();
    } else {
      this.battery = null;
      this.ledger.invalidate();
    }
  }

  /** Record a definitive HTTP 404 from the inventory endpoint on a gateway that otherwise answers. */
  recordInventoryAbsent(receivedAt) {
    this.inventory = {
      observedAt: receivedAt,
      receivedAt,
      parsed: { hasBattery: false, units: [], gridStatus: 'unknown' },
      absent: true,
    };
    this.invHas = false;
    this.battery = null;
    this.fails.inventory = null;
    this.ledger.invalidate();
  }

  /**
   * Record the slow production tier. `detail` is EnvoyApi.lastProduction (see getProductionData).
   * @param {Object} detail
   * @param {number} receivedAt
   */
  recordProduction(detail, receivedAt) {
    if (!detail) return;
    const times = [detail.solar, detail.grid, detail.home].filter(Boolean).map((x) => x.observedAt).filter(finite);
    const observedAt = times.length > 0 ? Math.min(receivedAt, Math.max(...times)) : receivedAt;
    if (this.production && observedAt < this.production.observedAt) return;
    this._track('production', observedAt);
    this.production = { observedAt, receivedAt, detail };
    this.fails.production = null;
  }

  /** Record a failed attempt of a source (keeps the last good observation; staleness follows from its age). */
  recordFailure(source, err, now) {
    this.fails[source] = { at: now, message: err && err.message ? err.message : String(err) };
    if (source === 'batteryPower') this.ledger.invalidate();
  }

  /**
   * Persist the battery ledger when dirty: at most every 60 s, immediately on source changes or when forced
   * (orderly shutdown). Failures are logged and retried; restart continuity is never claimed after a failure.
   * @param {number} now
   * @param {boolean} [force]
   */
  persist(now, force = false) {
    const l = this.ledger;
    if (!this.storage || !l.dirty) return;
    if (!force && !l.urgent && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return;
    this.lastPersistAt = now;
    try {
      this.storage.set(this.storageKey, l.serialize());
      l.dirty = false;
      l.urgent = false;
    } catch (err) {
      this.persistFailures += 1;
      this.log(`[Energy] Failed to persist battery energy (failure #${this.persistFailures}):`, err.message);
    }
  }

  _thresholds() {
    const base = this.fastMs || (SLOW_INTERVAL_SECONDS * 1000);
    return {
      meters: clamp(3 * Math.max(this.cadence.meters, base), MIN_STALE_MS, MAX_STALE_MS),
      batteryPower: clamp(3 * base, MIN_STALE_MS, MAX_STALE_MS),
      production: clamp(3 * Math.max(this.cadence.production, SLOW_INTERVAL_SECONDS * 1000), PRODUCTION_MIN_STALE_MS, MAX_STALE_MS),
      inventory: this.invHas === false ? INVENTORY_ABSENT_STALE_MS : INVENTORY_STALE_MS,
    };
  }

  /**
   * Build the frozen state snapshot.
   * @param {number} now - Publication time (ms)
   * @param {{ fastIntervalSeconds: number|null }} ctx
   * @returns {Object} Snapshot
   */
  snapshot(now, ctx) {
    const thr = this._thresholds();
    const fastMs = ctx.fastIntervalSeconds ? ctx.fastIntervalSeconds * 1000 : null;
    const age = (observedAt, t) => {
      if (!finite(observedAt)) return 'unknown';
      return now - observedAt <= t ? 'fresh' : 'stale';
    };
    const cand = (value, observedAt, t, source) => ({
      value: finite(value) ? value : null, observedAt: finite(observedAt) ? observedAt : null, status: age(observedAt, t), source,
    });
    const none = {
      value: null, observedAt: null, status: 'unknown', source: null,
    };
    const pick = (cands) => {
      const good = cands.find((c) => c.status === 'fresh' && c.value !== null);
      if (good) return good;
      const c = cands[0];
      if (!c) return none;
      return {
        value: null, observedAt: c.observedAt, status: c.status === 'fresh' ? 'unknown' : c.status, source: c.source,
      };
    };

    const hb = this.hasBattery();
    const has = {
      productionMeter: this.cfg.has.productionMeter,
      gridMeter: this.cfg.has.gridMeter,
      homeMeter: this.cfg.has.homeMeter,
      battery: hb,
    };
    const roles = this.meters ? this.meters.roles : {};
    const detail = this.production ? this.production.detail : {};
    const metersCand = (role, pickValue, source = 'meters') => {
      const r = roles[role];
      return cand(r ? pickValue(r) : null, r ? r.observedAt : null, thr.meters, source);
    };
    const prodCand = (section, pickValue) => {
      const d = detail[section];
      return cand(d ? pickValue(d) : null, d ? d.observedAt : null, thr.production, 'production');
    };
    const nz = (v) => (finite(v) ? Math.max(0, v) : null);

    // Battery power (Homey sign). A known-absent battery is a valid 0.
    let batt;
    if (hb === false) {
      batt = {
        value: 0, observedAt: this.inventory ? this.inventory.observedAt : null, status: 'absent', source: 'inventory',
      };
    } else {
      const b = this.battery;
      batt = pick(b && b.units.length > 0 ? [cand(b.totalW, b.observedAt, thr.batteryPower, 'batteryPower')] : []);
      if (!b || b.units.length === 0) {
        batt = {
          value: null, observedAt: b ? b.observedAt : null, status: 'unknown', source: 'batteryPower',
        };
      }
    }

    // Compatible observation times: derive only from fresh inputs sampled within a short window.
    const skew = clamp(2 * Math.max(fastMs || 0, this.cadence.meters), 30000, 120000);
    const derive = (inputs, fn) => {
      if (inputs.some((i) => !i || i.value === null || i.status !== 'fresh')) return null;
      const obs = inputs.map((i) => i.observedAt).filter(finite);
      if (obs.length > 0 && Math.max(...obs) - Math.min(...obs) > skew) return null;
      return { value: fn(inputs.map((i) => i.value)), observedAt: obs.length > 0 ? Math.min(...obs) : null };
    };
    const battInput = hb === false ? { value: 0, status: 'fresh', observedAt: null } : (hb === true ? batt : null);

    // Solar: production CT when enabled, else the slow tier (inverter totals on CT-free systems). Never zero by default.
    const solar = pick(has.productionMeter === true
      ? [metersCand('production', (r) => nz(r.w))]
      : [prodCand('solar', (d) => nz(d.w))]);
    const solarKWh = pick(has.productionMeter === true
      ? [metersCand('production', (r) => r.dlvd)]
      : [prodCand('solar', (d) => d.kWh)]);

    // Grid: net CT; with only a total CT it follows from home - solar + battery; slow tier as the last resort.
    const gridCands = [];
    if (has.gridMeter === true) {
      gridCands.push(metersCand('net', (r) => (finite(r.w) ? GRID_SIGN * r.w : null)));
    } else {
      if (has.homeMeter === true) {
        const homeIn = metersCand('total', (r) => nz(r.w));
        const d = derive([homeIn, solar, battInput], ([h, s, bt]) => h - s + bt);
        if (d) {
          gridCands.push({
            value: d.value, observedAt: d.observedAt, status: 'fresh', source: 'derived',
          });
        }
      }
      gridCands.push(prodCand('grid', (g) => g.w));
    }
    const grid = pick(gridCands);
    const gridImport = pick(has.gridMeter === true ? [metersCand('net', (r) => r.dlvd)] : [prodCand('grid', (g) => g.importKWh)]);
    const gridExport = pick(has.gridMeter === true ? [metersCand('net', (r) => r.rcvd)] : [prodCand('grid', (g) => g.exportKWh)]);

    // Home: total CT when configured (measured); otherwise derived from solar + grid - battery.
    const homeCands = [];
    if (has.homeMeter === true) {
      homeCands.push(metersCand('total', (r) => nz(r.w)));
    } else {
      const d = derive([solar, grid, battInput], ([s, g, bt]) => Math.max(0, s + g - bt));
      if (d) {
        homeCands.push({
          value: d.value, observedAt: d.observedAt, status: 'fresh', source: 'derived',
        });
      }
      homeCands.push(prodCand('home', (h) => nz(h.w)));
    }
    const home = pick(homeCands);
    const homeKWh = pick(has.homeMeter === true ? [metersCand('total', (r) => r.dlvd)] : [prodCand('home', (h) => h.importKWh)]);

    // SoC: per-unit values from ONE source (power preferred, inventory fallback), never mixed within an aggregate.
    let soc = {
      value: null, observedAt: null, status: hb === false ? 'absent' : 'unknown', source: null,
    };
    if (hb !== false) {
      const invUnits = this.inventory ? this.inventory.parsed.units : [];
      const b = this.battery;
      const powerStatus = b ? age(b.observedAt, thr.batteryPower) : 'unknown';
      const invStatus = this.inventory ? age(this.inventory.observedAt, thr.inventory) : 'unknown';
      if (b && b.units.length > 0 && powerStatus === 'fresh' && b.units.every((u) => u.soc !== null)) {
        soc = {
          value: aggregateSoc(b.units.map((u) => ({ serial: u.serial, soc: u.soc })), invUnits),
          observedAt: b.observedAt,
          status: 'fresh',
          source: 'batteryPower',
        };
      }
      if (soc.value === null && invUnits.length > 0 && invStatus === 'fresh' && invUnits.every((u) => u.percentFull !== null)) {
        soc = {
          value: aggregateSoc(invUnits.map((u) => ({ serial: u.serial, soc: u.percentFull })), invUnits),
          observedAt: this.inventory.observedAt,
          status: 'fresh',
          source: 'inventory',
        };
      }
      if (soc.value === null) {
        soc = {
          value: null, observedAt: b ? b.observedAt : null, status: b ? (powerStatus === 'fresh' ? 'unknown' : powerStatus) : 'unknown', source: 'batteryPower',
        };
      }
    }

    // Grid-tie status from the inventory (fresh only; otherwise 'unknown').
    const invStatus = this.inventory ? age(this.inventory.observedAt, thr.inventory) : 'unknown';
    const gridStatus = {
      value: this.inventory && invStatus === 'fresh' ? this.inventory.parsed.gridStatus : 'unknown',
      observedAt: this.inventory ? this.inventory.observedAt : null,
      status: invStatus,
      source: 'inventory',
    };

    // Battery counters: persisted monotonic totals. They are state, not an observation, so a stale one keeps its
    // number and says so in the metadata.
    const totals = hb === true || this.ledger.started ? this.ledger.totals() : null;
    const ledgerSource = this.ledger.source;
    const counterMeta = {
      observedAt: this.ledger.s.updatedAt,
      status: totals ? age(this.ledger.s.updatedAt, ledgerSource === 'storage-meter' ? thr.meters : thr.batteryPower) : 'unknown',
      source: totals && this.ledger.sessionUpdated ? (ledgerSource === 'storage-meter' ? 'meters' : 'batteryPower') : 'persisted',
    };
    if (totals && counterMeta.status === 'unknown') counterMeta.status = 'stale';
    const counter = (v) => ({ value: totals ? round(v, 4) : null, ...counterMeta });

    const srcOut = (rec, status) => ({
      observedAt: rec ? rec.observedAt : null,
      receivedAt: rec ? rec.receivedAt : null,
      status,
    });
    const sources = {
      meters: srcOut(this.meters, this.cfg.known && !this.cfg.readable ? 'absent' : (this.meters ? age(this.meters.observedAt, thr.meters) : 'unknown')),
      production: srcOut(this.production, this.production ? age(this.production.observedAt, thr.production) : 'unknown'),
      batteryPower: srcOut(this.battery, hb === false ? 'absent' : (this.battery ? age(this.battery.observedAt, thr.batteryPower) : 'unknown')),
      inventory: srcOut(this.inventory, invStatus),
    };

    const pw = (f) => ({ ...f, value: round(f.value, 1) });
    const kwh = (f) => ({ ...f, value: round(f.value, 3) });
    const f = {
      solarW: pw(solar),
      gridW: pw(grid),
      homeW: pw(home),
      batteryW: pw(batt),
      soc,
      gridStatus,
      solarKWh: kwh(solarKWh),
      gridImportKWh: kwh(gridImport),
      gridExportKWh: kwh(gridExport),
      homeKWh: kwh(homeKWh),
      battChargedKWh: counter(totals ? totals.charged : null),
      battDischargedKWh: counter(totals ? totals.discharged : null),
    };
    const fields = {};
    const values = {};
    Object.keys(f).forEach((k) => {
      values[k] = f[k].value;
      fields[k] = { observedAt: f[k].observedAt, status: f[k].status, source: f[k].source };
    });

    return deepFreeze({
      serial: this.serial,
      ts: now,
      fastIntervalSeconds: ctx.fastIntervalSeconds || null,
      slowIntervalSeconds: SLOW_INTERVAL_SECONDS,
      ...values,
      batteryEnergySource: totals ? ledgerSource : null,
      batteryEnergyEstimated: totals ? ledgerSource === 'integrated' : false,
      has,
      sources,
      fields,
    });
  }
}

module.exports = {
  SLOW_INTERVAL_SECONDS,
  GRID_SIGN,
  BATTERY_SIGN,
  monoMs,
  classifyMeters,
  parseMeterReadings,
  parseBatteryPower,
  parseInventory,
  deriveGridStatus,
  aggregateSoc,
  BatteryEnergyLedger,
  GatewayEnergyModel,
};
