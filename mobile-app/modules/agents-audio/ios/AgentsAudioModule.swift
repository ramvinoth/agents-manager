import ExpoModulesCore
import AVFoundation

/**
 * AgentsAudioModule — full-duplex, echo-cancelled mic capture for barge-in.
 *
 * The problem this solves: in call mode we want to hear the user say "Manager …"
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
public class AgentsAudioModule: Module {
  private let engine = AVAudioEngine()
  private var converter: AVAudioConverter?
  private var targetFormat: AVAudioFormat?
  private var running = false
  // Streaming playback shares the capture engine, so the voice-processing unit
  // sees exactly what is played and cancels it from the mic (echo-free barge-in).
  private let player = AVAudioPlayerNode()
  private var playbackFormat: AVAudioFormat?
  private var pending = 0            // scheduled buffers not yet played out
  private var generation = 0         // bumped by flush so stale completions are ignored
  private let pendingLock = NSLock()
  private var configObserver: NSObjectProtocol?
  private static let playbackRate = 24000.0   // matches the server's TTS rate (fishcall.VOICE_RATE)

  public func definition() -> ModuleDefinition {
    Name("AgentsAudio")

    Events("onFrame", "onError", "onDrained")

    // Queue base64 PCM16 mono at `sampleRate` for playback. Needs start() first.
    Function("enqueue") { (pcm: String, sampleRate: Double) -> Bool in
      return self.enqueue(base64: pcm, sampleRate: sampleRate)
    }

    // Drop everything queued and silence the speaker now (barge-in).
    Function("flushPlayback") {
      self.flushPlayback()
    }

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

    // The server STT wants 16 kHz mono PCM16.
    guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                        sampleRate: sampleRate,
                                        channels: 1,
                                        interleaved: true) else {
      throw Exception(name: "AgentsAudio", description: "cannot build output format")
    }
    self.targetFormat = outFormat
    try installCapture()

    // Fix the playback format BEFORE the engine starts. Reconnecting the player to a new
    // format on the first enqueue, while the voice-processing engine runs, drops the first
    // utterance (silence) and garbles the next (white noise).
    guard let pf = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: HarmanAudioModule.playbackRate,
                                 channels: 1, interleaved: false) else {
      throw Exception(name: "HarmanAudio", description: "cannot build playback format")
    }
    playbackFormat = pf
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: pf)
    engine.prepare()
    try engine.start()
    player.play()
    running = true
    // CallKit activates the audio session AFTER we start on the first call. iOS answers that
    // route/format change by stopping the engine (and the player with it), which silences
    // playback and the mic until something restarts it.
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in self?.recoverEngine() }
  }

  /// (Re)build the capture tap from the input node's CURRENT hardware format. The format
  /// read before CallKit activates the session can differ from the one after it, and a tap
  /// or converter built from the stale one delivers nothing usable (the first utterance).
  private func installCapture() throws {
    let input = engine.inputNode
    let inFormat = input.inputFormat(forBus: 0)
    guard inFormat.sampleRate > 0, let outFormat = targetFormat else {
      throw Exception(name: "HarmanAudio", description: "input format unavailable")
    }
    input.removeTap(onBus: 0)
    converter = AVAudioConverter(from: inFormat, to: outFormat)
    input.installTap(onBus: 0, bufferSize: 2048, format: inFormat) { [weak self] buffer, _ in
      self?.handle(buffer: buffer)
    }
  }

  private func recoverEngine() {
    guard running else { return }
    do {
      try installCapture()
      if !engine.isRunning {
        engine.prepare()
        try engine.start()
      }
      player.play()
    } catch {
      sendEvent("onError", ["message": "audio engine restart failed: \(error.localizedDescription)"])
    }
  }

  private func enqueue(base64: String, sampleRate: Double) -> Bool {
    guard running, let data = Data(base64Encoded: base64), data.count >= 2 else { return false }
    if playbackFormat?.sampleRate != sampleRate {
      guard let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                  channels: 1, interleaved: false) else { return false }
      playbackFormat = f
      engine.disconnectNodeOutput(player)
      engine.connect(player, to: engine.mainMixerNode, format: f)
    }
    guard let fmt = playbackFormat else { return false }
    let frames = AVAudioFrameCount(data.count / 2)
    guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames),
          let out = buf.floatChannelData?[0] else { return false }
    buf.frameLength = frames
    data.withUnsafeBytes { raw in
      let src = raw.bindMemory(to: Int16.self)
      for i in 0..<Int(frames) { out[i] = Float(Int16(littleEndian: src[i])) / 32768.0 }
    }
    pendingLock.lock(); pending += 1; let gen = generation; pendingLock.unlock()
    player.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.bufferDone(generation: gen)
    }
    return true
  }

  private func bufferDone(generation gen: Int) {
    pendingLock.lock()
    if gen != generation { pendingLock.unlock(); return }
    pending = max(0, pending - 1)
    let drained = pending == 0
    pendingLock.unlock()
    if drained { sendEvent("onDrained", [:]) }
  }

  private func flushPlayback() {
    guard running else { return }
    pendingLock.lock(); pending = 0; generation += 1; pendingLock.unlock()
    player.stop()        // completion handlers fire for dropped buffers; the generation bump makes them no-ops
    player.play()
  }

  private func handle(buffer: AVAudioPCMBuffer) {
    guard let outFormat = self.targetFormat else { return }
    // Hardware format can change between taps (route change): never convert with a stale one.
    if converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: outFormat)
    }
    guard let converter = self.converter else { return }
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
    if status == .error {
      sendEvent("onError", ["message": "capture convert failed: status=\(status.rawValue) in=\(buffer.format.sampleRate)Hz/\(buffer.format.channelCount)ch"])
      return
    }
    if outBuf.frameLength == 0 { return }

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
    if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
    pendingLock.lock(); pending = 0; generation += 1; pendingLock.unlock()
    player.stop()
    engine.detach(player)
    playbackFormat = nil
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    try? engine.inputNode.setVoiceProcessingEnabled(false)
    converter = nil
    targetFormat = nil
  }
}
