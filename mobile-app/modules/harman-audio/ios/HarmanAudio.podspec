require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'HarmanAudio'
  s.version        = package['version'] || '0.1.0'
  s.summary        = 'Full-duplex mic capture with hardware echo cancellation (voiceProcessingIO) for barge-in.'
  s.description    = 'Captures echo-cancelled microphone PCM via AVAudioEngine + the voiceProcessingIO audio unit, so the app can listen for the "Harman" wake word WHILE TTS is playing, without the mic self-triggering on the assistant\'s own voice.'
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
