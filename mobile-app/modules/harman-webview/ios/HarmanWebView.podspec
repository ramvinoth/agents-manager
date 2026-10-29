require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HarmanWebView'
  s.version        = package['version'] || '0.1.0'
  s.summary        = 'A WKWebView whose harman:// requests the app answers.'
  s.description    = 'Loads a page from harman://app and hands every request it makes to JavaScript, so the page reaches the server over whichever route the app uses (direct or the E2EE relay).'
  s.author         = 'Harman'
  s.homepage       = 'https://agents.suhai.ai'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
