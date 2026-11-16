"""Deterministic local FLEURS Tamil manifest preparation.

This module does not download the corpus or call Tiny-voca. It validates metadata
and normalized WAV artifacts that another explicitly invoked local conversion step
has already produced.
"""

from __future__ import annotations

from dataclasses import dataclass
import argparse
import json
from pathlib import Path
import unicodedata
import wave
from typing import Any, Iterable, Mapping

from . import spec
from .provenance import ProvenanceError, canonical_json, sha256_file, sha256_text, source_identity


class PreparationError(ValueError):
    """A corpus row cannot enter the reproducible local manifest."""


@dataclass(frozen=True)
class PreparedRow:
    id: str
    split: str
    source_row_id: str
    transcript: str
    normalized_transcript: str
    audio: str
    source_audio_sha256: str
    audio_sha256: str
    duration_ms: int
    speaker_id: None = None
    speaker_known: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "split": self.split,
            "source_row_id": self.source_row_id,
            "transcript": self.transcript,
            "normalized_transcript": self.normalized_transcript,
            "audio": self.audio,
            "source_audio_sha256": self.source_audio_sha256,
            "audio_sha256": self.audio_sha256,
            "duration_ms": self.duration_ms,
            "speaker_id": self.speaker_id,
            "speaker_known": self.speaker_known,
            "provenance": source_identity(),
        }


def normalize_transcript(text: str) -> str:
    if not isinstance(text, str):
        raise PreparationError("transcript must be a string")
    normalized = " ".join(unicodedata.normalize("NFC", text).split())
    if not normalized:
        raise PreparationError("transcript must not be blank")
    return normalized


def wav_properties(path: Path) -> tuple[int, int, int]:
    """Return (sample-rate, channels, duration-ms) for ordinary PCM WAV only."""
    try:
        with wave.open(str(path), "rb") as stream:
            if stream.getcomptype() != "NONE":
                raise PreparationError("WAV must be uncompressed PCM")
            if stream.getsampwidth() != 2:
                raise PreparationError("WAV must be 16-bit PCM")
            rate, channels, frames = stream.getframerate(), stream.getnchannels(), stream.getnframes()
    except (wave.Error, EOFError) as error:
        raise PreparationError(f"invalid WAV: {error}") from error
    if rate != spec.TARGET_SAMPLE_RATE:
        raise PreparationError(f"expected {spec.TARGET_SAMPLE_RATE} Hz WAV")
    if channels != spec.TARGET_CHANNELS:
        raise PreparationError("expected mono WAV")
    if frames <= 0:
        raise PreparationError("WAV must contain frames")
    return rate, channels, round(frames * 1000 / rate)


def build_row(row: Mapping[str, Any], *, audio_root: Path) -> PreparedRow:
    if not isinstance(row, Mapping):
        raise PreparationError("source row must be an object")
    source_row_id = row.get("source_row_id")
    split = row.get("split")
    audio = row.get("audio")
    if not isinstance(source_row_id, str) or not source_row_id:
        raise PreparationError("source_row_id must be a nonempty string")
    if split not in {"train", "validation", "test"}:
        raise PreparationError("split must be train, validation, or test")
    if not isinstance(audio, str) or not audio or Path(audio).is_absolute() or ".." in Path(audio).parts:
        raise PreparationError("audio must be a safe relative path")
    if row.get("speaker_id", None) is not None or row.get("speaker_known", False) is not False:
        raise PreparationError("FLEURS speaker identity is unavailable; labels must remain unknown")
    transcript = row.get("transcript")
    normalized = normalize_transcript(transcript)
    source_audio_sha256 = row.get("source_audio_sha256")
    if not isinstance(source_audio_sha256, str) or len(source_audio_sha256) != 64:
        raise PreparationError("source_audio_sha256 must be a SHA-256 string")
    try:
        int(source_audio_sha256, 16)
    except ValueError as error:
        raise PreparationError("source_audio_sha256 must be a SHA-256 string") from error
    audio_path = audio_root / audio
    if not audio_path.is_file():
        raise PreparationError("normalized audio is missing")
    _, _, duration_ms = wav_properties(audio_path)
    return PreparedRow(
        id=f"fleurs-ta_in-{split}-{source_row_id}",
        split=split,
        source_row_id=source_row_id,
        transcript=transcript,
        normalized_transcript=normalized,
        audio=audio,
        source_audio_sha256=source_audio_sha256,
        audio_sha256=sha256_file(audio_path),
        duration_ms=duration_ms,
    )


def build_manifest(rows: Iterable[Mapping[str, Any]], *, audio_root: Path) -> list[dict[str, Any]]:
    prepared = [build_row(row, audio_root=audio_root) for row in rows]
    seen = set()
    for item in prepared:
        if item.id in seen:
            raise PreparationError(f"duplicate source id: {item.source_row_id}")
        seen.add(item.id)
    return [item.to_dict() for item in sorted(prepared, key=lambda item: (item.split, item.source_row_id))]


def write_manifest(path: Path, manifest: Iterable[Mapping[str, Any]]) -> None:
    """Write a deterministic JSONL index or an optional Parquet index.

    Parquet is intentionally optional: this package must remain importable in the
    hermetic test environment without a dataset/download dependency.
    """
    path = Path(path)
    rows = list(manifest)
    if path.suffix == ".jsonl":
        with path.open("w", encoding="utf-8", newline="\n") as stream:
            for row in rows:
                stream.write(canonical_json(row) + "\n")
        return
    if path.suffix == ".parquet":
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError as error:
            raise PreparationError("Parquet output needs pyarrow; use .jsonl or install it in the experiment environment") from error
        pq.write_table(pa.Table.from_pylist(rows), path, compression="zstd")
        return
    raise PreparationError("output must end in .jsonl or .parquet")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=Path, required=True, help="Local JSON source rows; no downloads occur")
    parser.add_argument("--audio-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        rows = json.loads(args.rows.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise PreparationError("--rows must be a JSON array")
        manifest = build_manifest(rows, audio_root=args.audio_root)
        write_manifest(args.output, manifest)
    except (OSError, json.JSONDecodeError, ProvenanceError, PreparationError) as error:
        parser.error(str(error))
    print(canonical_json({"rows": len(manifest), "manifest_sha256": sha256_file(args.output)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
