# Changelog

<!--
Store rules, for this file and .homeychangelog.json (JSON cannot hold comments, so they are kept here):
- Non-technical and outcome-focused: no jargon, variables or config details.
- 3-6 words per line.
- .homeychangelog.json: no "- " prefixes, items separated by " \n", both `en` and `nl`.
-->

All notable changes to the Enphase Controller application for Homey Pro will be documented in this file, grouped by work session (day) and described in a user-centric way.

## 2.0.0 (2026-10-07)

- Adds read-only battery monitoring.
- Shows grid and home readings.
- Adds animated energy flow widget.
- Requires a new device for widget.
- Remove old solar before pairing.
- Rebuild Flows; history may be lost.
- Avoid duplicate grid energy totals.

## 2026-10-06

- Restores legacy Envoy device driver.
- Adds warning for deprecated driver.

## 2026-08-15

- Adds an "Always on" setting.
- Removes unused legacy Envoy device driver.

## 2026-06-27

- Fixes production limit errors.
- Improves meter detection.

## 2026-06-25

- Tests production limiting support.
- Falls back to standard control.
- Fixes rapid control changes.

## 2026-06-23

- Adds solar production limiting.
- Enables net export limits.

## 2026-06-18

- More consistent device naming and setting grouping.

## 2026-06-17

- Adds home electricity usage monitoring.
- Tracks grid imports and exports.
- Improves pairing wizard dark mode.

## 2026-06-12

- Improved authentication stability.

## 2026-06-09

- Improved login troubleshooting.

## 2026-06-07

- Monitors individual solar microinverters.
- Detects underperforming solar panels.
- Alerts when panels offline.
- Finds gateway IP automatically.
- Simpler and faster pairing.

## 2026-06-03

- Replaces default icons.

## 2026-06-01

- Prevents negative night-time solar readings.

## 2026-05-29

- Adds "Energy today" (kWh) status metric.
- More reliable pairing process.
- Improved compatibility with other Enphase apps.
- Improved gateway connection stability.
- Reduced memory and cpu usage.

## 2026-05-28

- Updates app store listing.
- Improved compatibility with other Enphase apps.
- Clearer pairing instructions.
- More readable status metrics.
- Adds metered gateway status.
- More reliable connection checks.
- Easier connection via manual IP.
- Supports IPv6 networks.
- Support for all account types.

## 2026-05-27

- Initial app release.
