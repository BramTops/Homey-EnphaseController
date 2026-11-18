/* eslint-env browser */
/* eslint-disable no-use-before-define, no-nested-ternary, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unused-vars, strict */

// Energy distribution widget: the same data as the Energy flow widget, drawn as a two-column flow diagram.
// Sources on the left (solar, battery, grid), destinations on the right (home, battery, grid); battery and grid sit on
// whichever side their power flows. Bar heights follow power, ribbons and particles are coloured by their source, and
// right-side bars are stacked in the colours of what feeds them.
//
// Data model: the widget is a renderer of the app's widget view (lib/widgetView.js), read via the widget API
// (GET /gateways, GET /state/:serial) plus the realtime events 'enphase:flow' and 'enphase:gateways'. The app decides
// which readings are usable, which nodes exist and how power is allocated over flows; this widget only applies its own
// display settings (deadzone, scale, labels) and draws. Nodes without flows (inactive or without current data) are not
// drawn. Everything drawn is an allocation of the aggregate readings, not a measurement of individual paths.
// The gateway selection, messages and view refresh mirror widgets/energy-flow/public/index.js.
// eslint-disable-next-line no-unused-vars
function onHomeyReady(Homey) {
  const FLOW_EVENT = 'enphase:flow';
  const GATEWAYS_EVENT = 'enphase:gateways';
  // Own strings first, then the ones shared with the Energy flow widget (node names, states, messages).
  const KEY_PREFIXES = ['widget.energy_distribution.', 'widget.energy_flow.'];

  // --- Tunables -------------------------------------------------------------
  // Exponent < 1 compresses the scale so changes at the low end move the visuals more than the same change at the high
  // end. Particles use it exactly like the Energy flow widget; the absolute scale uses it for the diagram's total height
  // only (inside the diagram widths stay linear, so ribbons add up).
  const SCALE_EXP = 0.7;
  const MAX_PARTICLES_PER_EDGE = 40;
  const MAX_PARTICLES_TOTAL = 120;
  const MIN_FILL = 0.07; // absolute scale: smallest share of the height the diagram uses
  const MIN_RIBBON_PX = 2; // a small flow next to a large one stays visible
  const MIN_FRAME_MS = 33; // ~30 fps is plenty for a dashboard widget
  const TICK_MS = 5000; // view validity / theme re-evaluation while visible
  // A view is re-fetched when its validUntil passes (the app then judges staleness anew). Should that fail, every
  // reading counts as outdated this long after validUntil (the app stopped answering).
  const EXPIRY_GRACE_MS = 15000;
  const DUE_DELAY_MS = 250;
  const READY_TIMEOUT_MS = 8000;
  // Visuals ease toward each new reading (critically damped) instead of jumping; ~95% settled after 3 * tau.
  const TWEEN_TAU_S = 0.7;

  // Fixed vertical order per side, so nodes never swap places. Battery and grid share rows on both sides.
  const LEFT = ['solar', 'battery', 'grid'];
  const RIGHT = ['home', 'battery', 'grid'];
  const READING_IDS = {
    solar: 'solarW', grid: 'gridW', home: 'homeW', battery: 'batteryW',
  };

  // English fallbacks, used only if the locale lookup does not resolve a key.
  const FALLBACK = {
    number_locale: 'en-GB',
    'node.solar': 'Solar',
    'node.grid': 'Grid',
    'node.home': 'Home',
    'node.battery': 'Battery',
    'message.loading': 'Loading...',
    'message.retry': 'Try again',
    'message.no_flow': 'No power flowing',
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
    'aria.summary': 'Energy distribution',
  };

  function tr(key) {
    for (const prefix of KEY_PREFIXES) {
      let v = null;
      try {
        v = Homey.__(prefix + key);
      } catch (e) {
        v = null;
      }
      if (typeof v === 'string' && v && v !== prefix + key) return v;
    }
    return FALLBACK[key] || key;
  }

  // User-tunable visuals (widget settings; see widget.compose.json). Shared ids mean the same as in the Energy flow
  // widget; trackOpacity is the ribbon opacity here.
  const config = {
    scale: 'relative',
    labels: 'outside',
    trackOpacity: 0.20,
    speedMul: 1.0,
    trailLength: 10, // in 60 fps frames; converted to time so it is frame-rate independent
    particleOpacity: 0.90,
    maxW: 5000,
    deadzoneW: 25,
  };
  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }
  function readConfig() {
    try {
      const s = (Homey.getSettings && Homey.getSettings()) || {};
      config.scale = s.scale === 'absolute' ? 'absolute' : 'relative';
      config.labels = s.labels === 'inside' ? 'inside' : 'outside';
      config.trackOpacity = clampNum(s.trackOpacity, 0, 100, 20) / 100;
      config.speedMul = clampNum(s.particleSpeed, 10, 400, 100) / 100;
      config.trailLength = Math.round(clampNum(s.trailLength, 2, 40, 10));
      config.particleOpacity = clampNum(s.particleOpacity, 0, 100, 90) / 100;
      config.maxW = clampNum(s.maxPower, 500, 20000, 5000);
      config.deadzoneW = Math.min(clampNum(s.deadzone, 0, 500, 25), config.maxW - 1);
    } catch (e) { /* keep current values */ }
  }

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
  let colors = null;
  let fontFamily = 'sans-serif';
  let dark = false;
  // "from>to" -> { from, to, w, a, speed, lineWidth, lf, tgt: { w, a, speed, lineWidth }, particles }
  // w/a/speed/lineWidth are the eased values being drawn; `tgt` holds where they are heading.
  // Particles carry their own fade `a` (and `dying` while fading out) so counts change without popping.
  const flowState = {};
  const nodeState = { L: {}, R: {} }; // side -> id -> { a, tgt } (presence fade, so gaps open and close smoothly)
  const shown = { power: {}, soc: { cur: null, tgt: null } }; // eased label readings: id -> { cur, tgt }
  let primed = false; // false until the first model after (re)entering the flow view: that one is drawn without easing
  let settling = false; // true while any eased value has not reached its target
  let labelCache = { key: '', width: 0 };

  let gateways = null; // null until the first successful /gateways answer
  let gatewaysFailed = false;
  let selected = null;
  const latest = {}; // serial -> { view, perf, lag } (newest widget view per serial)
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
    return `enphase-energy-distribution:${id}`;
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

  // --- Formatting (same as the Energy flow widget) --------------------------
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
    return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`;
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
      grid: sub,
      text,
      sub,
      halo: dark ? [0, 0, 0] : [255, 255, 255], // behind labels drawn over the ribbons
    };
    const changed = !colors || JSON.stringify(next) !== JSON.stringify(colors);
    colors = next;
    if (changed) labelCache = { key: '', width: 0 };
    return changed;
  }

  function resize() {
    const rect = app.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleFrame();
  }

  // --- View judgement -------------------------------------------------------
  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  // The app's clock as seen from here: the view's own time, plus how old it was on arrival, plus the time since.
  function serverNow(rx) {
    return rx.view.ts + rx.lag + (performance.now() - rx.perf);
  }
  // validUntil passed: time to ask the app for a fresh view.
  function isDue(rx) {
    const until = num(rx.view.validUntil);
    return until !== null && serverNow(rx) >= until;
  }
  // No fresh view arrived in time after validUntil: the app stopped answering, so nothing is current any more.
  function isExpired(rx) {
    const until = num(rx.view.validUntil);
    return until !== null && serverNow(rx) > until + EXPIRY_GRACE_MS;
  }
  // One reading from the view: { status: 'ok' | 'stale' | 'unknown' | 'absent', value }.
  function readField(rx, name) {
    const r = rx.view.readings && rx.view.readings[name];
    if (!r || typeof r !== 'object') return { status: 'unknown', value: null };
    if (r.status === 'absent') return { status: 'absent', value: null };
    const value = name === 'gridStatus' ? (typeof r.value === 'string' ? r.value : null) : num(r.value);
    if (value === null || (r.status !== 'ok' && r.status !== 'stale')) return { status: 'unknown', value: null };
    if (r.status === 'ok' && isExpired(rx)) return { status: 'stale', value };
    return { status: r.status, value };
  }

  // --- Model ----------------------------------------------------------------
  function buildModel(rx) {
    const { view } = rx;
    // Flows are the app's allocation of the usable readings; the deadzone is this widget's display setting. Once the
    // view has expired nothing is current, so nothing flows (and with no flows, no node is drawn).
    const flows = isExpired(rx) ? [] : (Array.isArray(view.flows) ? view.flows : [])
      .filter((f) => f && LEFT.includes(f.from) && RIGHT.includes(f.to) && f.from !== f.to
        && num(f.watts) !== null && f.watts > config.deadzoneW)
      .map((f) => ({ from: f.from, to: f.to, watts: f.watts }));

    // Labels show each node's own reading (like the Energy flow widget), not the sum of its drawn flows.
    const readings = {};
    Object.keys(READING_IDS).forEach((id) => {
      const r = readField(rx, READING_IDS[id]);
      readings[id] = r.status === 'ok' ? Math.abs(r.value) : null;
    });
    const soc = readField(rx, 'soc');
    const tariff = view.tariff || {};

    const describe = (id) => (readings[id] === null ? tr(`node.${id}`)
      : `${tr(`node.${id}`)} ${formatPower(readings[id]).value} ${formatPower(readings[id]).unit}`);
    const sources = LEFT.filter((id) => flows.some((f) => f.from === id)).map(describe);
    const sinks = RIGHT.filter((id) => flows.some((f) => f.to === id)).map(describe);
    const summary = flows.length ? `${sources.join(', ')} → ${sinks.join(', ')}` : tr('message.no_flow');
    return {
      flows,
      readings,
      soc: soc.status === 'ok' ? Math.max(0, Math.min(100, soc.value)) : null,
      tariff: { import: num(tariff.import), export: num(tariff.export) },
      summary,
    };
  }

  // Same as the Energy flow widget: share of full-scale power, curved, 0 inside the deadzone.
  function loadFraction(watts) {
    const w = Math.min(Math.abs(watts), config.maxW);
    if (w < config.deadzoneW) return 0;
    return (w / config.maxW) ** SCALE_EXP;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Sync flow, node and particle state with the model (keeps existing particles for continuity).
  function applyModel(m) {
    const snap = !primed; // first model in this view: draw it as is
    primed = true;
    const active = {};
    const wanted = m.flows.map((f) => {
      const lf = loadFraction(f.watts);
      return { f, lf, count: Math.min(MAX_PARTICLES_PER_EDGE, Math.round(lerp(3, 48, lf))) };
    });
    // Global particle budget, scaled to the canvas, for low-power phones/tablets.
    const budget = Math.max(24, Math.min(MAX_PARTICLES_TOTAL, Math.round((W * H) / 800)));
    const totalCount = wanted.reduce((s, w) => s + w.count, 0);
    const scale = totalCount > budget ? budget / totalCount : 1;

    wanted.forEach(({ f, lf, count }) => {
      const key = `${f.from}>${f.to}`;
      active[key] = true;
      let st = flowState[key];
      const isNew = !st;
      if (isNew) {
        st = {
          from: f.from, to: f.to, w: 0, a: 0, particles: [],
        };
        flowState[key] = st;
      }
      st.lf = lf;
      st.tgt = {
        w: f.watts,
        a: 1,
        // Ribbon fractions per second, as the Energy flow widget's route fractions.
        speed: lerp(0.12, 0.84, lf),
        lineWidth: lerp(1.0, 2.8, lf),
      };
      if (isNew) {
        st.speed = st.tgt.speed;
        st.lineWidth = st.tgt.lineWidth;
      }
      if (snap) {
        st.w = st.tgt.w;
        st.a = 1;
      }
      const desired = Math.max(2, Math.floor(count * scale));
      const ps = st.particles;
      // Surplus particles fade out, missing ones revive a fading one or fade in.
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
          t: Math.random(), offset: (Math.random() - 0.5) * 0.76, speedMul: 0.85 + Math.random() * 0.3, a: snap ? 1 : 0, dying: false,
        });
        live += 1;
      }
    });
    // Flows that ended shrink and fade out; stepTweens drops them once invisible.
    Object.keys(flowState).forEach((key) => {
      if (active[key]) return;
      const st = flowState[key];
      st.tgt = { ...st.tgt, w: 0, a: 0 };
    });
    // A node is present while it has a flow on that side.
    [['L', LEFT, 'from'], ['R', RIGHT, 'to']].forEach(([side, order, end]) => {
      order.forEach((id) => {
        const n = nodeState[side][id] || (nodeState[side][id] = { a: 0, tgt: 0 });
        n.tgt = m.flows.some((f) => f[end] === id) ? 1 : 0;
        if (snap) n.a = n.tgt;
      });
    });
    // Eased label readings. A node without a usable reading snaps.
    Object.keys(READING_IDS).forEach((id) => {
      const raw = m.readings[id];
      const s = shown.power[id] || (shown.power[id] = { cur: null, tgt: null });
      s.tgt = raw;
      if (raw === null || s.cur === null || snap) s.cur = raw;
    });
    shown.soc.tgt = m.soc;
    if (m.soc === null || shown.soc.cur === null || snap) shown.soc.cur = m.soc;
  }

  function resetDrawState() {
    Object.keys(flowState).forEach((k) => {
      delete flowState[k];
    });
    nodeState.L = {};
    nodeState.R = {};
    shown.power = {};
    shown.soc = { cur: null, tgt: null };
    primed = false;
    settling = false;
  }

  // --- Easing ---------------------------------------------------------------
  function approach(obj, key, tgt, dt, eps) {
    const cur = obj[key];
    const omega = 2 / TWEEN_TAU_S;
    const offset = cur - tgt;
    const velocity = obj[`${key}Velocity`] || 0;
    const c = velocity + omega * offset;
    const decay = Math.exp(-omega * dt);
    const next = tgt + (offset + c * dt) * decay;
    const nextVelocity = (velocity - omega * c * dt) * decay;
    if (Math.abs(next - tgt) <= eps) {
      obj[`${key}Velocity`] = 0;
      return tgt;
    }
    obj[`${key}Velocity`] = nextVelocity;
    return next;
  }

  // Advance every eased value by dt seconds; sets `settling` while anything is still moving.
  // Reduced motion snaps straight to the targets.
  function stepTweens(dt) {
    let moving = false;
    const ease = (obj, key, tgt, eps, min = -Infinity, max = Infinity) => {
      const next = Math.max(min, Math.min(max, reducedMotion ? tgt : approach(obj, key, tgt, dt, eps)));
      if (next !== tgt) moving = true;
      obj[key] = next;
    };
    Object.keys(flowState).forEach((key) => {
      const st = flowState[key];
      ease(st, 'w', st.tgt.w, 0.5, 0);
      ease(st, 'a', st.tgt.a, 0.005, 0, 1);
      ease(st, 'speed', st.tgt.speed, 0.002);
      ease(st, 'lineWidth', st.tgt.lineWidth, 0.02);
      if (st.tgt.a === 0 && st.a === 0 && st.w === 0) {
        delete flowState[key];
        return;
      }
      st.particles.forEach((p) => ease(p, 'a', p.dying ? 0 : 1, 0.02, 0, 1));
      st.particles = st.particles.filter((p) => !(p.dying && p.a === 0));
    });
    ['L', 'R'].forEach((side) => Object.values(nodeState[side]).forEach((n) => ease(n, 'a', n.tgt, 0.005, 0, 1)));
    Object.keys(shown.power).forEach((id) => {
      const s = shown.power[id];
      if (s.cur !== null && s.tgt !== null) ease(s, 'cur', s.tgt, 0.5);
    });
    if (shown.soc.cur !== null && shown.soc.tgt !== null) ease(shown.soc, 'cur', shown.soc.tgt, 0.05);
    settling = moving;
  }

  function advanceParticles(dt) {
    Object.values(flowState).forEach((st) => {
      st.particles.forEach((p) => {
        p.t += st.speed * config.speedMul * p.speedMul * dt;
        if (p.t >= 1) p.t -= Math.floor(p.t);
      });
    });
  }

  // --- Layout ---------------------------------------------------------------
  function fonts() {
    const narrow = W < 300;
    const value = narrow ? 13 : 15;
    const name = narrow ? 10 : 11;
    return {
      narrow, value, name, extra: name + 1,
    };
  }
  function run(text, size, weight, color) {
    return {
      text, size, weight, color,
    };
  }
  function runsWidth(runs) {
    return runs.reduce((s, r) => {
      ctx.font = `${r.weight} ${r.size}px ${fontFamily}`;
      return s + ctx.measureText(r.text).width;
    }, 0);
  }
  function valueRuns(watts, f) {
    const p = formatPower(watts);
    return [run(p.value, f.value, 600, colors.text), run(p.unit, f.name, 500, colors.sub)];
  }
  // Extra line above the value, as in the Energy flow widget: battery SoC, grid tariff (import while the grid is a
  // source, export while it is a destination; only once a Flow has supplied it).
  function extraRuns(id, side, f, socOverride) {
    if (id === 'battery') {
      const soc = socOverride !== undefined ? socOverride : shown.soc.cur;
      if (soc === null) return null;
      const s = formatSoc(soc);
      return [run(s.value, f.extra, 600, colors.text), run(s.unit, f.name, 500, colors.sub)];
    }
    if (id === 'grid' && model) {
      const price = side === 'L' ? model.tariff.import : model.tariff.export;
      if (price === null) return null;
      const p = formatPrice(price);
      return [run(p.head, f.name, 500, colors.sub), run(p.decimals, f.extra, 600, colors.text)];
    }
    return null;
  }

  // Width of the label column (labels outside): the widest label this widget can show, so ribbons do not change length
  // as values change.
  function labelColumnWidth(f) {
    const tariff = model ? model.tariff : {};
    const key = [W < 300, fontFamily, tariff.import, tariff.export].join('|');
    if (labelCache.key === key) return labelCache.width;
    const candidates = [
      valueRuns(8888, f),
      extraRuns('battery', 'L', f, 100),
      extraRuns('grid', 'L', f),
      extraRuns('grid', 'R', f),
      ...Object.keys(READING_IDS).map((id) => [run(tr(`node.${id}`), f.name, 500, colors.sub)]),
    ].filter(Boolean);
    const width = Math.ceil(Math.max(...candidates.map(runsWidth)));
    labelCache = { key, width };
    return width;
  }

  // Node stacks and ribbon slots for the current (eased) state.
  function computeGeometry() {
    const f = fonts();
    const outside = config.labels === 'outside';
    const barW = f.narrow ? 6 : 8;
    const pad = 12;
    const lab = outside ? Math.min(labelColumnWidth(f) + 8, Math.round(W * 0.32)) : 0;
    const xL = pad + lab;
    const xR = Math.max(xL + barW + 20, W - pad - lab - barW);
    const padT = 14;
    const padB = 14;
    const avail = Math.max(10, H - padT - padB);
    const gap = f.narrow ? 8 : 10;
    const flows = Object.values(flowState);
    const total = flows.reduce((s, st) => s + st.w, 0);

    const gapSum = (side, order) => {
      let s = 0;
      let any = false;
      order.forEach((id) => {
        const n = nodeState[side][id];
        if (!n || n.a <= 0.001) return;
        if (any) s += gap * n.a;
        any = true;
      });
      return s;
    };
    const gaps = Math.max(gapSum('L', LEFT), gapSum('R', RIGHT));
    // Relative: always the full height. Absolute: the total follows total power on the particle curve.
    const fill = config.scale === 'absolute' ? Math.max(MIN_FILL, (Math.min(total, config.maxW) / config.maxW) ** SCALE_EXP) : 1;
    const k = total > 0 ? Math.max(0, (avail - gaps) * fill) / total : 0;
    flows.forEach((st) => {
      st.px = Math.max(st.w * k, MIN_RIBBON_PX) * st.a;
    });

    const place = (side, order, own, other, otherOrder) => {
      const items = [];
      let y = 0;
      let any = false;
      order.forEach((id) => {
        const n = nodeState[side][id];
        const fl = flows.filter((st) => st[own] === id)
          .sort((a, b) => otherOrder.indexOf(a[other]) - otherOrder.indexOf(b[other]));
        const h = fl.reduce((s, st) => s + st.px, 0);
        if ((!n || n.a <= 0.001) && h < 0.01) return;
        const a = n ? n.a : 0;
        if (any) y += gap * a;
        any = true;
        items.push({
          id, side, y, h, a, fl,
        });
        y += h;
      });
      const off = padT + (avail - y) / 2;
      items.forEach((it) => {
        it.y += off;
      });
      return items;
    };
    const left = place('L', LEFT, 'from', 'to', RIGHT);
    const right = place('R', RIGHT, 'to', 'from', LEFT);
    left.forEach((it) => {
      let { y } = it;
      it.fl.forEach((st) => {
        st.y0 = y; y += st.px;
      });
    });
    right.forEach((it) => {
      let { y } = it;
      it.fl.forEach((st) => {
        st.y1 = y; y += st.px;
      });
    });
    return {
      f, outside, barW, xL, xR, left, right, flows, total,
    };
  }

  // --- Rendering ------------------------------------------------------------
  function bezier(a, b, c, d, t) {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  }

  function drawRibbons(g) {
    const x0 = g.xL + g.barW;
    const x1 = g.xR;
    const mx = (x0 + x1) / 2;
    g.flows.forEach((st) => {
      if (st.px <= 0.05 || st.y0 === undefined || st.y1 === undefined) return;
      const c = colors[st.from] || colors.grid;
      const grad = ctx.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, rgba(c, config.trackOpacity * st.a));
      grad.addColorStop(1, rgba(c, config.trackOpacity * 0.7 * st.a));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, st.y0);
      ctx.bezierCurveTo(mx, st.y0, mx, st.y1, x1, st.y1);
      ctx.lineTo(x1, st.y1 + st.px);
      ctx.bezierCurveTo(mx, st.y1 + st.px, mx, st.y0 + st.px, x0, st.y0 + st.px);
      ctx.closePath();
      ctx.fill();
    });
  }

  // Each particle is a short fading trail sampled analytically behind its head (no history
  // buffers), so the tail length is a duration and does not depend on the frame rate.
  function drawParticles(g) {
    const x0 = g.xL + g.barW;
    const x1 = g.xR;
    const mx = (x0 + x1) / 2;
    const samples = Math.max(2, Math.min(8, Math.round(config.trailLength / 2)));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    g.flows.forEach((st) => {
      if (st.px <= 0.05 || st.y0 === undefined || st.y1 === undefined) return;
      const c = colors[st.from] || colors.grid;
      ctx.lineWidth = Math.min(st.lineWidth, Math.max(1, st.px * 0.6));
      st.particles.forEach((p) => {
        const span = st.speed * config.speedMul * p.speedMul * (config.trailLength / 60);
        const at = (t) => ({
          x: bezier(x0, mx, mx, x1, t),
          y: bezier(st.y0, st.y0, st.y1, st.y1, t) + st.px * (0.5 + p.offset),
        });
        const pts = [];
        for (let i = 0; i < samples; i += 1) pts.push(at(Math.max(0, p.t - (span * i) / (samples - 1)))); // no wrap-around streak
        const head = pts[0];
        const tail = pts[pts.length - 1];
        ctx.beginPath();
        ctx.moveTo(head.x, head.y);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
        const opacity = config.particleOpacity * st.a * p.a;
        if (tail.x === head.x && tail.y === head.y) {
          ctx.strokeStyle = rgba(c, opacity);
        } else {
          const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
          grad.addColorStop(0, rgba(c, 0));
          grad.addColorStop(1, rgba(c, opacity));
          ctx.strokeStyle = grad;
        }
        ctx.stroke();
      });
    });
  }

  function fillBar(x, y, w, h, color) {
    if (h < 0.3) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    const r = Math.min(2, h / 2);
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  // Left bars in the source colour; right bars stacked in the colours of what feeds them.
  function drawBars(g) {
    g.left.forEach((it) => fillBar(g.xL, it.y, g.barW, it.h, rgba(colors[it.id] || colors.grid, it.a)));
    g.right.forEach((it) => it.fl.forEach((st) => {
      fillBar(g.xR, st.y1, g.barW, st.px, rgba(colors[st.from] || colors.grid, it.a));
    }));
  }

  function drawRuns(runs, x, yMid, align, alpha, halo) {
    const total = runsWidth(runs);
    let sx = align === 'right' ? x - total : x;
    sx = Math.max(2, Math.min(W - total - 2, sx));
    // Mixed sizes only line up on the alphabetic baseline.
    const baseline = yMid + Math.max(...runs.map((r) => r.size)) * 0.35;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    runs.forEach((r) => {
      ctx.font = `${r.weight} ${r.size}px ${fontFamily}`;
      if (halo) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = rgba(colors.halo, (dark ? 0.55 : 0.75) * alpha);
        ctx.strokeText(r.text, sx, baseline);
      }
      ctx.fillStyle = rgba(r.color, alpha);
      ctx.fillText(r.text, sx, baseline);
      sx += ctx.measureText(r.text).width;
    });
  }

  // Label block per node: [extra] / value / name, centred on its bar; blocks are pushed apart where they would overlap.
  function drawLabels(g) {
    const { f } = g;
    const side = (items, isLeft) => {
      const ls = items.filter((it) => it.a > 0.25).map((it) => {
        const extra = extraRuns(it.id, it.side, f);
        return {
          it, extra, h: f.value + f.name + 6 + (extra ? f.extra + 3 : 0), cy: it.y + it.h / 2,
        };
      });
      const between = (i) => (ls[i - 1].h + ls[i].h) / 2;
      for (let i = 1; i < ls.length; i += 1) ls[i].cy = Math.max(ls[i].cy, ls[i - 1].cy + between(i));
      if (ls.length) {
        const last = ls[ls.length - 1];
        last.cy = Math.min(last.cy, H - 4 - last.h / 2);
      }
      for (let i = ls.length - 2; i >= 0; i -= 1) ls[i].cy = Math.min(ls[i].cy, ls[i + 1].cy - between(i + 1));
      if (ls.length) ls[0].cy = Math.max(ls[0].cy, ls[0].h / 2 + 4);

      ls.forEach(({
        it, extra, h, cy,
      }) => {
        let x;
        let align;
        if (g.outside) {
          x = isLeft ? g.xL - 6 : g.xR + g.barW + 6;
          align = isLeft ? 'right' : 'left';
        } else {
          x = isLeft ? g.xL + g.barW + 6 : g.xR - 6;
          align = isLeft ? 'left' : 'right';
        }
        const alpha = Math.min(1, (it.a - 0.25) / 0.5);
        const s = shown.power[it.id];
        // The node's own reading; the sum of its drawn flows while the reading is not there (should not happen).
        const watts = s && s.cur !== null ? s.cur : it.fl.reduce((sum, st) => sum + st.w, 0);
        let y = cy - h / 2 + 3;
        if (extra) {
          drawRuns(extra, x, y + f.extra / 2, align, alpha, !g.outside);
          y += f.extra + 3;
        }
        drawRuns(valueRuns(watts, f), x, y + f.value / 2, align, alpha, !g.outside);
        y += f.value + 3;
        drawRuns([run(tr(`node.${it.id}`), f.name, 500, colors.sub)], x, y + f.name / 2, align, alpha, !g.outside);
      });
    };
    side(g.left, true);
    side(g.right, false);
  }

  function drawEmpty(g) {
    const visible = g.flows.reduce((m, st) => Math.max(m, st.a), 0);
    if (visible >= 1) return;
    ctx.globalAlpha = 1 - visible;
    ctx.font = `500 13px ${fontFamily}`;
    ctx.fillStyle = rgba(colors.sub, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tr('message.no_flow'), W / 2, H / 2);
    ctx.globalAlpha = 1;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    if (viewMode !== 'flow' || !model || !colors) return;
    const g = computeGeometry();
    drawRibbons(g);
    drawParticles(g);
    drawBars(g);
    drawLabels(g);
    drawEmpty(g);
  }

  // --- Animation loop (visible + active flows only) -------------------------
  let rafId = 0;
  let lastFrame = 0;

  function isAnimating() {
    return !document.hidden && !reducedMotion && viewMode === 'flow' && Object.keys(flowState).length > 0;
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
      applyModel(model);
      settling = true; // targets may have moved; the next frame re-evaluates
      canvas.setAttribute('aria-label', `${tr('aria.summary')} - ${model.summary}`);
      canvas.hidden = false;
    } else {
      model = null;
      resetDrawState();
      canvas.hidden = true;
      showMessage(viewMode);
    }
    updateChooser();
    scheduleFrame();
    scheduleRetry();
    checkDue();
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
    if (serial !== selected) resetDrawState();
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

  // --- Views ----------------------------------------------------------------
  // Newer-or-equal views win; older ones (e.g. a slow initial fetch racing a realtime event)
  // are discarded. `lag` is how old the view already was when we received it.
  function acceptView(view, lag) {
    if (!view || typeof view !== 'object' || typeof view.serial !== 'string') return false;
    if (num(view.ts) === null || !view.readings || typeof view.readings !== 'object') return false;
    const prev = latest[view.serial];
    if (prev && view.ts < prev.view.ts) return false;
    latest[view.serial] = { view, perf: performance.now(), lag: Math.max(0, lag || 0) };
    return true;
  }

  // Ask for a fresh view once the current one's validUntil has passed. Once per validUntil, so a clock estimate running
  // slightly ahead of the app cannot cause a fetch loop; expiry covers a fetch that never succeeds.
  let dueTimer = 0;
  let dueFetchedFor = null;
  function checkDue() {
    if (dueTimer) {
      clearTimeout(dueTimer); dueTimer = 0;
    }
    const rx = selected && latest[selected];
    if (!rx || document.hidden || viewMode !== 'flow') return;
    const until = num(rx.view.validUntil);
    if (until === null) return;
    if (isDue(rx)) {
      if (dueFetchedFor !== until) {
        dueFetchedFor = until;
        fetchState();
      }
      return;
    }
    // Browser code inside the widget iframe: the app-side timer rule does not apply here.
    // eslint-disable-next-line homey-app/global-timers
    dueTimer = setTimeout(() => {
      dueTimer = 0;
      checkDue();
    }, Math.max(0, until - serverNow(rx)) + DUE_DELAY_MS);
  }

  function onFlow(view) {
    if (acceptView(view, 0) && view.serial === selected) {
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
        acceptView(res.state, lag);
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

  // Subscribe BEFORE the initial fetch so no view published meanwhile is lost.
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
