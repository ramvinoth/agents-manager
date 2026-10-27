const { shared } = require("./wdio.shared.conf")

// APP_PATH = absolute path to the built debug/release .apk (see e2e/README.md).
exports.config = {
  ...shared,
  // thread-board is deliberately iOS-only (native-stack/WDA gesture coverage).
  exclude: ["./specs/thread-board.e2e.js"],
  capabilities: [
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": process.env.E2E_DEVICE || "Android Emulator",
      "appium:app": process.env.APP_PATH,
      "appium:appWaitActivity": "*",
      "appium:autoGrantPermissions": true,
      "appium:newCommandTimeout": 240,
    },
  ],
}
