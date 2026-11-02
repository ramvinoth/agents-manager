/**
 * withAndroidUploadSigning — sign release builds (bundleRelease / assembleRelease)
 * with the Play upload key instead of the template's debug key.
 *
 * The key and its passwords never live in the repo. Gradle reads four project
 * properties, from ~/.gradle/gradle.properties, -P flags, or the environment as
 * ORG_GRADLE_PROJECT_<NAME>:
 *   AGENTS_UPLOAD_STORE_FILE      absolute path to the upload keystore
 *   AGENTS_UPLOAD_STORE_PASSWORD
 *   AGENTS_UPLOAD_KEY_ALIAS
 *   AGENTS_UPLOAD_KEY_PASSWORD
 *
 * Without them a release build fails at validateSigningRelease ("missing
 * required property storeFile"). It never falls back to the debug key, so a
 * debug-signed bundle can't reach Play by accident. Debug builds are unchanged.
 */
const { withAppBuildGradle } = require("expo/config-plugins")

const RELEASE_SIGNING = `
        release {
            def uploadStore = findProperty('AGENTS_UPLOAD_STORE_FILE')
            if (uploadStore) {
                storeFile file(uploadStore)
                storePassword findProperty('AGENTS_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('AGENTS_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('AGENTS_UPLOAD_KEY_PASSWORD')
            }
        }`

// The template's debug signing block, then its release build type that reuses it.
const DEBUG_SIGNING = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/
const RELEASE_USES_DEBUG = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/

function applyUploadSigning(gradle) {
  if (gradle.includes("AGENTS_UPLOAD_STORE_FILE")) return gradle
  if (!DEBUG_SIGNING.test(gradle) || !RELEASE_USES_DEBUG.test(gradle)) {
    // Fail the prebuild rather than ship a release build signed with the debug key.
    throw new Error("withAndroidUploadSigning: app/build.gradle no longer matches the expected template")
  }
  return gradle
    .replace(DEBUG_SIGNING, `$1${RELEASE_SIGNING}`)
    .replace(RELEASE_USES_DEBUG, "$1signingConfig signingConfigs.release")
}

module.exports = function withAndroidUploadSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = applyUploadSigning(config.modResults.contents)
    return config
  })
}
