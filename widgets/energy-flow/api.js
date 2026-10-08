'use strict';

/*
 * Widget-scoped API for the Energy flow widget. Read-only view on the app's
 * state snapshots. No credentials are ever handled here:
 * gateway entries are projected to { serial, name, widgetEligible } and the
 * snapshot is passed through as published by the app.
 *
 * Response shapes (stable, consumed by public/index.js):
 *   GET /gateways       -> { status: 'ok', gateways: [{ serial, name, widgetEligible }] }
 *                          { status: 'unavailable', gateways: [], reason }
 *   GET /state/:serial  -> { status: 'ok', state, serverTime }  eligible gateway with a snapshot
 *                          { status: 'waiting' }            eligible, no snapshot yet
 *                          { status: 'upgrade', name }      legacy-only gateway (no solar/grid/battery device)
 *                          { status: 'missing' }            unknown/removed serial
 *                          { status: 'unavailable', reason } app methods missing or failed
 * Handlers never throw; failures are reported as structured states.
 */

const SERIAL_PATTERN = /^\d{12}$/;

function readGateways(homey) {
  const app = homey && homey.app;
  if (!app || typeof app.getKnownGateways !== 'function') return null;
  const list = app.getKnownGateways();
  if (!Array.isArray(list)) return [];
  return list
    .filter((g) => g && typeof g.serial === 'string')
    .map((g) => ({
      serial: g.serial,
      name: typeof g.name === 'string' && g.name ? g.name : g.serial,
      widgetEligible: g.widgetEligible === true,
    }));
}

module.exports = {
  async getGateways({ homey }) {
    try {
      const gateways = readGateways(homey);
      if (gateways === null) return { status: 'unavailable', gateways: [], reason: 'unsupported' };
      return { status: 'ok', gateways };
    } catch (err) {
      return { status: 'unavailable', gateways: [], reason: 'error' };
    }
  },

  async getState({ homey, params }) {
    try {
      const serial = params && typeof params.serial === 'string' ? params.serial : '';
      if (!SERIAL_PATTERN.test(serial)) return { status: 'missing' };

      const gateways = readGateways(homey);
      if (gateways === null || typeof homey.app.getLatestState !== 'function') {
        return { status: 'unavailable', reason: 'unsupported' };
      }

      const gateway = gateways.find((g) => g.serial === serial);
      if (!gateway) return { status: 'missing' };
      if (!gateway.widgetEligible) return { status: 'upgrade', name: gateway.name };

      const state = homey.app.getLatestState(serial);
      if (!state || typeof state !== 'object') return { status: 'waiting' };
      // serverTime lets the widget judge snapshot age without trusting its own wall clock.
      return { status: 'ok', state, serverTime: Date.now() };
    } catch (err) {
      return { status: 'unavailable', reason: 'error' };
    }
  },
};
