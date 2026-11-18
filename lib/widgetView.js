'use strict';

/*
 * Widget view: what the energy widgets draw, derived from the merged widget snapshot (lib/widgetFeed.js) at one moment.
 * Widgets are renderers only; every rule about which readings count, which nodes exist and how power is allocated over
 * source -> destination flows lives here, so all widgets agree and the rules are unit-tested.
 *
 * Shape (also the payload of the `enphase:flow` realtime event and GET /state/:serial):
 *   {
 *     serial, ts,          // ts: when this view was computed (epoch ms, app clock)
 *     validUntil,          // epoch ms at which the first 'ok' reading turns stale, or null (nothing will change on its own).
 *                          // A widget re-fetches the view then; past it (plus a grace period) it treats everything as stale.
 *     readings: { solarW, gridW, homeW, batteryW, soc, gridStatus }   // each { status, value }
 *     present: { solar, battery },   // optional nodes that are known to exist (grid and home always do)
 *     gridDisconnected,
 *     flows: [{ from, to, watts }],  // allocation of the 'ok' readings; NO deadzone applied
 *     tariff: { import?, export? } | null,
 *   }
 *
 * Reading status: 'ok' (usable), 'stale' (has a value that is too old), 'unknown' (no value), 'absent' (known not to
 * exist). Staleness is judged at `now` from the field's age: `persisted` never ages, `flow` values use the Flow windows of
 * lib/widgetFeed.js, `derived` values are as fresh as their slowest input, everything else is stale after
 * STALE_INTERVALS expected update intervals plus STALE_SLACK_MS.
 *
 * Deadzone: flows carry every allocated watt. A widget's deadzone is a display setting, applied by dropping flows at or
 * below it. That is exactly equivalent to zeroing a grid reading inside the deadzone before allocating: the greedy order
 * below only ever hands grid power to/from grid, so zeroing it removes nothing but grid flows, which are all smaller
 * than the deadzone anyway.
 *
 * Everything drawn is an allocation of aggregate readings, not a measurement of individual paths.
 */

const { FLOW_STALE_MS, SOC_STALE_MS } = require('./widgetFeed');

