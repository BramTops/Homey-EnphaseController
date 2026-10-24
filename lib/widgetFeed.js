'use strict';

/*
 * Widget-only overlay on the gateway state snapshot. Flow action cards push power values (W, from any Homey device
 * the user wires up) into this cache; merge() lays them over a snapshot for the Energy flow widget.
 *
 * The overlay NEVER reaches devices, the energy model or capabilities: callers hand the merged snapshot to the
 * widget only. The raw snapshot stays as the model built it.
 *
 * Conventions (same as the snapshot, which follow Homey / HomeWizard):
 *  - gridW: + import, - export (HomeWizard P1 `measure_power`).
 *  - batteryW: + charging, - discharging.
 *  - solarW and homeW are clamped >= 0, like the model does. Flipped signs are for the user to invert in their Flow.
 *
 * Merge rules, per field:
 *  - An overlay value only ever replaces a field; a missing/invalid value never clears anything (set() rejects it).
 *  - Gateway and Flow values compete on observation time, newest wins (a gateway value that is null, absent or
 *    stale-and-nulled does not compete). So wiring a Flow to a field the gateway also fills just makes them overwrite
 *    each other.
 *  - Flow values are 'fresh' for FLOW_STALE_MS, then 'stale'. Flows fire on change, so an unchanging value (0 W solar at
 *    night) must stay readable for a while; widgets/energy-flow/public/index.js uses the same window.
 *  - The widget always draws grid and home (whether or not Enphase devices or CT clamps back them); solar and battery
 *    are optional. When Flow data was used and one of grid/home has no value, it is derived from the other:
 *    home = solar + grid - battery, grid = home - solar + battery. Here, and only here, an optional input that has no
 *    value (null or known-absent, as opposed to merely outdated) counts as 0. Nothing is ever written into an optional
 *    field for it: a missing solar/battery stays null, so the widget does not draw it (it draws one only once it is
 *    known to exist or a Flow supplied a value).
 *
 * Tariffs (price per kWh, import and export) are not power fields: they are cached separately for 25 hours and
 * ride along on the merged snapshot as
 * `tariff: { import, export }` (each null until set). Display only; nothing computes with them.
 */

const FIELDS = ['solarW', 'gridW', 'homeW', 'batteryW', 'soc'];
const NON_NEGATIVE = new Set(['solarW', 'homeW']);
const FLOW_STALE_MS = 10 * 60 * 1000;
const SOC_STALE_MS = 25 * 60 * 60 * 1000;
const TARIFF_TTL_MS = 25 * 60 * 60 * 1000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

class WidgetFeed {

  constructor() {
    this._overlays = new Map(); // serial -> { [field]: { value, at } }
    this._tariffs = new Map(); // serial -> { import, export } (each { value, at })
  }

  /**
   * Cache a Flow-provided value.
   * @param {string} serial
   * @param {'solarW'|'gridW'|'homeW'|'batteryW'|'soc'} field
   * @param {*} value - Watts or SoC percentage; anything outside its valid range is ignored
   * @param {number} now - Epoch ms
   * @returns {boolean} Whether the value was stored
   */
  set(serial, field, value, now) {
    if (typeof serial !== 'string' || !serial || !FIELDS.includes(field) || !finite(value)) return false;
    if (field === 'soc' && (value < 0 || value > 100)) return false;
    let overlay = this._overlays.get(serial);
    if (!overlay) {
      overlay = {};
      this._overlays.set(serial, overlay);
    }
    overlay[field] = { value: round1(NON_NEGATIVE.has(field) ? Math.max(0, value) : value), at: now };
    return true;
  }

  /**
   * Cache the Flow-provided tariffs (price per kWh). Either may be negative (dynamic contracts); an invalid one is
   * ignored and never clears a cached price.
   * @param {string} serial
   * @param {*} importPrice
   * @param {*} exportPrice
   * @returns {boolean} Whether at least one price was stored
   */
  setTariff(serial, importPrice, exportPrice, now = Date.now()) {
    if (typeof serial !== 'string' || !serial) return false;
    const incoming = { import: importPrice, export: exportPrice };
    const stored = { import: null, export: null, ...this._tariffs.get(serial) };
    let changed = false;
    Object.keys(incoming).forEach((key) => {
      if (!finite(incoming[key])) return;
      stored[key] = { value: incoming[key], at: now };
      changed = true;
    });
    if (changed) this._tariffs.set(serial, stored);
    return changed;
  }

