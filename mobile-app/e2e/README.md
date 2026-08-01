# Mobile app — Appium E2E

End-to-end tests driving the built app on a real device/emulator with
**Appium 2 + WebdriverIO**. Kept in its own package so the app's deps stay clean.

Appium drives a **built app on a device/emulator** — there is no way to run these
without one. iOS additionally requires **macOS + Xcode**.

## Prerequisites

**Android**
- Android SDK + platform-tools (`adb`), a running emulator **or** a USB device.
  - The emulator needs hardware acceleration (`/dev/kvm` on Linux, HAXM/Hypervisor
    on macOS). A headless CI box without KVM generally can't run it.
- Java 17+ (Appium UiAutomator2 driver).

**iOS** (macOS only)
- Xcode + a booted Simulator (or a provisioned device).

## iOS — one command (`run-ios.sh`)

On a Mac with Xcode, this does everything: installs deps + the XCUITest driver,
`expo prebuild` if needed, creates/boots a simulator, builds a Release `.app`,
starts Appium, and runs the suite.

```bash
cd mobile-app/e2e
nvm use 20                                   # Node >= 18 (see notes below)
export E2E_SERVER_URL="https://agents.suhai.ai"
export E2E_USERNAME="<owner account>"        # env only — never commit creds
export E2E_PASSWORD="<password>"
./run-ios.sh                                 # SIM_NAME / IOS_VERSION overridable
```

Verified passing: iPhone 17 / iOS 26.5, Appium 2.19 + WebdriverIO, XCUITest.

## Android (manual)

```bash
cd mobile-app/e2e && npm install && npm run drivers
# build an APK from mobile-app/:  npx expo run:android   (or eas build --local)
export APP_PATH=/abs/path/to/app-debug.apk
export E2E_SERVER_URL="http://10.0.2.2:8091"  # host loopback from an Android emulator
export E2E_USERNAME=... E2E_PASSWORD=...
npm run android                               # UiAutomator2
```

## What the smoke test covers

`specs/login.e2e.js`: launch → enter server URL → **Connect** → sign in →
assert the **Hosts** list renders. Selectors use the `testID`/`accessibilityLabel`
ids on the screens: `server-url`, `server-connect`, `login-username`,
`login-password`, `login-submit`, `hosts-list`, `host-local`.

## iOS environment notes (gotchas we hit)

`run-ios.sh` handles all of these; they're documented so failures are diagnosable:

- **Node ≥ 18, and *first* on PATH.** Appium 2 rejects Node 17. With nvm, `nvm use 20`
  — and make sure a system `/usr/local/bin/node` 17 isn't ahead of it on PATH, or
  Appium and the RN build phase pick up the wrong node.
- **`xcodebuild -downloadPlatform iOS`.** After an Xcode upgrade, the matching iOS
  *simulator runtime* may be missing → xcodebuild reports *"iOS X is not installed"*
  / *"no destinations for the scheme"* even though the SDK is present. Run that once
  (it's a multi-GB download) to install the runtime.
- **ts-node crashes WDIO on Node ≥ 20.** WDIO force-registers `ts-node/esm`, which
  fails with *"did not call the next hook in its chain."* Our config/specs are plain
  JS, so the script disables `ts-node` in `node_modules`. (`npm install` restores it;
  re-running the script re-disables it.)
- **Start Appium out-of-band.** `@wdio/appium-service` is unreliable when Appium is a
  local (non-global) dependency; the script starts `appium` itself and points WDIO at
  `127.0.0.1:4723` (`wdio.shared.conf.js`).
- **`NODE_BINARY`.** The script writes `ios/.xcode.env.local` so Xcode's RN bundling
  phase uses the same Node, not a stray system one.
