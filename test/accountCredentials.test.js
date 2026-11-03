'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCredentials, planCredentialChange, fillAccountEmail, saveAccount,
} = require('../lib/accountCredentials');

const SAVED = { user_email: 'owner@example.com', password: 'secret' };

function fakeHomey(values = SAVED) {
  const store = { ...values };
  return {
    store,
    settings: {
      get: (key) => store[key],
      set: async (key, value) => {
        store[key] = value;
      },
    },
  };
}

// Settings of a device paired the normal way: pairing never stored the account on the device.
const PAIRED = {
  envoy_serial: '122222033350', envoy_ip: '10.0.0.5', user_email: '', password: '',
};

test.describe('resolveCredentials', () => {
  test('empty device fields use the saved account', () => {
    assert.deepEqual(resolveCredentials(fakeHomey(), PAIRED), { userEmail: 'owner@example.com', password: 'secret' });
  });

  test('the saved password fills in for the saved email only (case-insensitive)', () => {
    const homey = fakeHomey();
    assert.equal(resolveCredentials(homey, { user_email: 'Owner@Example.com ' }).password, 'secret');
    assert.equal(resolveCredentials(homey, { user_email: 'other@example.com' }).password, '');
  });

  test('device values are trimmed', () => {
    assert.deepEqual(
      resolveCredentials(fakeHomey(), { user_email: ' a@b.c ', password: ' pw ' }),
      { userEmail: 'a@b.c', password: 'pw' },
    );
  });
});

test.describe('planCredentialChange', () => {
  test('saving another setting next to the filled-in email needs no login', () => {
    const old = { ...PAIRED, user_email: 'owner@example.com' };
    const plan = planCredentialChange(fakeHomey(), old, { ...old, phase_capabilities: true }, ['phase_capabilities']);
    assert.equal(plan.login, false);
    assert.equal(plan.missingPassword, false);
  });

  test('re-entering the email already in use needs no login', () => {
    const plan = planCredentialChange(
      fakeHomey(), PAIRED, { ...PAIRED, user_email: 'owner@example.com ', phase_capabilities: true },
      ['user_email', 'phase_capabilities'],
    );
    assert.equal(plan.login, false);
  });

  test('clearing the credential fields keeps the saved account without a login', () => {
    const old = { ...PAIRED, user_email: 'owner@example.com', password: 'secret' };
    const plan = planCredentialChange(fakeHomey(), old, { ...old, user_email: '', password: '' }, ['user_email', 'password']);
    assert.equal(plan.login, false);
  });

  test('a typed password triggers a login with the trimmed values', () => {
    const plan = planCredentialChange(fakeHomey(), PAIRED, { ...PAIRED, password: 'new-secret ' }, ['password']);
    assert.equal(plan.login, true);
    assert.equal(plan.entered, true);
    assert.deepEqual([plan.userEmail, plan.password], ['owner@example.com', 'new-secret']);
  });

  test('switching account without its password is refused', () => {
    const plan = planCredentialChange(fakeHomey(), PAIRED, { ...PAIRED, user_email: 'other@example.com' }, ['user_email']);
    assert.equal(plan.login, true);
    assert.equal(plan.missingPassword, true);
  });

  test('switching account with its password logs in with that account', () => {
    const plan = planCredentialChange(
      fakeHomey(), PAIRED, { ...PAIRED, user_email: 'other@example.com', password: 'pw2' }, ['user_email', 'password'],
    );
    assert.equal(plan.missingPassword, false);
    assert.deepEqual([plan.userEmail, plan.password], ['other@example.com', 'pw2']);
  });

  test('a new gateway IP logs in with the saved account, without saving it again', () => {
    const plan = planCredentialChange(fakeHomey(), PAIRED, { ...PAIRED, envoy_ip: '10.0.0.6' }, ['envoy_ip']);
    assert.equal(plan.login, true);
    assert.equal(plan.entered, false);
    assert.deepEqual([plan.userEmail, plan.password], ['owner@example.com', 'secret']);
  });

  test('a new gateway without any known account is refused', () => {
    const plan = planCredentialChange(fakeHomey({}), PAIRED, { ...PAIRED, envoy_ip: '10.0.0.6' }, ['envoy_ip']);
    assert.equal(plan.missingPassword, true);
  });
});

test.describe('fillAccountEmail', () => {
  function fakeDevice(settings, homey = fakeHomey()) {
    const calls = [];
    return {
      calls,
      homey,
      getSetting: (key) => settings[key],
      setSettings: async (values) => {
        calls.push(values);
      },
      log: () => {},
      error: () => {},
    };
  }

  test('fills an empty email from the saved account, never the password', async () => {
    const device = fakeDevice(PAIRED);
    await fillAccountEmail(device);
    assert.deepEqual(device.calls, [{ user_email: 'owner@example.com' }]);
  });

  test('keeps an email that is already set', async () => {
    const device = fakeDevice({ ...PAIRED, user_email: 'mine@example.com' });
    await fillAccountEmail(device);
    assert.deepEqual(device.calls, []);
  });

  test('does nothing without a saved account and never throws', async () => {
    const device = fakeDevice(PAIRED, fakeHomey({}));
    await fillAccountEmail(device);
    assert.deepEqual(device.calls, []);

    const failing = fakeDevice(PAIRED);
    failing.setSettings = async () => {
      throw new Error('boom');
    };
    await fillAccountEmail(failing);
  });
});

test('saveAccount stores trimmed credentials', async () => {
  const homey = fakeHomey({});
  await saveAccount(homey, ' a@b.c ', ' pw ');
  assert.deepEqual(homey.store, { user_email: 'a@b.c', password: 'pw' });
});
