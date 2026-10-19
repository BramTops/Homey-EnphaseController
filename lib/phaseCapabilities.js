'use strict';

/**
 * Optional per-phase capabilities (L1/L2/L3) of a device, driven by `snapshot.phases` (lib/energyModel.js).
 *
 * Opt-in per device through its `phase_capabilities` setting: most systems are single-phase and would only gain empty
 * tiles. The values come from the meter readings the fast tier already fetches, so this adds no gateway requests.
 *
 * Capabilities are added once a meter reports two or more phases and removed when the setting is turned off. A
 * gateway that stops reporting phases does not remove them at once: removal deletes the Insights history, so it
 * takes several consecutive snapshots that all say "not available". Missing or stale values are skipped, never
 * written as zero.
 */

const PHASE_NAMES = ['l1', 'l2', 'l3'];
const REMOVE_AFTER_SNAPSHOTS = 4;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Capability titles, "<label> L1" etc. (the phase label is appended). Same wording as the aggregate capabilities.
const TITLES = {
  solarPower: {
    en: 'Solar power', nl: 'Zonnevermogen', fr: 'Puissance solaire', de: 'Solarleistung',
  },
  gridPower: {
    en: 'Grid power', nl: 'Netstroom vermogen', fr: 'Puissance réseau', de: 'Netzleistung',
  },
  gridVoltage: {
    en: 'Grid voltage', nl: 'Netspanning', fr: 'Tension réseau', de: 'Netzspannung',
  },
  homePower: {
    en: 'Home consumption power',
    nl: 'Huisverbruik vermogen',
    fr: 'Puissance de consommation domestique',
    de: 'Leistung Hausverbrauch',
  },
};

/**
 * Group definition: which snapshot field feeds which capability family.
 * @param {string} field - Key in snapshot.phases
 * @param {string} prefix - Capability id prefix; the phase name (l1..l3) is appended
 * @param {Object} title - Localized title without the phase label
 */
const group = (field, prefix, title) => ({ field, prefix, title });

const SOLAR_PHASE_GROUPS = [
  group('solarW', 'measure_power.', TITLES.solarPower),
];
const GRID_PHASE_GROUPS = [
  group('gridW', 'measure_power.', TITLES.gridPower),
  group('gridV', 'measure_voltage.', TITLES.gridVoltage),
  group('homeW', 'measure_power.home_', TITLES.homePower),
];

class PhaseCapabilities {

  /**
   * @param {Homey.Device} device
   * @param {Array<{field: string, prefix: string, title: Object}>} groups
   * @param {boolean} enabled - Initial value of the device's `phase_capabilities` setting
   */
  constructor(device, groups, enabled) {
    this.device = device;
    this.groups = groups.map((g) => ({
      ...g, unavailable: 0, lastObservedAt: 0,
    }));
    this.enabled = !!enabled;
    this.queue = Promise.resolve();
  }

  /** Apply a changed `phase_capabilities` setting. Call update() afterwards with the latest snapshot, if any. */
  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  /**
   * Bring the capabilities in line with the setting and the snapshot, then write the fresh values. Calls are
   * serialised; failures are logged and never thrown.
   * @param {Object|null} state - State snapshot (may be null before the first one)
   * @returns {Promise<void>}
   */
  update(state) {
    this.queue = this.queue.then(() => this.run(state)).catch((err) => {
      this.device.error('Failed to update per-phase capabilities:', err.message);
    });
    return this.queue;
  }

  async run(state) {
    for (const g of this.groups) {
      if (this.device.destroyed) return;
      const block = state && state.phases ? state.phases[g.field] : null;
      await this.sync(g, block);
      await this.write(g, block);
    }
  }

  /** Number of phases the group should expose, or null to leave it as it is. */
  wanted(g, block) {
    if (!this.enabled) return 0;
    if (!block || block.count === null || block.count === undefined) return null;
    if (block.count === 0) {
      g.unavailable += 1;
      return g.unavailable >= REMOVE_AFTER_SNAPSHOTS ? 0 : null;
    }
    g.unavailable = 0;
    return Math.min(block.count, PHASE_NAMES.length);
  }

  async sync(g, block) {
    const want = this.wanted(g, block);
    if (want === null) return;

    for (let idx = 0; idx < PHASE_NAMES.length; idx++) {
      const id = `${g.prefix}${PHASE_NAMES[idx]}`;
      if (idx < want && !this.device.hasCapability(id)) {
        this.device.log(`Adding per-phase capability: ${id}`);
        let added = true;
        await this.device.addCapability(id).catch((err) => {
          added = false;
          this.device.error(`Failed to add capability ${id}:`, err.message);
        });
        if (added) {
          const label = PHASE_NAMES[idx].toUpperCase();
          const title = {};
          Object.keys(g.title).forEach((lang) => {
            title[lang] = `${g.title[lang]} ${label}`;
          });
          await this.device.setCapabilityOptions(id, { title }).catch((err) => {
            this.device.error(`Failed to set options for ${id}:`, err.message);
          });
        }
      } else if (idx >= want && this.device.hasCapability(id)) {
        this.device.log(`Removing per-phase capability: ${id}`);
        await this.device.removeCapability(id).catch((err) => {
          this.device.error(`Failed to remove capability ${id}:`, err.message);
        });
      }
    }
  }

  async write(g, block) {
    if (!this.enabled || !block || block.status !== 'fresh' || !Array.isArray(block.values)) return;
    if (!finite(block.observedAt) || block.observedAt < g.lastObservedAt) return;
    g.lastObservedAt = block.observedAt;

    for (let idx = 0; idx < PHASE_NAMES.length; idx++) {
      const id = `${g.prefix}${PHASE_NAMES[idx]}`;
      const value = block.values[idx];
      if (finite(value) && this.device.hasCapability(id) && this.device.getCapabilityValue(id) !== value) {
        await this.device.setCapabilityValue(id, value).catch((err) => {
          this.device.error(`Failed to set ${id}:`, err.message);
        });
      }
    }
  }

}

module.exports = {
  PhaseCapabilities,
  SOLAR_PHASE_GROUPS,
  GRID_PHASE_GROUPS,
  REMOVE_AFTER_SNAPSHOTS,
};
