"""Canonical, credential-free provenance records for the corpus proof."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from . import spec


class ProvenanceError(ValueError):
    """The source identity or a portable corpus record is invalid."""


def canonical_json(value: Any) -> str:
    """Serialize JSON deterministically and reject values outside the wire format."""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ProvenanceError(f"not canonical JSON: {error}") from error


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    if not isinstance(value, str):
        raise ProvenanceError("text must be a string")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def source_identity() -> dict[str, Any]:
    return {
        "experiment_version": spec.EXPERIMENT_VERSION,
        "source_repository": spec.FLEURS_REPOSITORY,
        "source_config": spec.FLEURS_CONFIG,
        "source_revision": spec.FLEURS_REVISION,
        "source_license": spec.FLEURS_LICENSE,
        "target_sample_rate": spec.TARGET_SAMPLE_RATE,
        "target_channels": spec.TARGET_CHANNELS,
        "target_encoding": spec.TARGET_ENCODING,
    }


def validate_identity(value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ProvenanceError("source identity must be an object")
    expected = source_identity()
    missing = spec.PROVENANCE_REQUIRED - set(value)
    if missing:
        raise ProvenanceError(f"source identity missing: {', '.join(sorted(missing))}")
    unexpected = set(value) - set(expected)
    if unexpected:
        raise ProvenanceError(f"source identity has unexpected fields: {', '.join(sorted(unexpected))}")
    for key, wanted in expected.items():
        if value.get(key) != wanted:
            raise ProvenanceError(f"source identity mismatch for {key}")
    return expected


def provenance_fingerprint(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonical_json(validate_identity(value)).encode("utf-8")).hexdigest()
