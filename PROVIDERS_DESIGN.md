# Design: Typed model-provider registry (LLM / STT / TTS) — no hardcoded providers

Status: DESIGN ONLY — no code yet. For review.
Supersedes the LLM-only `providers.py`. Generalizes it into a typed registry that
the settings UI manages and chat/voice sessions pick from. Nothing is hardcoded;
common providers ship as *seed presets*, not as code branches.

## 0. The ask (from Ram)

1. Don't hardcode providers. A **typed model-provider registry** — each entry has a
   TYPE: `llm` | `stt` | `tts`.
2. Managed (add / delete / modify) on the **main profile/settings page**. Chat
   sessions only pick from what's configured.
3. Ship a common providers list (OpenAI, Anthropic, Google, Grok, DeepSeek,
   OpenRouter) **as selectable seeds**, plus **Custom endpoint** with a type.
4. If a custom **STT/TTS** endpoint is configured, use it (else fall back to the
   built-in sherpa STT + Pocket TTS on suha-ai).
5. Voice/Call mode in the app wires to the STT + TTS the settings page selects.

## 1. Current state (what we're replacing)

- `viewer/providers.py` — LLM-only presets, Anthropic-compatible endpoints, stored
  in `.viewer-providers.json`. Chat picks one via `SESSION_META.provider`.
- Voice STT/TTS is **hardcoded** to `SPEECH_SERVICE_URL` (:8095 sherpa) /
  `ASSISTANT_SERVICE_URL` (:8099, now dead) in `config.py`, chosen by `?assistant=1`.
- We just consolidated the box: **sherpa STT (:8095) + Pocket TTS (:8097)** are the
  live built-ins; Kokoro TTS (part of speech_service), Qwen-TTS, Step-Audio are gone.

## 2. Provider model (the registry)

One store, entries typed by `kind`. `secret_store`-style backend interface so it can
be a file today and a DB `providers` table in the SaaS wrapper (same split we chose
for secrets). Values (apiKey) are write-only over the API.

    Provider = {
      id, name, kind: "llm"|"stt"|"tts",
      vendor: "openai"|"anthropic"|"google"|"grok"|"deepseek"|"openrouter"|"custom",
      baseUrl, apiKey (write-only), model,
      # type-specific:
      voice?  (tts: e.g. "coral" or a custom voice id),
      wire?   ("openai"|"anthropic"|"sherpa"|"pocket")   # request/response shape
      enabled: bool
    }

**Vendor catalog** (data, NOT code branches, NOT registry entries) — a JSON table
the "Add provider" form reads ONLY to prefill baseUrl/wire/model-list when the user
picks a vendor in the dropdown. It populates NOTHING by itself; the registry stays
empty until the user saves a provider. Deleting this table's rows just removes
autofill hints, never a working provider.

    openai      -> https://api.openai.com/v1   wire=openai
                   llm: gpt-*, stt: gpt-4o-transcribe, tts: gpt-4o-mini-tts (13 voices)
    anthropic   -> https://api.anthropic.com   wire=anthropic   (llm only)
    google      -> https://generativelanguage.googleapis.com/v1beta  wire=openai(compat)
    grok        -> https://api.x.ai/v1         wire=openai
    deepseek    -> https://api.deepseek.com    wire=openai
    openrouter  -> https://openrouter.ai/api/v1 wire=openai
    custom      -> user-entered baseUrl + kind + wire

Adding a new vendor to the dropdown later = a row in the catalog, no code change.
This is the "not hardcoded" property. (A custom endpoint pointing at the sherpa/
pocket box is added the same way — no special-casing.)

## 3. Wire adapters (how a `kind`+`wire` actually calls out)

A small dispatch — the ONLY place that knows protocol details, keyed by `wire`:
- **LLM**: `openai` → /chat/completions (or /responses); `anthropic` → /v1/messages
  (existing path). Providers of wire=openai all share one client.
- **STT**: `openai` → POST /v1/audio/transcriptions (multipart, model gpt-4o-transcribe);
  `sherpa` → POST /transcribe (for a user-added custom endpoint that happens to be
  the sherpa box). [Realtime WS STT = future: gpt-live-transcribe over WS, deferred
  — file STT covers v1.]
- **TTS**: `openai` → POST /v1/audio/speech (json {model,voice,input,response_format:pcm},
  streamable — same AAC-stream contract the app already consumes); `pocket` →
  /synthesize_stream_aac (for a user-added custom endpoint pointing at the Pocket box).

`wire` is just the request/response SHAPE an adapter speaks — sherpa/pocket are
shapes the user's custom endpoint can select, NOT built-in providers. One
`stt_client(provider)` / `tts_client(provider)` picks the adapter by the selected
provider's `wire`. `viewer/voice.py` stops importing hardcoded URLs entirely.

## 4. Selection (NO built-ins, NO fallback)

