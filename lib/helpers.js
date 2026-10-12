'use strict';

/**
 * Calculate the median value from an array of numbers.
 * @param {Array<number>} values - Array of numbers
 * @returns {number} The median value
 */
function calculateMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2.0;
}

/**
 * Calculate trapezoidal energy integration in kWh.
 * @param {number} watts - Current power reading in Watts
 * @param {number} lastReportWatts - Previous power reading in Watts
 * @param {number} dtHours - Time delta in hours
 * @returns {number} Energy accumulated in kWh
 */
function calculateTrapezoidalEnergy(watts, lastReportWatts, dtHours) {
  if (dtHours <= 0 || dtHours >= 24) return 0;
  const avgPower = (watts + lastReportWatts) / 2;
  const energyWh = avgPower * dtHours;
  return energyWh / 1000;
}

// Unwired production meter check (pairing only). A production CT with clamps follows the inverters closely; one
// without clamps only reads its own electronics: a few watts at most, regardless of what the inverters deliver.
const UNWIRED_METER_MAX_W = 10; // meter reading below this (absolute: a reversed clamp reads a large negative value)
const UNWIRED_METER_MAX_RATIO = 0.1; // ... and below this fraction of the inverter total
const UNWIRED_METER_MIN_INVERTER_W = 100; // inverters must be clearly producing; at night nothing can be concluded

/**
 * Does the gateway report a production meter that has no CT clamps behind it?
 * Evaluated once, from one production.json sample taken at pairing. The result only presets the "Ignore production
 * meter" device setting, which the user can always change. Inconclusive samples (night, shade, no meter reading)
 * return false.
 * @param {number|null} meterWatts - Raw production meter (eim) reading
 * @param {number|null} inverterWatts - Raw inverter total
 * @returns {boolean}
 */
function isProductionMeterUnwired(meterWatts, inverterWatts) {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!finite(meterWatts) || !finite(inverterWatts)) return false;
  if (inverterWatts < UNWIRED_METER_MIN_INVERTER_W) return false;
  const meter = Math.abs(meterWatts);
  return meter < UNWIRED_METER_MAX_W && meter < inverterWatts * UNWIRED_METER_MAX_RATIO;
}

module.exports = {
  calculateMedian,
  calculateTrapezoidalEnergy,
  isProductionMeterUnwired,
};
