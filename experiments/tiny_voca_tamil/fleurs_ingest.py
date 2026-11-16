"""Read a pinned local FLEURS TSV and form safe rows for audio conversion.

FLEURS uses headerless TSV files.  This module preserves the source identifier and
raw transcript, but never turns its coarse gender field into a speaker identity.
It does not download, extract archives, run ffmpeg, or invoke a model.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Iterator

from .prepare_fleurs import PreparationError


_FLEURS_COLUMNS = 7
_SPLIT_MAP = {"train": "train", "dev": "validation", "test": "test"}


def records_from_tsv(path: Path, *, source_split: str) -> Iterator[dict[str, Any]]:
    """Yield source-ordered local rows from a pinned, headerless FLEURS TSV."""
    if source_split not in _SPLIT_MAP:
        raise PreparationError("FLEURS source split must be train, dev, or test")
    path = Path(path)
    try:
        with path.open("r", encoding="utf-8", newline="") as stream:
            reader = csv.reader(stream, delimiter="\t")
            for line_number, fields in enumerate(reader, start=1):
                if len(fields) != _FLEURS_COLUMNS:
                    raise PreparationError(f"FLEURS TSV line {line_number} has unexpected column count")
                source_sentence_id, filename, raw_transcript, normalized_transcript, _tokens, _duration, _gender = fields
                if not source_sentence_id or not filename or not raw_transcript or not normalized_transcript:
                    raise PreparationError(f"FLEURS TSV line {line_number} has missing required data")
                filename_path = Path(filename)
                if filename_path.is_absolute() or ".." in filename_path.parts or filename_path.suffix.lower() != ".wav":
                    raise PreparationError(f"FLEURS TSV line {line_number} has unsafe audio filename")
                # Sentence IDs repeat because FLEURS contains multiple readings of
                # one sentence.  The filename is the stable recording identity.
                yield {
                    "source_row_id": filename_path.stem,
                    "source_sentence_id": source_sentence_id,
                    "split": _SPLIT_MAP[source_split],
                    "transcript": raw_transcript,
                    "normalized_transcript": normalized_transcript,
                    # FLEURS audio tarballs contain <source_split>/<filename>.
                    "source_audio": str(Path(source_split) / filename_path),
                    "speaker_id": None,
                    "speaker_known": False,
                }
    except UnicodeDecodeError as error:
        raise PreparationError("FLEURS TSV must be UTF-8") from error