const STALE_INTERVALS = 3;
const STALE_SLACK_MS = 5000;
const DEFAULT_SLOW_INTERVAL_S = 120;
const POWER_FIELDS = ['solarW', 'gridW', 'homeW', 'batteryW'];
const READING_FIELDS = [...POWER_FIELDS, 'soc', 'gridStatus'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

function intervalSeconds(source, snap) {
  const slow = finite(snap.slowIntervalSeconds) && snap.slowIntervalSeconds > 0 ? snap.slowIntervalSeconds : DEFAULT_SLOW_INTERVAL_S;
  const fast = finite(snap.fastIntervalSeconds) && snap.fastIntervalSeconds > 0 ? snap.fastIntervalSeconds : null;
  if (source === 'meters' || source === 'batteryPower') return fast || slow;
  return slow; // production / inventory run on the slow cadence
}

/** Age (ms) at which a field stops counting as fresh. */
function staleAfterMs(name, snap, depth = 0) {
  const fields = snap.fields || {};
  const meta = fields[name];
  const source = meta && meta.source;
  if (source === 'persisted') return Infinity;
  if (source === 'flow') return name === 'soc' ? SOC_STALE_MS : FLOW_STALE_MS;
  if (source === 'derived' && depth < 1) {
    const inputs = POWER_FIELDS
      .filter((n) => fields[n] && fields[n].source !== 'derived')
      .map((n) => staleAfterMs(n, snap, depth + 1));
    if (inputs.length) return Math.max(...inputs);
  }
  return STALE_INTERVALS * intervalSeconds(source, snap) * 1000 + STALE_SLACK_MS;
}

/** Status of one field at `now`, plus the time it turns stale while it is 'ok'. */
function readField(snap, name, now) {
  const meta = snap.fields && snap.fields[name];
  const raw = snap[name];
  if (!meta || meta.status === 'unknown') return { status: 'unknown', value: null };
  if (meta.status === 'absent') return { status: 'absent', value: null };
  const valid = name === 'gridStatus' ? typeof raw === 'string' : finite(raw);
  const value = valid ? raw : null;
  if (value === null) return { status: 'unknown', value: null };
  if (meta.status === 'stale') return { status: 'stale', value };
  const ts = finite(snap.ts) ? snap.ts : now;
  const observed = finite(meta.observedAt) ? meta.observedAt : null;
  const age = (observed !== null ? Math.max(0, ts - observed) : 0) + Math.max(0, now - ts);
  const limit = staleAfterMs(name, snap);
  if (age > limit) return { status: 'stale', value };
  return { status: 'ok', value, until: Number.isFinite(limit) ? now + (limit - age) : null };
}

/**
 * Greedy allocation of the readings over source -> destination flows, in priority order: solar feeds home, then
 * battery, then grid; battery feeds home, then grid; grid feeds home, then battery. Each node's flows stay within its
 * own reading, so displayed power is conserved.
 * @param {{ solarW: number, gridW: number, batteryW: number, homeW: number }} w - gridW + import, batteryW + charging
 * @returns {Array<{ from: string, to: string, watts: number }>}
 */
function allocateFlows({
  solarW, gridW, batteryW, homeW,
}) {
  const flows = [];
  const push = (from, to, watts) => {
    if (watts > 0) flows.push({ from, to, watts: round1(watts) });
  };
  let solarSrc = Math.max(solarW, 0);
  let gridImport = Math.max(gridW, 0);
  let battDischarge = Math.max(-batteryW, 0);
  let homeSink = Math.max(homeW, 0);
  let gridExport = Math.max(-gridW, 0);
  let battCharge = Math.max(batteryW, 0);
  let t;
  t = Math.min(solarSrc, homeSink); push('solar', 'home', t); solarSrc -= t; homeSink -= t;
  t = Math.min(solarSrc, battCharge); push('solar', 'battery', t); solarSrc -= t; battCharge -= t;
  t = Math.min(solarSrc, gridExport); push('solar', 'grid', t); solarSrc -= t; gridExport -= t;
  t = Math.min(battDischarge, homeSink); push('battery', 'home', t); battDischarge -= t; homeSink -= t;
  t = Math.min(battDischarge, gridExport); push('battery', 'grid', t); battDischarge -= t; gridExport -= t;
  t = Math.min(gridImport, homeSink); push('grid', 'home', t); gridImport -= t; homeSink -= t;
  t = Math.min(gridImport, battCharge); push('grid', 'battery', t);
  return flows;
}

/**
 * Build the widget view of a (merged) snapshot.
 * @param {Object|null} snap - Snapshot from WidgetFeed.merge()
 * @param {number} now - Epoch ms
 * @returns {Object|null} View (see top of file), or null without a snapshot
 */
function buildWidgetView(snap, now) {
  if (!snap || typeof snap !== 'object' || typeof snap.serial !== 'string') return null;
  const fields = snap.fields || {};
  const has = snap.has || {};

  const readings = {};
  let validUntil = null;
  READING_FIELDS.forEach((name) => {
    const { until, ...reading } = readField(snap, name, now);
    readings[name] = reading;
    if (finite(until) && (validUntil === null || until < validUntil)) validUntil = until;
  });
  const ok = (name) => readings[name].status === 'ok';
  const gridDisconnected = ok('gridStatus') && readings.gridStatus.value === 'disconnected';

  // Solar exists once it has a reading, or had one that is now outdated (the gateway nulls outdated values).
  // Battery exists once the snapshot says so (gateway inventory or a Flow value).
  const present = {
    solar: ok('solarW') || readings.solarW.status === 'stale' || (!!fields.solarW && fields.solarW.status === 'stale'),
    battery: has.battery === true,
  };

  // Only usable readings take part; a node with unknown/outdated data gets no flows.
  const flows = allocateFlows({
    solarW: ok('solarW') ? readings.solarW.value : 0,
    gridW: ok('gridW') && !gridDisconnected ? readings.gridW.value : 0,
    batteryW: ok('batteryW') && present.battery ? readings.batteryW.value : 0,
    homeW: ok('homeW') ? readings.homeW.value : 0,
  });

  const tariff = snap.tariff && typeof snap.tariff === 'object' ? { ...snap.tariff } : null;
  return {
    serial: snap.serial,
    ts: now,
    validUntil,
    readings,
    present,
    gridDisconnected,
    flows,
    tariff,
  };
}

module.exports = {
  buildWidgetView, allocateFlows, staleAfterMs, STALE_INTERVALS, STALE_SLACK_MS,
};
