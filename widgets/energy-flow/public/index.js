/*
 * Portions adapted from nklerk/nl.nielsdeklerk.enphase @728201bfc1a28752d01656c43fb8ba69cd8fe508
 * (flow allocation, route geometry, particle and node drawing).
 *
 * MIT License
 *
 * Copyright (c) 2026 Niels de Klerk
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/* eslint-env browser */
/* eslint-disable no-use-before-define, no-nested-ternary, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unused-vars, strict */

// Data model: the widget only reads app state snapshots,
// via the widget API (GET /gateways, GET /state/:serial) plus the realtime
// events 'enphase:flow' and 'enphase:gateways'. It never talks to a gateway.
// Snapshot fields may come from the gateway or from user Flow cards (source 'flow'; see lib/widgetFeed.js).
// Everything drawn is an allocation of the aggregate readings, not a measurement
// of individual source-to-load paths.
// eslint-disable-next-line no-unused-vars
function onHomeyReady(Homey) {
  const FLOW_EVENT = 'enphase:flow';
  const GATEWAYS_EVENT = 'enphase:gateways';
  const KEY_PREFIX = 'widget.energy_flow.';

  // --- Tunables -------------------------------------------------------------
  // The flow deadzone (below it a flow carries no particles; grid and battery read "Idle") and the full-scale
  // power (maps to a full-width, full-speed band) are widget settings: config.deadzoneW / config.maxW.
  // Exponent < 1 compresses the scale so changes at the low end move the visuals more than the same change at the high end.
  const SCALE_EXP = 0.7;
  const MAX_PARTICLES_PER_EDGE = 40;
  const MAX_PARTICLES_TOTAL = 120;
  const MIN_FRAME_MS = 33; // ~30 fps is plenty for a dashboard widget
  const TICK_MS = 5000; // staleness / theme re-evaluation while visible
  const STALE_INTERVALS = 3; // stale after at most three expected update intervals
  const STALE_SLACK_MS = 5000;
  // Values pushed by user Flows arrive only on change; same window as FLOW_STALE_MS in lib/widgetFeed.js.
  const FLOW_STALE_MS = 10 * 60 * 1000;
  const SOC_STALE_MS = 90 * 60 * 1000;
  const READY_TIMEOUT_MS = 8000;
  // Visuals ease toward each new reading (exponential smoothing) instead of jumping; ~95% settled after 3 * tau.
  const TWEEN_TAU_S = 0.7;

  // English fallbacks, used only if the locale lookup does not resolve a key.
  const FALLBACK = {
    number_locale: 'en-GB',
    'node.solar': 'Solar',
    'node.grid': 'Grid',
    'node.home': 'Home',
    'node.battery': 'Battery',
    'state.importing': 'Importing',
    'state.exporting': 'Exporting',
    'state.idle': 'Idle',
    'state.disconnected': 'Disconnected',
    'state.consuming': 'Consuming',
    'state.charging': 'Charging',
    'state.discharging': 'Discharging',
    'state.no_data': 'No data',
    'state.outdated': 'Outdated',
    'message.loading': 'Loading...',
    'message.retry': 'Try again',
    'message.no_gateways.title': 'No gateway found',
    'message.no_gateways.body': 'Add an Enphase Solar, Grid or Battery device to show the energy flow.',
    'message.upgrade.title': 'Device update needed',
    'message.upgrade.body': 'This gateway only has legacy devices. Add an Enphase Solar, Grid or Battery device to show the energy flow.',
    'message.missing.title': 'Gateway not found',
    'message.missing.body': 'The selected gateway is no longer available. Choose another gateway.',
    'message.choose.title': 'Choose a gateway',
    'message.choose.body': 'Select the gateway this widget should show.',
    'message.waiting.title': 'Waiting for data',
    'message.waiting.body': 'The first readings have not arrived yet.',
    'message.error.title': 'Could not load data',
    'message.error.body': 'The energy flow data is not available right now. Retrying automatically.',
    'chooser.placeholder': 'Choose a gateway...',
    'chooser.label': 'Gateway',
    'aria.summary': 'Energy flow',
  };

  function tr(key) {
    let v = null;
    try {
      v = Homey.__(KEY_PREFIX + key);
    } catch (e) {
      v = null;
    }
    if (typeof v === 'string' && v && v !== KEY_PREFIX + key) return v;
    return FALLBACK[key] || key;
  }

  // User-tunable visuals (widget settings; see widget.compose.json).
  const config = {
    trackOpacity: 0.20,
    speedMul: 1.0,
    trailLength: 10, // in 60 fps frames; converted to time so it is frame-rate independent
    particleOpacity: 0.90,
    maxW: 5000, // power that maps to a full-width, full-speed band
    deadzoneW: 25, // flows at or below this draw nothing
  };
  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }
  function readConfig() {
    try {
      const s = (Homey.getSettings && Homey.getSettings()) || {};
      config.trackOpacity = clampNum(s.trackOpacity, 0, 100, 20) / 100;
      config.speedMul = clampNum(s.particleSpeed, 10, 400, 100) / 100;
      config.trailLength = Math.round(clampNum(s.trailLength, 2, 40, 10));
      config.particleOpacity = clampNum(s.particleOpacity, 0, 100, 90) / 100;
      config.maxW = clampNum(s.maxPower, 500, 20000, 5000);
      config.deadzoneW = Math.min(clampNum(s.deadzone, 0, 500, 25), config.maxW - 1);
    } catch (e) { /* keep current values */ }
  }

  // --- Layout ---------------------------------------------------------------
  // Fixed orientation: solar on top, grid left, battery right, home at the bottom. Every node keeps its slot
  // whether or not the others are visible, so nothing jumps when solar or battery data appears. Grid and home are
  // always visible; solar and battery only appear once they have data. Coordinates are normalised [0..1]
  // waypoints (source -> destination); interior corners are rounded at layout time.
  // Row heights are tuned so the white texts line up in two rows at the default 300 px height (icon radius 30):
  // solar's value, the grid tariff and the battery % share one baseline, and the grid, battery and home values share
  // another. See drawNodeText for the offsets (value below an icon, tariff/% above it, home's value above its icon).
  const Y_SOLAR = 0.15;
  const Y_SIDES = 0.477; // grid and battery
  const Y_HOME = 0.847;
  const SLOTS = {
    solar: [0.5, Y_SOLAR], grid: [0.15, Y_SIDES], battery: [0.85, Y_SIDES], home: [0.5, Y_HOME],
  };
  const ROUTES = {
    'solar-home': [[0.5, Y_SOLAR], [0.5, Y_HOME]],
    'solar-battery': [[0.5, Y_SOLAR], [0.85, Y_SOLAR], [0.85, Y_SIDES]],
    'solar-grid': [[0.5, Y_SOLAR], [0.15, Y_SOLAR], [0.15, Y_SIDES]],
    'grid-battery': [[0.15, Y_SIDES], [0.85, Y_SIDES]],
    'grid-home': [[0.15, Y_SIDES], [0.15, Y_HOME], [0.5, Y_HOME]],
    'battery-home': [[0.85, Y_SIDES], [0.85, Y_HOME], [0.5, Y_HOME]],
  };
  const NODE_ORDER = ['solar', 'grid', 'home', 'battery'];

  // --- DOM ------------------------------------------------------------------
  const app = document.getElementById('app');
  const canvas = document.getElementById('flow-canvas');
  const ctx = canvas.getContext('2d');
  const probeSub = document.getElementById('probe-sub');
  const chooserEl = document.getElementById('chooser');
  const selectEl = document.getElementById('gateway-select');
  const messageEl = document.getElementById('message');
  const messageTitle = document.getElementById('message-title');
  const messageBody = document.getElementById('message-body');
  const retryBtn = document.getElementById('message-retry');
  const swatch = document.createElement('canvas');
  swatch.width = 1;
  swatch.height = 1;
  const swatchCtx = swatch.getContext('2d', { willReadFrequently: true });

  // --- State ----------------------------------------------------------------
  let W = 0;
  let H = 0;
  let R = 26; // icon radius (px)
  let cornerR = 26;
  let colors = null;
  let fontFamily = 'sans-serif';
  let dark = false;
  let layoutKey = '';
  let layout = null;
  const edgeGeom = {}; // route key -> { flat, cum, total }
  // "from>to" -> { geomKey, reversed, color, particles, alpha, tgt, halfWidth, speed, lineWidth }
  // halfWidth/speed/lineWidth/alpha are the eased values being drawn; `tgt` holds where they are heading.
  // Particles carry their own fade `a` (and `dying` while fading out) so counts change without popping.
  const edgeState = {};
  const shown = { power: {}, soc: { cur: null, tgt: null } }; // eased node readings: id -> { cur, tgt }
  let settling = false; // true while any eased value has not reached its target

  let gateways = null; // null until the first successful /gateways answer
  let gatewaysFailed = false;
  let selected = null;
  const latest = {}; // serial -> { snap, perf, lag } (newest snapshot per serial)
  let stateProblem = null; // 'unavailable' when the last /state call failed
  let model = null;
  let viewMode = 'loading';

  let numberFormats = null;
  let reducedMotion = false;
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    mq.addEventListener('change', (e) => {
      reducedMotion = e.matches; scheduleFrame();
    });
  } catch (e) { /* older webview */ }

  // --- Storage (selected serial only; never credentials) --------------------
  let memorySerial = null;
  function storageKey() {
    let id = 'default';
    try {
      id = Homey.getWidgetInstanceId() || id;
    } catch (e) { /* default */ }
    return `enphase-energy-flow:${id}`;
  }
  function loadSerial() {
    try {
      const v = window.localStorage.getItem(storageKey());
      if (v && /^\d{12}$/.test(v)) return v;
    } catch (e) { /* storage unavailable */ }
    return memorySerial;
  }
  function saveSerial(serial) {
    memorySerial = serial;
    try {
      window.localStorage.setItem(storageKey(), serial);
    } catch (e) { /* keep in memory */ }
  }

  // --- Formatting -----------------------------------------------------------
  function makeFormats() {
    let locale = tr('number_locale');
    try {
      Intl.NumberFormat.supportedLocalesOf(locale);
    } catch (e) {
      locale = navigator.language || 'en-GB';
    }
    const nf = (opts) => new Intl.NumberFormat(locale, opts);
    numberFormats = {
      w: nf({ maximumFractionDigits: 0 }),
      kw2: nf({ maximumFractionDigits: 2 }),
      kw1: nf({ maximumFractionDigits: 1 }),
      kw0: nf({ maximumFractionDigits: 0 }),
      pct: nf({ style: 'percent', maximumFractionDigits: 0 }),
      price: nf({ minimumFractionDigits: 2, maximumFractionDigits: 3 }),
    };
  }
  // Split into the number and its unit so the drawn text can de-emphasise the unit: { value: '1,2', unit: 'kW' }.
  function formatPower(w) {
    const abs = Math.abs(w);
    if (abs >= 1000) {
      const kw = abs / 1000;
      const f = kw < 10 ? numberFormats.kw2 : (kw < 100 ? numberFormats.kw1 : numberFormats.kw0);
      return { value: f.format(kw), unit: 'kW' };
    }
    return { value: numberFormats.w.format(Math.round(abs)), unit: 'W' };
  }
  // Split at the decimal separator so the drawn text can emphasise the decimals: { head: '€ 0,', decimals: '24' }.
  function formatPrice(price) {
    const parts = numberFormats.price.formatToParts(price);
    const at = parts.findIndex((p) => p.type === 'fraction');
    const join = (list) => list.map((p) => p.value).join('');
    if (at < 0) return { head: `€ ${join(parts)}`, decimals: '' };
    return { head: `€ ${join(parts.slice(0, at))}`, decimals: join(parts.slice(at)) };
  }
  // Split into the number and the percent sign (with any locale spacing): { value: '80', unit: '%' }.
  function formatSoc(soc) {
    const parts = numberFormats.pct.formatToParts(Math.max(0, Math.min(100, soc)) / 100);
    const at = parts.findIndex((p) => p.type === 'percentSign');
    const join = (list) => list.map((p) => p.value).join('');
    if (at < 0) return { value: join(parts), unit: '' };
    return { value: join(parts.slice(0, at)), unit: join(parts.slice(at)) };
  }

  // --- Colour / theme -------------------------------------------------------
  // Any CSS colour string -> [r, g, b] via a 1px canvas (handles every syntax the webview supports).
  function toRGB(css, dflt) {
    try {
      swatchCtx.clearRect(0, 0, 1, 1);
      swatchCtx.fillStyle = '#000';
      swatchCtx.fillStyle = css;
      swatchCtx.fillRect(0, 0, 1, 1);
      const d = swatchCtx.getImageData(0, 0, 1, 1).data;
      if (d[3] === 0) return dflt;
      return [d[0], d[1], d[2]];
    } catch (e) {
      return dflt;
    }
  }
  function rgba(c, a) {
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }
  function luminance(c) {
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  }

  // Theme comes from Homey: the text colour Homey injects (--homey-text-color) is resolved
  // through the stylesheet; light text means a dark theme. OS preference is only the CSS fallback.
  function refreshColors() {
    const text = toRGB(getComputedStyle(document.body).color, [32, 36, 42]);
    const sub = toRGB(getComputedStyle(probeSub).color, [107, 114, 128]);
    dark = luminance(text) > 0.5;
    fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const next = {
      solar: dark ? [247, 184, 75] : [245, 166, 35],
      battery: dark ? [76, 208, 128] : [52, 181, 106],
      home: dark ? [90, 162, 245] : [59, 143, 240],
      grid: sub,
      text,
      sub,
      nodeBg: rgba(text, dark ? 0.14 : 0.08),
    };
    const changed = !colors || JSON.stringify(next) !== JSON.stringify(colors);
    colors = next;
    return changed;
  }

  // --- Vector helpers -------------------------------------------------------
  function sub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y };
  }
  function add(a, b) {
    return { x: a.x + b.x, y: a.y + b.y };
  }
  function mul(a, s) {
    return { x: a.x * s, y: a.y * s };
  }
  function norm(a) {
    const m = Math.hypot(a.x, a.y) || 1; return { x: a.x / m, y: a.y / m };
  }
  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function quad(a, c, b, t) {
    const u = 1 - t;
    return {
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    };
  }

  // --- Geometry -------------------------------------------------------------
  function nodeXY(id) {
    const p = layout.nodes[id];
    return { x: p[0] * W, y: p[1] * H };
  }

  // Flatten an orthogonal waypoint list into a dense polyline with rounded
  // corners, then trim the two ends back to the icon perimeter.
  function buildRoute(wpNorm) {
    const pts = wpNorm.map((p) => ({ x: p[0] * W, y: p[1] * H }));
    const dStart = norm(sub(pts[1], pts[0]));
    pts[0] = add(pts[0], mul(dStart, R));
    const last = pts.length - 1;
    const dEnd = norm(sub(pts[last - 1], pts[last]));
    pts[last] = add(pts[last], mul(dEnd, R));

    const flat = [pts[0]];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = pts[i - 1]; const cur = pts[i]; const next = pts[i + 1];
      const dIn = norm(sub(cur, prev));
      const dOut = norm(sub(next, cur));
      const r = Math.min(cornerR, dist(prev, cur) / 2, dist(cur, next) / 2);
      const aa = sub(cur, mul(dIn, r));
      const bb = add(cur, mul(dOut, r));
      flat.push(aa);
      const K = 8;
      for (let k = 1; k <= K; k += 1) flat.push(quad(aa, cur, bb, k / K));
    }
    flat.push(pts[last]);

    const cum = [0];
    for (let i = 1; i < flat.length; i += 1) cum.push(cum[i - 1] + dist(flat[i - 1], flat[i]));
    return { flat, cum, total: cum[cum.length - 1] || 1 };
  }

  function sampleRoute(geom, t) {
    const s = Math.max(0, Math.min(1, t)) * geom.total;
    const { flat, cum } = geom;
    let i = 0;
    while (i < cum.length - 2 && s > cum[i + 1]) i += 1;
    const segLen = (cum[i + 1] - cum[i]) || 1;
    const lt = (s - cum[i]) / segLen;
    const a = flat[i]; const b = flat[i + 1];
    return {
      x: a.x + (b.x - a.x) * lt,
      y: a.y + (b.y - a.y) * lt,
      tan: norm(sub(b, a)),
    };
  }

  function computeLayout() {
    R = Math.max(16, Math.min(30, Math.min(W, H) * 0.11));
    cornerR = R * 1.1;
    Object.keys(edgeGeom).forEach((k) => {
      delete edgeGeom[k];
    });
    if (!layout) return;
    Object.keys(layout.routes).forEach((key) => {
      edgeGeom[key] = buildRoute(layout.routes[key]);
    });
  }

  function setLayout(visibleIds) {
    const key = NODE_ORDER.filter((id) => visibleIds.includes(id)).join(',');
    if (key === layoutKey) return;
    layoutKey = key;
    layout = { nodes: {}, routes: {} };
    visibleIds.forEach((id) => {
      layout.nodes[id] = SLOTS[id];
    });
    Object.keys(ROUTES).forEach((route) => {
      if (route.split('-').every((id) => layout.nodes[id])) layout.routes[route] = ROUTES[route];
    });
    computeLayout();
  }

  function resize() {
    const rect = app.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    computeLayout();
    scheduleFrame();
  }

  // --- Data judgement -------------------------------------------------------
  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function intervalSeconds(source, snap) {
    const slow = num(snap.slowIntervalSeconds) || 120;
    const fast = num(snap.fastIntervalSeconds);
    if (source === 'meters' || source === 'batteryPower') return fast || slow;
    return slow; // production / inventory run on the slow cadence
  }

  function staleAfterMs(name, snap, depth) {
    const meta = snap.fields && snap.fields[name];
    const source = meta && meta.source;
    if (source === 'persisted') return Infinity;
    if (source === 'flow') return name === 'soc' ? SOC_STALE_MS : FLOW_STALE_MS;
    if (source === 'derived' && depth < 1) {
      // A derived value is only as fresh as its slowest input.
      const inputs = ['solarW', 'gridW', 'homeW', 'batteryW']
        .filter((n) => snap.fields[n] && snap.fields[n].source !== 'derived')
        .map((n) => staleAfterMs(n, snap, depth + 1));
      if (inputs.length) return Math.max(...inputs);
    }
    return (STALE_INTERVALS * intervalSeconds(source, snap)) * 1000 + STALE_SLACK_MS;
  }

  // Effective status of one snapshot field: the server's per-field status, downgraded to
  // 'stale' by the observation age (skew-free: snapshot-time delta + time since receipt).
  function readField(rx, name) {
    const { snap } = rx;
    const meta = snap.fields && snap.fields[name];
    const raw = snap[name];
    if (!meta) return { status: 'unknown', value: null };
    if (meta.status === 'absent') return { status: 'absent', value: null };
    if (meta.status === 'unknown') return { status: 'unknown', value: null };
    const isString = name === 'gridStatus';
    const value = isString ? (typeof raw === 'string' ? raw : null) : num(raw);
    if (value === null) return { status: 'unknown', value: null };
    if (meta.status === 'stale') return { status: 'stale', value };
    // Time since receipt also covers the app no longer publishing at all.
    const elapsed = performance.now() - rx.perf + rx.lag;
    const observed = num(meta.observedAt);
    const ts = num(snap.ts);
    const age = (observed !== null && ts !== null ? Math.max(0, ts - observed) : 0) + elapsed;
    if (age > staleAfterMs(name, snap, 0)) return { status: 'stale', value };
    return { status: 'ok', value };
  }

  // --- Model ----------------------------------------------------------------
  function statusLabel(status) {
    return status === 'stale' ? tr('state.outdated') : tr('state.no_data');
  }

  function buildModel(rx) {
    const { snap } = rx;
    const has = snap.has || {};
    const meta = snap.fields || {};
    const solar = readField(rx, 'solarW');
    const grid = readField(rx, 'gridW');
    const home = readField(rx, 'homeW');
    const batt = readField(rx, 'batteryW');
    const soc = readField(rx, 'soc');
    const gridStatus = readField(rx, 'gridStatus');
    const disconnected = gridStatus.status === 'ok' && gridStatus.value === 'disconnected';

    // Grid and home are always drawn (their Enphase devices, or CT clamps, may not exist; a Flow can fill them).
    // Solar and battery are optional: drawn only once they are known to exist, never as a placeholder 0.
    // Solar exists once it has a reading, or had one that is now outdated (the gateway nulls outdated values).
    const vis = {
      solar: solar.status === 'ok' || solar.status === 'stale' || (!!meta.solarW && meta.solarW.status === 'stale'),
      grid: true,
      home: true,
      battery: has.battery === true,
    };

    const nodes = {};
    // `raw` is the watts reading the eased on-screen value counts toward (null when there is no usable reading).
    // Solar
    nodes.solar = solar.status === 'ok'
      ? {
        ok: true, ...formatPower(solar.value), raw: solar.value, label: tr('node.solar'),
      }
      : {
        ok: false, value: '--', raw: null, label: statusLabel(solar.status),
      };
    // Grid
    if (disconnected) {
      nodes.grid = {
        ok: false, value: '--', raw: null, label: tr('state.disconnected'),
      };
    } else if (grid.status === 'ok') {
      let label = tr('state.idle');
      if (grid.value >= config.deadzoneW) label = tr('state.importing');
      else if (grid.value <= -config.deadzoneW) label = tr('state.exporting');
      // Tariff for the direction the grid is flowing (import while idle), only once a Flow has supplied one.
      const tariff = snap.tariff || {};
      const price = num(grid.value <= -config.deadzoneW ? tariff.export : tariff.import);
      nodes.grid = {
        ok: true, ...formatPower(grid.value), raw: grid.value, label, tariff: price === null ? null : formatPrice(price),
      };
    } else {
      nodes.grid = {
        ok: false, value: '--', raw: null, label: statusLabel(grid.status),
      };
    }
    // Home
    nodes.home = home.status === 'ok'
      ? {
        ok: true, ...formatPower(home.value), raw: home.value, label: tr('state.consuming'),
      }
      : {
        ok: false, value: '--', raw: null, label: statusLabel(home.status),
      };
    // Battery
    if (batt.status === 'ok') {
      let label = tr('state.idle');
      if (batt.value >= config.deadzoneW) label = tr('state.charging');
      else if (batt.value <= -config.deadzoneW) label = tr('state.discharging');
      nodes.battery = {
        ok: true, ...formatPower(batt.value), raw: batt.value, label,
      };
    } else {
      nodes.battery = {
        ok: false, value: '--', raw: null, label: statusLabel(batt.status),
      };
    }
    nodes.battery.soc = soc.status === 'ok' ? Math.max(0, Math.min(100, soc.value)) : null;

    // Flow allocation. Only usable readings take part; flows to or from a node with
    // unknown/stale data are not drawn. Greedy priority matching keeps every node's
    // displayed in/out within its own reading, so displayed power is conserved (the
    // allocation is an estimate: aggregate readings do not identify individual paths).
    const gridActive = grid.status === 'ok' && !disconnected && Math.abs(grid.value) >= config.deadzoneW;
    const flows = computeFlows({
      solarW: solar.status === 'ok' ? solar.value : 0,
      gridW: gridActive ? grid.value : 0,
      batteryW: batt.status === 'ok' && vis.battery ? batt.value : 0,
      homeW: home.status === 'ok' ? home.value : 0,
    });

    const summary = NODE_ORDER.filter((id) => vis[id])
      .map((id) => `${tr(`node.${id}`)}: ${nodes[id].value}${nodes[id].unit || ''} ${nodes[id].label}`)
      .join(', ');
    return {
      vis, nodes, flows, summary,
    };
  }

  function loadFraction(watts) {
    const w = Math.min(Math.abs(watts), config.maxW);
    if (w < config.deadzoneW) return 0;
    return (w / config.maxW) ** SCALE_EXP;
  }

  function computeFlows({
    solarW, gridW, batteryW, homeW,
  }) {
    const flows = [];
    const push = (from, to, watts, color) => {
      if (watts > config.deadzoneW) {
        flows.push({
          from, to, watts, color,
        });
      }
    };
    let solarSrc = Math.max(solarW, 0);
    let gridImport = Math.max(gridW, 0);
    let battDischarge = Math.max(-batteryW, 0);
    let homeSink = Math.max(homeW, 0);
    let gridExport = Math.max(-gridW, 0);
    let battCharge = Math.max(batteryW, 0);
    let t;
    t = Math.min(solarSrc, homeSink); push('solar', 'home', t, 'solar'); solarSrc -= t; homeSink -= t;
    t = Math.min(solarSrc, battCharge); push('solar', 'battery', t, 'solar'); solarSrc -= t; battCharge -= t;
    t = Math.min(solarSrc, gridExport); push('solar', 'grid', t, 'solar'); solarSrc -= t; gridExport -= t;
    t = Math.min(battDischarge, homeSink); push('battery', 'home', t, 'battery'); battDischarge -= t; homeSink -= t;
    t = Math.min(battDischarge, gridExport); push('battery', 'grid', t, 'battery'); battDischarge -= t; gridExport -= t;
    t = Math.min(gridImport, homeSink); push('grid', 'home', t, 'grid'); gridImport -= t; homeSink -= t;
    t = Math.min(gridImport, battCharge); push('grid', 'battery', t, 'grid'); gridImport -= t; battCharge -= t;
    return flows;
  }

  function resolveEdge(from, to) {
    if (edgeGeom[`${from}-${to}`]) return { key: `${from}-${to}`, reversed: false };
    if (edgeGeom[`${to}-${from}`]) return { key: `${to}-${from}`, reversed: true };
    return null;
  }

  // Sync particle/edge state with the current flows (keeps existing particles for continuity).
  function applyFlows(flows) {
    const active = {};
    const wanted = [];
    flows.forEach((f) => {
      const resolved = resolveEdge(f.from, f.to);
      if (!resolved) return;
      const lf = loadFraction(f.watts);
      if (lf <= 0) return;
      wanted.push({
        f, resolved, lf, count: Math.min(MAX_PARTICLES_PER_EDGE, Math.round(lerp(3, 48, lf))),
      });
    });
    // Global particle budget, scaled to the canvas, for low-power phones/tablets.
    const budget = Math.max(24, Math.min(MAX_PARTICLES_TOTAL, Math.round((W * H) / 800)));
    const total = wanted.reduce((s, w) => s + w.count, 0);
    const scale = total > budget ? budget / total : 1;

    wanted.forEach(({
      f, resolved, lf, count,
    }) => {
      const stateKey = `${f.from}>${f.to}`;
      active[stateKey] = true;
      let st = edgeState[stateKey];
      const isNew = !st;
      if (isNew) {
        st = { particles: [], alpha: 0 }; edgeState[stateKey] = st;
      }
      st.geomKey = resolved.key;
      st.reversed = resolved.reversed;
      st.color = colors[f.color] || colors.grid;
      st.tgt = {
        halfWidth: Math.min(lerp(1.5, R * 0.95, lf), cornerR * 0.85),
        // Route fractions per second (the reference used per-frame values at ~60 fps).
        speed: lerp(0.12, 0.84, lf),
        lineWidth: lerp(1.0, 2.8, lf),
        alpha: 1,
      };
      if (isNew) {
        st.halfWidth = st.tgt.halfWidth;
        st.speed = st.tgt.speed;
        st.lineWidth = st.tgt.lineWidth;
      }
      const desired = Math.max(2, Math.floor(count * scale));
      const ps = st.particles;
      // Surplus particles fade out, missing ones revive a fading one or fade in. A new edge fades in as a whole.
      let live = 0;
      ps.forEach((p) => {
        if (!p.dying) live += 1;
      });
      for (let i = ps.length - 1; i >= 0 && live > desired; i -= 1) {
        if (!ps[i].dying) {
          ps[i].dying = true; live -= 1;
        }
      }
      for (let i = 0; i < ps.length && live < desired; i += 1) {
        if (ps[i].dying) {
          ps[i].dying = false; live += 1;
        }
      }
      while (live < desired) {
        ps.push({
          t: Math.random(), offset: Math.random() * 2 - 1, speedMul: 0.85 + Math.random() * 0.3, a: isNew ? 1 : 0, dying: false,
        });
        live += 1;
      }
    });
    // Flows that ended fade out; stepTweens drops them once invisible.
    Object.keys(edgeState).forEach((k) => {
      if (!active[k]) edgeState[k].tgt.alpha = 0;
    });
  }

  // Ease the displayed power / SoC toward the latest reading. A node without a usable reading snaps (it shows "--").
  function syncShown(m) {
    NODE_ORDER.forEach((id) => {
      const { raw } = m.nodes[id];
      const s = shown.power[id] || (shown.power[id] = { cur: null, tgt: null });
      s.tgt = raw;
      if (raw === null || s.cur === null) s.cur = raw;
    });
    const { soc } = m.nodes.battery;
    shown.soc.tgt = soc;
    if (soc === null || shown.soc.cur === null) shown.soc.cur = soc;
  }

  // --- Easing ---------------------------------------------------------------
  function approach(cur, tgt, k, eps) {
    const d = tgt - cur;
    return Math.abs(d) <= eps ? tgt : cur + d * k;
  }

  // Advance every eased value by dt seconds; sets `settling` while anything is still moving.
  // Reduced motion snaps straight to the targets.
  function stepTweens(dt) {
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt / TWEEN_TAU_S);
    let moving = false;
    const ease = (obj, key, tgt, eps) => {
      const next = approach(obj[key], tgt, k, eps);
      if (next !== tgt) moving = true;
      obj[key] = next;
    };
    Object.keys(edgeState).forEach((key) => {
      const st = edgeState[key];
      ease(st, 'halfWidth', st.tgt.halfWidth, 0.05);
      ease(st, 'speed', st.tgt.speed, 0.002);
      ease(st, 'lineWidth', st.tgt.lineWidth, 0.02);
      ease(st, 'alpha', st.tgt.alpha, 0.01);
      if (st.tgt.alpha === 0 && st.alpha === 0) {
        delete edgeState[key];
        return;
      }
      st.particles.forEach((p) => ease(p, 'a', p.dying ? 0 : 1, 0.02));
      st.particles = st.particles.filter((p) => !(p.dying && p.a === 0));
    });
    NODE_ORDER.forEach((id) => {
      const s = shown.power[id];
      if (s && s.cur !== null) ease(s, 'cur', s.tgt, 0.5);
    });
    if (shown.soc.cur !== null) ease(shown.soc, 'cur', shown.soc.tgt, 0.05);
    settling = moving;
  }

  // --- Rendering ------------------------------------------------------------
  function drawTracks() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    Object.keys(edgeState).forEach((k) => {
      const st = edgeState[k];
      const geom = edgeGeom[st.geomKey];
      if (!geom) return;
      ctx.strokeStyle = rgba(st.color, config.trackOpacity * st.alpha);
      ctx.lineWidth = Math.max(4, st.halfWidth * 1.8);
      ctx.beginPath();
      const f = geom.flat;
      ctx.moveTo(f[0].x, f[0].y);
      for (let i = 1; i < f.length; i += 1) ctx.lineTo(f[i].x, f[i].y);
      ctx.stroke();
    });
  }

  function advanceParticles(dt) {
    Object.keys(edgeState).forEach((k) => {
      const st = edgeState[k];
      st.particles.forEach((p) => {
        p.t += st.speed * config.speedMul * p.speedMul * dt;
        if (p.t >= 1) p.t -= Math.floor(p.t);
      });
    });
  }

  // Each particle is a short fading trail sampled analytically behind its head (no history
  // buffers), so the tail length is a duration and does not depend on the frame rate.
  function drawParticles() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const samples = Math.max(2, Math.min(8, Math.round(config.trailLength / 2)));
    Object.keys(edgeState).forEach((k) => {
      const st = edgeState[k];
      const geom = edgeGeom[st.geomKey];
      if (!geom) return;
      ctx.lineWidth = st.lineWidth;
      st.particles.forEach((p) => {
        const span = st.speed * config.speedMul * p.speedMul * (config.trailLength / 60);
        const pts = [];
        for (let i = 0; i < samples; i += 1) {
          const u = Math.max(0, p.t - (span * i) / (samples - 1)); // no wrap-around streak
          const samp = sampleRoute(geom, st.reversed ? 1 - u : u);
          const perp = { x: -samp.tan.y, y: samp.tan.x };
          const off = p.offset * st.halfWidth;
          pts.push({ x: samp.x + perp.x * off, y: samp.y + perp.y * off });
        }
        const head = pts[0];
        const tail = pts[pts.length - 1];
        ctx.beginPath();
        ctx.moveTo(head.x, head.y);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
        const opacity = config.particleOpacity * st.alpha * p.a;
        if (tail.x === head.x && tail.y === head.y) {
          ctx.globalAlpha = opacity;
          ctx.strokeStyle = rgba(st.color, 1);
        } else {
          const g = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
          g.addColorStop(0, rgba(st.color, 0));
          g.addColorStop(1, rgba(st.color, opacity));
          ctx.globalAlpha = 1;
          ctx.strokeStyle = g;
        }
        ctx.stroke();
      });
    });
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGlyph(id, c, color, soc) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, R * 0.1);
    ctx.lineCap = 'round';
    const s = R / 26;
    ctx.save();
    ctx.translate(c.x, c.y);
    if (id === 'solar') {
      ctx.beginPath(); ctx.arc(0, 0, 9 * s, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i += 1) {
        const a = i * (Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 14 * s, Math.sin(a) * 14 * s);
        ctx.lineTo(Math.cos(a) * 19 * s, Math.sin(a) * 19 * s);
        ctx.stroke();
      }
    } else if (id === 'grid') {
      const P = (x, y) => ({ x: x * s, y: y * s });
      const line = (a, b) => {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      };
      line(P(0, -15), P(0, 15));
      line(P(0, -15), P(-9, -5));
      line(P(0, -15), P(9, -5));
      line(P(-11, 3), P(11, 3));
      line(P(-7, 9), P(7, 9));
      line(P(-4, 15), P(4, 15));
    } else if (id === 'home') {
      ctx.beginPath();
      ctx.moveTo(-14 * s, 2 * s);
      ctx.lineTo(0, -12 * s);
      ctx.lineTo(14 * s, 2 * s);
      ctx.lineTo(14 * s, 15 * s);
      ctx.lineTo(-14 * s, 15 * s);
      ctx.closePath();
      ctx.stroke();
    } else if (id === 'battery') {
      roundRect(-14 * s, -9 * s, 28 * s, 18 * s, 2 * s); ctx.stroke();
      ctx.fillRect(14 * s, -4 * s, 3 * s, 8 * s);
      const fillW = 24 * s * Math.max(0, Math.min(1, (soc || 0) / 100));
      if (fillW > 0) ctx.fillRect(-12 * s, -7 * s, fillW, 14 * s);
    }
    ctx.restore();
  }

  function fillTextClamped(text, x, y) {
    const half = ctx.measureText(text).width / 2;
    const cx = Math.max(half + 2, Math.min(W - half - 2, x));
    ctx.fillText(text, cx, y);
  }

  function drawNodeText(id, node, c) {
    const valueFont = Math.max(11, Math.round(R * 0.62));
    const labelFont = Math.max(10, Math.round(R * 0.42));
    const lineGap = Math.max(12, Math.round(R * 0.62));
    // Emphasised (value) and de-emphasised (unit / currency) text runs.
    const big = { font: valueFont, weight: '600', color: colors.text };
    const small = { font: labelFont, weight: '500', color: colors.sub };
    const lines = [
      { runs: [{ ...big, color: node.ok ? colors.text : colors.sub, text: node.value }, { ...small, text: node.unit || '' }] },
      {
        text: node.label, font: labelFont, weight: '500', color: colors.sub,
      },
    ];
    let aboveLines = [];
    if (id === 'battery' && node.soc !== null) {
      const soc = formatSoc(node.soc);
      aboveLines = [{ runs: [{ ...big, text: soc.value }, { ...small, text: soc.unit }] }];
    } else if (id === 'grid' && node.tariff) {
      aboveLines = [{ runs: [{ ...small, text: node.tariff.head }, { ...big, text: node.tariff.decimals }] }];
    }
    ctx.textAlign = 'center';
    const setFont = (run) => {
      ctx.font = `${run.weight} ${run.font}px ${fontFamily}`;
      ctx.fillStyle = rgba(run.color, 1);
    };
    const drawLine = (ln, y) => {
      if (!ln.runs) {
        setFont(ln);
        fillTextClamped(ln.text, c.x, y); return;
      }
      // Several runs on one shared baseline, centred together.
      const widths = ln.runs.map((run) => {
        setFont(run);
        return ctx.measureText(run.text).width;
      });
      const total = widths.reduce((a, b) => a + b, 0);
      let x = Math.max(2, Math.min(W - total - 2, c.x - total / 2));
      // `y` is the middle of the largest run; mixed sizes only line up on the alphabetic baseline.
      const baseline = y + Math.max(...ln.runs.map((run) => run.font)) * 0.35;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ln.runs.forEach((run, i) => {
        setFont(run);
        ctx.fillText(run.text, x, baseline);
        x += widths[i];
      });
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };
    const margin = Math.round(R * 0.7);
    if (aboveLines.length) {
      let y = c.y - R - Math.max(0, margin - Math.round(R * 0.12));
      aboveLines.forEach((ln) => {
        drawLine(ln, y); y -= lineGap;
      });
    }
    const bodyAbove = layout.nodes[id][1] > 0.75;
    if (bodyAbove) {
      let y = c.y - R - Math.round(R * 0.35);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        drawLine(lines[i], y); y -= lineGap;
      }
    } else {
      let y = c.y + R + margin;
      lines.forEach((ln) => {
        drawLine(ln, y); y += lineGap;
      });
    }
  }

  function drawNodes() {
    ctx.textBaseline = 'middle';
    NODE_ORDER.forEach((id) => {
      if (!model.vis[id] || !layout.nodes[id]) return;
      const base = model.nodes[id];
      const s = shown.power[id];
      const node = { ...base };
      if (base.raw !== null && s && s.cur !== null) Object.assign(node, formatPower(s.cur));
      if (id === 'battery' && base.soc !== null && shown.soc.cur !== null) node.soc = shown.soc.cur;
      const c = nodeXY(id);
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.nodeBg;
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = node.ok ? 1 : 0.4; // neutral glyph for unknown/stale data
      drawGlyph(id, c, rgba(colors[id] || colors.grid, 1), node.soc);
      ctx.globalAlpha = 1;
      drawNodeText(id, node, c);
    });
    ctx.textBaseline = 'alphabetic';
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (viewMode !== 'flow' || !model || !layout || !colors) return;
    drawTracks();
    drawParticles();
    drawNodes();
  }

  // --- Animation loop (visible + active flows only) -------------------------
  let rafId = 0;
  let lastFrame = 0;

  function isAnimating() {
    return !document.hidden && !reducedMotion && viewMode === 'flow' && Object.keys(edgeState).length > 0;
  }

  // Keep drawing while particles move or eased values are still settling (the latter also applies with reduced motion).
  function needsFrames() {
    return isAnimating() || (!document.hidden && viewMode === 'flow' && settling);
  }

  function frame(now) {
    rafId = 0;
    if (document.hidden) {
      lastFrame = 0; return;
    }
    const elapsed = lastFrame ? now - lastFrame : MIN_FRAME_MS;
    if (elapsed < MIN_FRAME_MS - 1) {
      rafId = requestAnimationFrame(frame); return;
    }
    const dt = Math.min(0.1, elapsed / 1000); // clamp after pauses/background throttling
    lastFrame = now;
    if (viewMode === 'flow') stepTweens(dt);
    if (isAnimating()) advanceParticles(dt);
    draw();
    if (needsFrames()) rafId = requestAnimationFrame(frame);
    else lastFrame = 0;
  }

  function scheduleFrame() {
    if (!rafId && !document.hidden) rafId = requestAnimationFrame(frame);
  }

  function stopFrames() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastFrame = 0;
  }

  // --- View / selection -----------------------------------------------------
  function eligibleGateways() {
    return (gateways || []).filter((g) => g.widgetEligible);
  }

  function computeView() {
    if (gateways === null) return gatewaysFailed ? 'error' : 'loading';
    if (!selected) {
      const eligible = eligibleGateways();
      if (eligible.length > 1) return 'choose';
      if (eligible.length === 0) return gateways.length > 0 ? 'upgrade' : 'nogateways';
      return 'waiting';
    }
    const entry = gateways.find((g) => g.serial === selected);
    if (!entry) return gateways.length === 0 ? 'nogateways' : 'missing';
    if (!entry.widgetEligible) return 'upgrade';
    if (latest[selected]) return 'flow';
    return stateProblem ? 'error' : 'waiting';
  }

  function showMessage(mode) {
    if (mode === 'loading') {
      messageTitle.textContent = tr('message.loading');
      messageBody.textContent = '';
    } else {
      const base = {
        nogateways: 'message.no_gateways',
        upgrade: 'message.upgrade',
        missing: 'message.missing',
        choose: 'message.choose',
        waiting: 'message.waiting',
        error: 'message.error',
      }[mode];
      messageTitle.textContent = tr(`${base}.title`);
      messageBody.textContent = tr(`${base}.body`);
    }
    retryBtn.textContent = tr('message.retry');
    retryBtn.hidden = mode !== 'error';
    messageEl.hidden = false;
  }

  let chooserSig = '';
  function updateChooser() {
    const eligible = eligibleGateways();
    const current = selected && (gateways || []).find((g) => g.serial === selected);
    const options = eligible.slice();
    if (current && !current.widgetEligible) options.push(current);
    const needChoice = eligible.length > 1 || (viewMode !== 'flow' && viewMode !== 'waiting' && eligible.length >= 1);
    if (!needChoice) {
      chooserEl.hidden = true; chooserSig = ''; return;
    }
    chooserEl.hidden = false;
    // Rebuilding options would close an open dropdown, so only do it when something changed.
    const sig = JSON.stringify([current ? current.serial : '', options.map((g) => [g.serial, g.name])]);
    if (sig === chooserSig) return;
    chooserSig = sig;
    selectEl.setAttribute('aria-label', tr('chooser.label'));
    selectEl.textContent = '';
    if (!current) {
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = tr('chooser.placeholder');
      selectEl.appendChild(ph);
    }
    options.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.serial;
      o.textContent = g.name === g.serial ? g.serial : `${g.name} (${g.serial})`;
      selectEl.appendChild(o);
    });
    selectEl.value = current ? current.serial : '';
  }

  function update() {
    viewMode = computeView();
    if (viewMode === 'flow') {
      messageEl.hidden = true;
      model = buildModel(latest[selected]);
      setLayout(NODE_ORDER.filter((id) => model.vis[id]));
      applyFlows(model.flows);
      syncShown(model);
      settling = true; // targets may have moved; the next frame re-evaluates
      canvas.setAttribute('aria-label', `${tr('aria.summary')} - ${model.summary}`);
      canvas.hidden = false;
    } else {
      model = null;
      Object.keys(edgeState).forEach((k) => {
        delete edgeState[k];
      });
      shown.power = {};
      shown.soc = { cur: null, tgt: null };
      settling = false;
      canvas.hidden = true;
      showMessage(viewMode);
    }
    updateChooser();
    scheduleFrame();
    scheduleRetry();
  }

  // Resolve the selected serial from the stored choice / single eligible gateway.
  function reconcileSelection() {
    if (gateways === null) return;
    if (!selected) {
      const stored = loadSerial();
      if (stored) selected = stored;
      else {
        const eligible = eligibleGateways();
        if (eligible.length === 1) {
          selected = eligible[0].serial; saveSerial(selected);
        }
      }
    }
  }

  function selectSerial(serial) {
    if (!/^\d{12}$/.test(serial)) return;
    selected = serial;
    saveSerial(serial);
    stateProblem = null;
    update();
    if (!latest[serial]) fetchState();
  }

  selectEl.addEventListener('change', () => {
    selectSerial(selectEl.value);
  });
  retryBtn.addEventListener('click', () => {
    refresh();
  });

  // --- Snapshots ------------------------------------------------------------
  // Newer-or-equal snapshots win; older ones (e.g. a slow initial fetch racing a realtime event)
  // are discarded. `lag` is how old the snapshot already was when we received it.
  function acceptSnapshot(snap, lag) {
    if (!snap || typeof snap !== 'object' || typeof snap.serial !== 'string') return false;
    const prev = latest[snap.serial];
    const ts = num(snap.ts);
    if (prev && ts !== null && num(prev.snap.ts) !== null && ts < prev.snap.ts) return false;
    latest[snap.serial] = { snap, perf: performance.now(), lag: Math.max(0, lag || 0) };
    return true;
  }

  function onFlow(snap) {
    if (acceptSnapshot(snap, 0) && snap.serial === selected) {
      stateProblem = null;
      update();
    }
  }

  function onGateways(list) {
    if (!Array.isArray(list)) return;
    const before = selected && eligibleGateways().some((g) => g.serial === selected);
    gateways = normaliseGateways(list);
    gatewaysFailed = false;
    reconcileSelection();
    update();
    const after = selected && eligibleGateways().some((g) => g.serial === selected);
    if (after && (!before || !latest[selected])) fetchState();
  }

  function normaliseGateways(list) {
    return list
      .filter((g) => g && typeof g.serial === 'string')
      .map((g) => ({
        serial: g.serial,
        name: typeof g.name === 'string' && g.name ? g.name : g.serial,
        widgetEligible: g.widgetEligible === true,
      }));
  }

  // --- Fetching -------------------------------------------------------------
  async function fetchState() {
    const serial = selected;
    if (!serial) return;
    try {
      const res = await Homey.api('GET', `/state/${encodeURIComponent(serial)}`);
      if (res && res.status === 'ok' && res.state) {
        const lag = num(res.serverTime) !== null && num(res.state.ts) !== null
          ? res.serverTime - res.state.ts : 0;
        acceptSnapshot(res.state, lag);
        if (serial === selected) stateProblem = null;
      } else if (res && res.status === 'unavailable') {
        if (serial === selected) stateProblem = 'unavailable';
      } else if (serial === selected) {
        stateProblem = null; // waiting/upgrade/missing are reflected by the gateway list
      }
    } catch (e) {
      if (serial === selected) stateProblem = 'unavailable';
    }
    update();
  }

  let refreshPromise = null;
  let lastRefreshAt = 0;
  function refresh() {
    if (!refreshPromise) {
      refreshPromise = doRefresh().then(() => {
        refreshPromise = null;
      }, () => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function doRefresh() {
    lastRefreshAt = Date.now();
    try {
      const res = await Homey.api('GET', '/gateways');
      if (res && res.status === 'ok' && Array.isArray(res.gateways)) {
        gateways = normaliseGateways(res.gateways);
        gatewaysFailed = false;
      } else {
        gatewaysFailed = true;
      }
    } catch (e) {
      gatewaysFailed = true;
    }
    reconcileSelection();
    if (selected && eligibleGateways().some((g) => g.serial === selected)) await fetchState();
    update();
  }

  // Browser-side retry only while the widget is showing a retryable state (no server polling).
  let retryTimer = 0;
  let retryAttempt = 0;
  function scheduleRetry() {
    const retryable = viewMode === 'error' || viewMode === 'waiting'
      || viewMode === 'nogateways' || viewMode === 'missing' || gatewaysFailed;
    if (!retryable) {
      retryAttempt = 0;
      if (retryTimer) {
        clearTimeout(retryTimer); retryTimer = 0;
      }
      return;
    }
    if (retryTimer) return;
    const slowStates = viewMode === 'nogateways' || viewMode === 'missing';
    const delay = slowStates ? 30000 : Math.min(60000, 5000 * (2 ** retryAttempt));
    retryAttempt += 1;
    // Browser code inside the widget iframe: the app-side timer rule does not apply here.
    // eslint-disable-next-line homey-app/global-timers
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (!document.hidden) refresh();
    }, delay);
  }

  function resume() {
    readConfig();
    refreshColors();
    update();
    if (Date.now() - lastRefreshAt > 2000) refresh();
  }

  // --- Lifecycle ------------------------------------------------------------
  let tickTimer = 0;
  function startTick() {
    if (tickTimer) return;
    // eslint-disable-next-line homey-app/global-timers
    tickTimer = setInterval(() => {
      if (document.hidden) return;
      const themeChanged = refreshColors();
      readConfig();
      if (themeChanged || viewMode === 'flow') update();
    }, TICK_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopFrames();
    } else {
      startTick();
      resume();
    }
  });
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      refreshColors(); update();
    });
  } catch (e) { /* older webview */ }
  try {
    const mo = new MutationObserver(() => {
      if (refreshColors()) update();
    });
    mo.observe(document.documentElement, { attributes: true });
    mo.observe(document.body, { attributes: true });
  } catch (e) { /* no MutationObserver */ }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(app);
  else window.addEventListener('resize', resize);

  // Subscribe BEFORE the initial fetch so no snapshot published meanwhile is lost.
  Homey.on(FLOW_EVENT, onFlow);
  Homey.on(GATEWAYS_EVENT, onGateways);

  let readyCalled = false;
  function signalReady() {
    if (readyCalled) return;
    readyCalled = true;
    try {
      Homey.ready();
    } catch (e) { /* nothing else to do */ }
  }

  (async function init() {
    readConfig();
    makeFormats();
    refreshColors();
    resize();
    update();
    startTick();
    // The loader must never hang: signal ready when the first read finishes or after a timeout.
    const timeout = new Promise((resolve) => {
      // eslint-disable-next-line homey-app/global-timers
      setTimeout(resolve, READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([refresh(), timeout]);
    } finally {
      signalReady();
    }
  }());
}
