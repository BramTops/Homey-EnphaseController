# ADR 3: Hourly Auto-Enable Cloud Discrepancy Handling

## Status
Accepted

## Date
2026-05-26

## Context
When a user manually disables power production in Homey (e.g. to avoid negative energy prices or limit exports), Homey calls the local Envoy API `/ivp/mod/603980032/mode/power` with `powerForcedOff: true`. This successfully ceases PV production.

However, Enphase Envoy gateways synchronize their local settings with the Enphase Enlighten Cloud on a scheduled basis—specifically at the top of every hour (HH:00). During this synchronization, the cloud settings (which default to production enabled) are pushed to the physical gateway. This overrides the local state, resetting `powerForcedOff` back to `false` and causing power production to automatically resume without user consent or notification.

## Decision
We decided to implement a state discrepancy resolution pattern inside the Envoy driver's polling loop (`drivers/envoy/device.js`):
1. **Desired State Tracking:** Homey maintains the user's desired state via the standard `onoff` capability value (`true` = production enabled / normal, `false` = production disabled / forced off).
2. **Periodic Physical Polling:** Every 60 seconds, the driver polls the local Envoy for the current physical status (`powerForcedOff`) and active production metrics.
3. **Discrepancy Detection:** If Homey's target state is `false` (user intends production to be OFF) but the Envoy returns `powerForcedOff === false` (indicating the physical device has been re-enabled), the driver detects a state conflict.
4. **Enforced Re-application:** Upon detecting this conflict, the driver logs the discrepancy and automatically re-sends the `setPowerForcedOff(true)` write command to the Envoy. This immediately forces the production back off, overriding the cloud sync override.
5. **State Lock:** During this reconciliation, the Homey interface maintains the `onoff` value as `false` to present a consistent, flicker-free interface to the user.

```javascript
// Discrepancy detection in pollStatus()
const currentOnoffValue = this.getCapabilityValue('onoff');

if (currentOnoffValue === false && productionEnabled === true) {
  this.log('Discrepancy detected: Homey is OFF, but Envoy is ON (production enabled). The Envoy likely reset itself during its hourly cloud sync. Re-applying the OFF command to enforce the user\'s setting.');
  try {
    await this.api.setPowerForcedOff(true);
    productionEnabled = false; // Override status to remain OFF in Homey UI
  } catch (err) {
    this.error('Failed to re-apply power production control command:', err.message);
  }
}
```

## Consequences
* **Pros:**
  * Ensures that manual production shutoffs are strictly respected and maintained over long periods, regardless of hourly Enphase cloud syncs.
  * Extremely robust; resolves a deep firmware/cloud interaction bug without requiring complex developer partnership contracts or cloud webhooks.
  * Retains a simple and intuitive user experience where the switch state matches actual behavior.
* **Cons:**
  * Introduces a potential brief window (up to 60 seconds, depending on the poll timer alignment) at the beginning of the hour where power production might briefly resume before being forced off again. *Note: Setting a shorter poll interval would decrease this window but increase local network load and Envoy CPU utilization.*
