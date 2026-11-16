# Tamil Tiny-voca corpus/frontend proof

This package is an isolated **data, text, and alignment-contract proof** for Card 585. It is not a Harman call feature, a Tiny-voca fork, a trained Tamil model, or a Breeze replacement.

## Fixed sources

- Tiny-voca source reference: commit `62e2adef158bc997042cc6234f541f1e0e4cd55d`.
- Corpus candidate: `google/fleurs`, configuration `ta_in`, revision `70bb2e84b976b7e960aa89f1c648e09c59f894dd`.
- Declared corpus license: CC-BY-4.0. Preserve this attribution and review intended deployment use before any product work.
- Target audio contract: 24 kHz, mono, signed 16-bit PCM WAV.

FLEURS Tamil is read speech and its exposed schema has no speaker identifier. Its rows therefore carry `speaker_id: null` and `speaker_known: false`. Gender, filenames, and split membership are **not** substitute speaker IDs. This corpus is appropriate only for a small ingestion/frontend/alignment proof, not for a coherent product voice.

## Boundaries

- No download occurs in this package; supply a pinned local snapshot explicitly.
- `audio_convert.py` converts one already-local source file through an explicit `ffmpeg` binary to metadata-stripped 24 kHz mono signed-16-bit PCM WAV, verifies the result, and atomically publishes it. It does not download, train, or serve.
- No GPU, Tiny-voca training, model loading, serving, viewer, mobile app, call bridge, tunnel, cloud route, or production audio asset is used.
- The frontend accepts Tamil script only. Free-form Romanized Tamil/Tanglish is rejected, rather than silently falling back to English.
- `alignment.py` only validates a result from a separately proven Tamil-capable alignment backend. It does not claim that Tiny-voca's English eSpeak CTC recognizer supports Tamil.

## Artifacts

Track source/spec/test code and tiny synthetic fixtures. Keep downloaded corpus copies, converted WAVs, JSONL/Parquet manifests, acoustic tensors, alignment products, logs, checkpoints, and generated audio in an explicit local artifact directory outside this repository. Do not store credentials, user audio, or production paths in artifacts or manifests.

## Gates

1. Hermetic unit tests prove deterministic provenance, safe source records, WAV contract validation, frozen Tamil tokens, and alignment invariants.
2. A pinned local FLEURS audit subset must yield a valid Tamil-frontend result and either a complete alignment or an explicit failure for each row.
3. Only after a Tamil-capable aligner is proven, and an independent GPU1 handoff verifies production health plus available capacity, may a bounded training proposal be evaluated.

A successful result through these gates proves only corpus/frontend/alignment readiness for the tested subset. It does not prove Tamil voice quality, speaker consistency, reference-voice cloning, streaming synthesis, interruption behavior, or live-call compatibility.
