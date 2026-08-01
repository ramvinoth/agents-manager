const { shared } = require("./wdio.shared.conf")

// APP_PATH = absolute path to the built .app (simulator) or signed .ipa (device).
// iOS requires macOS + Xcode. See e2e/README.md.
const caps = {
  platformName: "iOS",
  "appium:automationName": "XCUITest",
  "appium:deviceName": process.env.E2E_DEVICE || "iPhone 15",
  "appium:platformVersion": process.env.E2E_IOS_VERSION || "17.5",
  "appium:app": process.env.APP_PATH,
  "appium:newCommandTimeout": 240,
}
// Pin the exact booted simulator when the runner provides its UDID.
if (process.env.E2E_UDID) caps["appium:udid"] = process.env.E2E_UDID

exports.config = {
  ...shared,
  capabilities: [caps],
}
