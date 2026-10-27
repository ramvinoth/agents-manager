# Nemotron audio service

`voicechat_service.py` wraps the **installed llama-voicechat.cpp fork**, not NVIDIA's
container realtime API. It accepts complete utterances, not duplex PCM streaming.
The model process owns conversation history for one WebSocket's lifetime; closing
the socket destroys it and releases its GPU allocation. Idle HTTP availability
is not model readiness. There is no STT → text-provider → TTS fallback.

## Configuration

Run in its own virtual environment with FastAPI, Uvicorn and a WebSocket backend.
The initial verified environment uses FastAPI 0.141.1, Uvicorn 0.52.0 and
websockets 15.0.1. Do not install into another speech service's environment.
`harman-voicechat.service` expects the venv and script under `~/harman-voicechat/`.
Its `service.env` must define:

- `VOICECHAT_ROOT`: existing experiment directory containing `models/` and
  `llama-voicechat.cpp/build/bin/llama-voicechat`.
- `VOICECHAT_GPU`: explicit GPU UUID. This is passed as `CUDA_VISIBLE_DEVICES`;
  the model sees only that GPU, as CUDA0.
- `VOICECHAT_TOKEN_FILE`: private file containing a random token, at least 32
  characters. Never pass it to a phone or expose it in command arguments/logs.
- `VOICECHAT_HOST`: bind address, preferably the host's tailnet address.
- `VOICECHAT_PORT`: optional, defaults to 8098.

The service requires these installed GGUF files under `models/`:

- `nemotron_voicechat_11b-stt-llm-Q4_0.gguf`
- `mmproj-voicechat-perception-Q4_0.gguf`
- `voicechat-tts-Q4_0.gguf`
- `nemotron_voicechat_11b-stt-llm-Q4_0-function-head.gguf`

It never downloads weights. The initially verified fork revision is
`f45001fc3d8013c72beb6753d3eb0b976b6a9fff`; changing that runtime requires repeating
protocol and real-audio verification. Repository:
https://github.com/sansamour/llama-voicechat.cpp/tree/voicechat/tools/voicechat

## Wire contract

Both endpoints require `Authorization: Bearer <service-token>`.

- `GET /health`: backend/model/runtime identity, transport `wav-turns-v1`,
  installed/ready/busy state, input/output formats and capability flags.
  `ready=false, busy=false, installed=true` means the wrapper is available but no
  call has loaded a model. It does not indicate a failed model or a readiness
  guarantee for the next call.
- `WS /call`: one call at a time. Wait for JSON `kind=ready` before sending audio.
  Each binary input is a complete mono PCM16 16 kHz WAV, at most 30 seconds.
  JSON events use the fork's `kind` field. A binary mono PCM16 22050 Hz WAV is
  sent before its `turn_end` event containing the generated assistant transcript.
  This is **not** a transcript of the user's utterance. File paths are removed.
  Close the socket or send `{"cmd":"close"}` to end the call.

The service reports `tools=false` and `duplex=false`. Model tool requests fail
closed; no worker actions are executed or reported as started. Tool delegation
is an outstanding integration gate, not a supported capability.

## Bounds and operation

One Uvicorn worker is mandatory: the GPU-slot guard is process-local. A second
call receives an error and close code 1013; it is not queued. Admission requires
14,000 MiB free on the configured GPU. This is a conservative service policy,
not an exact model requirement. Startup is bounded to 90 seconds, each turn and
idle interval to 120 seconds, and a socket to 900 seconds. The model's timeline
is capped at 180 seconds including generated content; exhaustion is an error,
not a silent reset that loses conversation history.

Input frames, receive queues, output WAV size and process log buffering are
bounded. Input/output recordings live in a private temporary directory and are
deleted after each turn or on disconnect/error. Cancellation terminates the
model, escalating to kill after five seconds. Existing GPU services are never
stopped to make room.

Service creation/start, shared infrastructure changes, production viewer
configuration/restart and TestFlight publishing have separate authorization
boundaries. To roll back this new service, stop only `harman-voicechat.service`;
leave existing speech/model services untouched. The initial deployment was
started, not enabled at boot.

## Verification

Run hermetic format/protocol tests from the repository root:

```sh
python3 -m unittest discover -s tests/unit -p test_voicechat_service.py -v
```

Before client rollout, also verify authenticated real audio on the deployed
runtime: two turns, nonempty transcript and decodable non-silent output, second
caller rejection, disconnect during loading/inference, invalid input, subsequent
call recovery, and return to baseline GPU memory. These prove transport/model
execution, not microphone operation or perceived voice quality on an iPhone.
Record exact tested revisions, commands and terminal outcomes on the call board
card. Native exact-build verification is still required before asking for user
validation. Never equate HTTP 200, a model label or a passing compiler with
end-to-end call audio.
