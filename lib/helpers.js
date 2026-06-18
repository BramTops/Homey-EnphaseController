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

module.exports = {
  calculateMedian,
  calculateTrapezoidalEnergy,
};
