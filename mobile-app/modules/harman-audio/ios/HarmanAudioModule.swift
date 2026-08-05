import ExpoModulesCore
import AVFoundation

/**
 * HarmanAudioModule — full-duplex, echo-cancelled mic capture for barge-in.
 *
 * The problem this solves: in call mode we want to hear the user say "Harman …"
 * WHILE the assistant (TTS) is speaking. A naive open mic hears the assistant's own
 * voice and self-triggers. iOS's `voiceProcessingIO` audio unit does hardware
 * acoustic echo cancellation (AEC) — the same path FaceTime uses — so the mic
 * signal has the assistant's playback removed. expo-av/WebRTC don't expose this
 * with raw PCM access, so we tap `AVAudioEngine`'s input node directly.
 *
 * Contract:
 *   - start(sampleRate): enable voice processing, install an input tap, begin
 *     emitting "onFrame" events carrying base64 16-bit PCM mono at `sampleRate`.
 *   - stop(): remove the tap and stop the engine.
 * We do NOT call AVAudioSession.setActive(true) — CallKit owns activation (see
 * callManager.ts didActivateAudioSession → audioSession.adoptActiveSession); we
 * only set the category to playAndRecord + voiceChat and start the engine, so we
 * cooperate with, rather than fight, the call's session.
 */
public class HarmanAudioModule: Module {
  private let engine = AVAudioEngine()
  private var converter: AVAudioConverter?
  private var targetFormat: AVAudioFormat?
  private var running = false

  public func definition() -> ModuleDefinition {
    Name("HarmanAudio")

    Events("onFrame", "onError")

    AsyncFunction("start") { (sampleRate: Double) in
      try self.start(sampleRate: sampleRate)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    Function("isRunning") { () -> Bool in
      return self.running
    }

    OnDestroy {
      self.stop()
    }
  }

  private func start(sampleRate: Double) throws {
    if running { return }

    let session = AVAudioSession.sharedInstance()
    // Cooperate with CallKit's session: playAndRecord + voiceChat mode enables the
    // system voice-processing (AEC/AGC/NS) path. Do NOT setActive — CallKit did.
    try session.setCategory(.playAndRecord,
                            mode: .voiceChat,
                            options: [.allowBluetooth, .defaultToSpeaker])

    let input = engine.inputNode
    // Turn ON hardware echo cancellation on the I/O unit. This is the whole point.
    try input.setVoiceProcessingEnabled(true)

    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0 else {
      throw Exception(name: "HarmanAudio", description: "input format unavailable")
    }

    // The server STT wants 16 kHz mono PCM16. Build a converter from the hardware
    // format (usually 48 kHz float) to that.
    guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                        sampleRate: sampleRate,
                                        channels: 1,
                                        interleaved: true) else {
      throw Exception(name: "HarmanAudio", description: "cannot build output format")
    }
    self.targetFormat = outFormat
    self.converter = AVAudioConverter(from: inFormat, to: outFormat)

    input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
      self?.handle(buffer: buffer)
    }

    engine.prepare()
    try engine.start()
    running = true
  }

  private func handle(buffer: AVAudioPCMBuffer) {
    guard let converter = self.converter, let outFormat = self.targetFormat else { return }
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }

    var fed = false
    let status = converter.convert(to: outBuf, error: nil) { _, inStatus in
      if fed {
        inStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      inStatus.pointee = .haveData
      return buffer
    }
    if status == .error || outBuf.frameLength == 0 { return }

    guard let ch = outBuf.int16ChannelData else { return }
    let byteCount = Int(outBuf.frameLength) * MemoryLayout<Int16>.size
    let data = Data(bytes: ch[0], count: byteCount)
    // Ship base64 PCM up to JS; duplexMic.ts batches into windows for the WS.
    sendEvent("onFrame", [
      "pcm": data.base64EncodedString(),
      "sampleRate": outFormat.sampleRate,
      "frames": Int(outBuf.frameLength),
    ])
  }

  private func stop() {
    guard running else { return }
    running = false
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    try? engine.inputNode.setVoiceProcessingEnabled(false)
    converter = nil
    targetFormat = nil
  }
}
