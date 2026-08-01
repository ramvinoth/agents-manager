// Shared WebdriverIO config. Platform configs (wdio.android.conf.js /
// wdio.ios.conf.js) spread this and add capabilities. The Appium server is
// started/stopped automatically by @wdio/appium-service.
exports.shared = {
  runner: "local",
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  logLevel: "info",
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120000 },

  // Our config + specs are plain CommonJS .js — do NOT let WDIO register
  // ts-node's ESM loader (it's broken on Node 20 and crashes the run).
  autoCompileOpts: { autoCompile: false },

  // Connect to an Appium 2 server started externally (see run_e2e2.sh). Starting
  // Appium out-of-band is more reliable than @wdio/appium-service when Appium is
  // a local (non-global) dependency. Appium 2 serves on base path "/".
  hostname: "127.0.0.1",
  port: 4723,
  path: "/",
}
