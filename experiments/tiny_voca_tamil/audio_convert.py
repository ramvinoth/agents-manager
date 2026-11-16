"""Deterministic local conversion into the Tamil POC audio contract.

This wrapper has no network or model dependency.  It invokes an explicitly selected
ffmpeg binary, converts one local source file at a time, verifies the result, and
atomically publishes only a validated 24 kHz mono PCM WAV.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os
import subprocess
import tempfile

from . import spec
from .provenance import sha256_file


class AudioConversionError(RuntimeError):
    """A source file could not be converted into the experiment contract."""


@dataclass(frozen=True)
class ConvertedAudio:
    source_sha256: str
    output_sha256: str
    sample_rate: int
    channels: int
    duration_ms: int


def wav_properties(path: Path) -> tuple[int, int, int]:
    """Validate ordinary signed 16-bit PCM WAV and return rate/channels/duration."""
    # wave is deliberately used here: it makes the emitted WAV contract independent
    # of ffprobe output formatting and the Python package has no decoder dependency.
    import wave

    try:
        with wave.open(str(path), "rb") as stream:
            if stream.getcomptype() != "NONE":
                raise AudioConversionError("output WAV must be uncompressed PCM")
            if stream.getsampwidth() != 2:
                raise AudioConversionError("output WAV must be signed 16-bit PCM")
            rate, channels, frames = stream.getframerate(), stream.getnchannels(), stream.getnframes()
    except (OSError, EOFError, wave.Error) as error:
        raise AudioConversionError(f"invalid output WAV: {error}") from error
    if rate != spec.TARGET_SAMPLE_RATE:
        raise AudioConversionError(f"output WAV must be {spec.TARGET_SAMPLE_RATE} Hz")
    if channels != spec.TARGET_CHANNELS:
        raise AudioConversionError("output WAV must be mono")
    if frames <= 0:
        raise AudioConversionError("output WAV must contain frames")
    return rate, channels, round(frames * 1000 / rate)


def convert_to_contract(source: Path, destination: Path, *, ffmpeg: str = "ffmpeg") -> ConvertedAudio:
    """Convert one already-local source file and atomically publish validated WAV.

    ``destination`` is overwritten only after ffmpeg exits successfully and the
    temporary result satisfies the fixed experiment contract.  ffmpeg diagnostics
    are intentionally not persisted by this module because they may include source
    paths and metadata.
    """
    source, destination = Path(source), Path(destination)
    if not source.is_file():
        raise AudioConversionError("source audio is missing")
    if destination.exists() and destination.is_dir():
        raise AudioConversionError("destination must be a file")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256_file(source)

    with tempfile.NamedTemporaryFile(
        mode="wb", suffix=".wav", prefix=".tiny-voca-", dir=destination.parent, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        completed = subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-map_metadata",
                "-1",
                "-vn",
                "-ac",
                str(spec.TARGET_CHANNELS),
                "-ar",
                str(spec.TARGET_SAMPLE_RATE),
                "-c:a",
                "pcm_s16le",
                str(temporary_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=False,
            check=False,
        )
        if completed.returncode != 0:
            raise AudioConversionError("ffmpeg conversion failed")
        sample_rate, channels, duration_ms = wav_properties(temporary_path)
        output_hash = sha256_file(temporary_path)
        os.replace(temporary_path, destination)
    except OSError as error:
        raise AudioConversionError("ffmpeg executable or audio file is unavailable") from error
    finally:
        temporary_path.unlink(missing_ok=True)
    return ConvertedAudio(source_hash, output_hash, sample_rate, channels, duration_ms)