The registry starts EMPTY. Nothing is seeded, nothing is un-deletable, nothing is
hardcoded. Voice/LLM only work once the user has added and selected providers in
settings. There is NO fallback tail — if a required provider isn't configured, the
feature is simply unavailable (surface a clear "configure a TTS provider in
settings" state, never a silent substitution).

- The settings page selects which provider is used for LLM / STT / TTS (a global
  default per kind, optionally overridden per session).
- sherpa (STT) and Pocket (TTS) on the box are NOT special. They're just custom
  providers the user MAY add (custom endpoint → the box's URL), and MAY delete,
  exactly like an OpenAI provider. The server has zero built-in knowledge of them.

Resolution for a voice/call turn:
1. session-pinned provider for that kind (if set) →
2. global default provider for that kind →
3. none configured → feature unavailable (explicit empty state, no fallback).

LLM selection stays as today (SESSION_META.provider), now reading from the same
registry filtered to kind=llm.

## 5. Server changes

- Rename/extend `providers.py` → typed store: `list(kind=None)`, `get`, `upsert`,
  `delete`, plus `resolve_stt()/resolve_tts()/resolve_llm(session)`. Keep
  `.viewer-providers.json` but migrate old LLM-only records to `{kind:"llm",
  vendor:"custom", wire:"anthropic"}` on load (one-time, non-destructive).
- Routes: extend `/api/providers` to accept/filter `kind`; add `/api/voice/config`
  (get/set default STT+TTS provider ids). Vendor catalog served at
  `/api/providers/vendors` (autofill hints only).
- `viewer/voice.py` + `routes/voice.py`: replace hardcoded SPEECH/ASSISTANT URLs
  with `resolve_stt()/resolve_tts()` → wire adapter. Remove the dead `?assistant=1`
  / ASSISTANT_SERVICE_URL path. If resolve returns none → 409/empty, never a
  hardcoded default.

## 6. Box cleanup (the "remove Kokoro" part)

The box services are just endpoints the user MAY point a custom provider at — the
viewer no longer has built-in knowledge of them. Still worth trimming the box:
- `deploy/speech_service.py` currently does STT + speaker-verify + Kokoro TTS.
  **Remove the Kokoro `/synthesize` route + its model load** so the box's STT
  service is STT+verify only (frees its VRAM). Redeploy + restart harman-speech.
  (Sherpa STT, wake, /segment stay.)
- Pocket (:8097) keeps its `/synthesize_stream_aac`. After this, the box exposes an
  STT endpoint (:8095) and a TTS endpoint (:8097) that a user CAN add as custom
  providers — nothing auto-wires them.

## 7. App + web UI

- **Settings/Profile → "Model Providers"** section: list grouped by kind (LLM / STT
  / TTS), each row name+vendor+enabled. Starts EMPTY with a "No providers — add one"
  state. Add flow: pick vendor (catalog prefills baseUrl/wire) or Custom → enter
  baseUrl + kind + apiKey (write-only) + model/voice → Save. Delete, toggle enabled.
  Mirror the existing provider-editor pattern in SessionProfile.
- **Voice defaults**: two pickers (default STT, default TTS) choosing from configured
  providers of that kind. If none configured → voice features show a "configure a
  provider" prompt, not a working default.
- **Chat session**: LLM picker filters registry to kind=llm (as today).
- **Call + Voice modes** (keep both) hook to the resolved STT + TTS — no more
  George/assistant toggle; the "voice" is whatever TTS provider is selected. If none
  selected, the mode is unavailable until one is configured.

## 8. Phasing

1. Server: typed store + migration + wire adapters (openai STT/TTS + sherpa/pocket
   built-ins) + resolve_*/voice-config routes. Test: configure an OpenAI TTS
   provider via curl, run a voice turn, hear gpt-4o-mini-tts; unset → falls back to
   Pocket. Live via tunnel.
2. Box: strip Kokoro from speech_service, redeploy.
3. App + web: Model Providers settings UI + voice-default pickers → one TestFlight
   build. Call/Voice wired to resolved STT/TTS.
4. (Later) realtime WS STT (gpt-live-transcribe); secrets-manager integration so a
   provider apiKey can reference a stored secret instead of inline.

## 9. Risks / honest notes

- **apiKey handling** = same care as secrets: write-only API, 0600 file, and ideally
  encrypted (ties into SECRETS_DESIGN). Don't ship provider keys in `/api/providers`
  responses.
- **Wire drift**: OpenAI-compat vendors (grok/deepseek/openrouter/google) mostly
  speak /chat/completions but have quirks (google's path, openrouter headers). Seed
  table carries per-vendor tweaks; test each before claiming support.
- **Realtime STT is a bigger lift** (WS session mgmt) — explicitly deferred; file STT
  is the v1 contract and already matches the app's record-then-upload flow.
- Not a release blocker; net-new capability + a refactor of existing voice wiring.
