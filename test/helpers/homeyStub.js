/* eslint-disable max-classes-per-file */

'use strict';

// Minimal stand-in for the `homey` module, which only exists inside the Homey runtime. It supplies just the base
// classes that app.js and the device classes extend, so their plain methods can be called on a fake `this`.
// No SDK behavior is simulated: anything beyond class declaration is the test's own fake.

const Module = require('module');

class Base {}

const stub = {
  App: class App extends Base {},
  Device: class Device extends Base {},
  Driver: class Driver extends Base {},
};

if (!Module.__homeyStubInstalled) {
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'homey') return stub;
    return originalLoad.call(this, request, ...rest);
  };
  Module.__homeyStubInstalled = true;
}

module.exports = stub;