  /** Forget everything cached for a gateway. */
  clear(serial) {
    this._overlays.delete(serial);
    this._tariffs.delete(serial);
  }

  /**
   * Overlay cached values on a snapshot.
   * @param {string} serial
   * @param {Object|null} base - Snapshot from GatewayEnergyModel (not modified)
   * @param {number} now - Epoch ms
   * @returns {Object|null} A new snapshot, or `base` itself when there is nothing to overlay
   */
  merge(serial, base, now) {
    const overlay = this._overlays.get(serial) || {};
    const tariff = this._tariffs.get(serial);
    if (!base || (!tariff && !this._overlays.has(serial))) return base;

    const values = {};
    const fields = { ...base.fields };
    const has = { ...base.has };
    let used = false;

    FIELDS.forEach((name) => {
      const ov = overlay[name];
      if (!ov) return;
      const meta = base.fields ? base.fields[name] : null;
      const gatewayUsable = finite(base[name]) && !!meta && meta.status !== 'absent';
      const gatewayAt = meta && finite(meta.observedAt) ? meta.observedAt : base.ts;
      if (gatewayUsable && gatewayAt > ov.at) return;
      values[name] = ov.value;
      const staleMs = name === 'soc' ? SOC_STALE_MS : FLOW_STALE_MS;
      fields[name] = { observedAt: ov.at, status: now - ov.at <= staleMs ? 'fresh' : 'stale', source: 'flow' };
      used = true;
      if (name === 'batteryW') has.battery = true;
      if (name === 'soc') has.battery = true;
    });
    if (!used && !tariff) return base;

    const merged = used ? {
      ...base, ...values, ts: now, has, fields,
    } : { ...base };
    if (used) this._derive(merged);
    if (tariff) {
      const prices = {};
      ['import', 'export'].forEach((key) => {
        const price = tariff[key];
        if (price && now - price.at <= TARIFF_TTL_MS) prices[key] = price.value;
      });
      if (Object.keys(prices).length) merged.tariff = prices;
    }
    return Object.freeze(merged);
  }

  /**
   * Fill a missing grid or home from the other one, written into `merged` (which is still being built).
   * Needs the known node fresh and both optional inputs either fresh or genuinely not there.
   * @private
   */
  _derive(merged) {
    const { fields } = merged;
    const fresh = (name) => finite(merged[name]) && !!fields[name] && fields[name].status === 'fresh';
    const usable = (name) => finite(merged[name]) && !!fields[name] && fields[name].status !== 'stale';
    // Optional input: its value, a plain 0 when it is not there, or null when it is there but outdated (no honest sum).
    const optional = (name) => {
      const f = fields[name];
      if (f && f.status === 'absent') return { value: 0, at: null };
      if (fresh(name)) return { value: merged[name], at: f.observedAt };
      if (!finite(merged[name]) && !(f && f.status === 'stale')) return { value: 0, at: null };
      return null;
    };
    const solar = optional('solarW');
    const battery = optional('batteryW');
    if (!solar || !battery) return;

    let target;
    let known;
    if (!usable('homeW') && fresh('gridW')) {
      target = 'homeW';
      known = 'gridW';
    } else if (!usable('gridW') && fresh('homeW')) {
      target = 'gridW';
      known = 'homeW';
    } else {
      return;
    }
    const value = target === 'homeW'
      ? Math.max(0, solar.value + merged[known] - battery.value)
      : merged[known] - solar.value + battery.value;
    const observed = [fields[known].observedAt, solar.at, battery.at].filter(finite);
    merged[target] = round1(value);
    fields[target] = {
      observedAt: observed.length > 0 ? Math.min(...observed) : null, status: 'fresh', source: 'derived',
    };
  }

}

module.exports = { WidgetFeed, FIELDS, FLOW_STALE_MS, SOC_STALE_MS, TARIFF_TTL_MS };
