'use strict';

/**
 * Enphase account credentials as seen by a device's settings form.
 * Pairing stores the account in the app settings (`user_email` / `password`), not on the device, so a device's
 * credential settings may be empty: an empty field means "keep using the saved account". Saving any other setting
 * must therefore never need the credentials again (before 2.0.6 the form marked them required, and whatever was
 * typed or autofilled into them was sent to Enphase on every save). Values are trimmed like the pairing views do.
 */

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sameEmail(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The account saved by the last successful pairing, repair or credential change. */
function savedAccount(homey) {
  return {
    email: clean(homey.settings.get('user_email')),
    password: clean(homey.settings.get('password')),
  };
}

/**
 * Credentials a settings object stands for: its own values, with the saved account filling empty fields.
 * The saved password only fills in for the saved account's email, never for a different account.
 * @param {Object} homey
 * @param {Object} [settings] - Device settings
 * @returns {{userEmail: string, password: string}} Empty strings where nothing is known
 */
function resolveCredentials(homey, settings = {}) {
  const saved = savedAccount(homey);
  const email = clean(settings.user_email);
  const password = clean(settings.password);
  if (!email) return { userEmail: saved.email, password: password || saved.password };
  if (password) return { userEmail: email, password };
  return { userEmail: email, password: sameEmail(email, saved.email) ? saved.password : '' };
}

/**
 * Decide whether a settings change needs a fresh cloud login, and with which credentials.
 * A login runs when the gateway (serial or IP) changed, or when the user entered a password or switched to another
 * account. Clearing a credential field, or re-entering the email already in use, keeps the current login.
 * @param {Object} homey
 * @param {Object} oldSettings - Settings before the change
 * @param {Object} newSettings - The full new settings
 * @param {string[]} changedKeys
 * @returns {{login: boolean, entered: boolean, missingPassword: boolean, userEmail: string, password: string}}
 *   `entered`: the credentials come from the form (save them as the account on success);
 *   `missingPassword`: a login is needed, but no password is known for the (new) account
 */
function planCredentialChange(homey, oldSettings, newSettings, changedKeys) {
  const resolved = resolveCredentials(homey, newSettings);
  const current = resolveCredentials(homey, oldSettings);

  const passwordEntered = changedKeys.includes('password') && !!clean(newSettings.password);
  const newEmail = clean(newSettings.user_email);
  const accountSwitched = changedKeys.includes('user_email') && !!newEmail && !sameEmail(newEmail, current.userEmail);
  const gatewayChanged = changedKeys.includes('envoy_serial') || changedKeys.includes('envoy_ip');

  const entered = passwordEntered || accountSwitched;
  const login = entered || gatewayChanged;
  return {
    login,
    entered,
    missingPassword: login && (!resolved.userEmail || !resolved.password),
    userEmail: resolved.userEmail,
    password: resolved.password,
  };
}

/**
 * Show the account in use on a device that has no email setting yet (paired devices never stored it). Only the
 * email: the password stays in the app settings, and its empty field means "keep using the saved password".
 * device.setSettings() does not trigger onSettings, so this never causes a login. Never throws.
 * @param {Object} device - Homey device with `user_email` setting
 */
async function fillAccountEmail(device) {
  try {
    if (clean(device.getSetting('user_email'))) return;
    const { email } = savedAccount(device.homey);
    if (!email) return;
    await device.setSettings({ user_email: email });
    device.log('Account email setting filled in from the saved account.');
  } catch (err) {
    device.error('Failed to fill in the account email setting:', err.message);
  }
}

/** Remember credentials that were just accepted by Enphase as the saved account. */
async function saveAccount(homey, userEmail, password) {
  await homey.settings.set('user_email', clean(userEmail));
  await homey.settings.set('password', clean(password));
}

module.exports = {
  clean,
  resolveCredentials,
  planCredentialChange,
  fillAccountEmail,
  saveAccount,
};
