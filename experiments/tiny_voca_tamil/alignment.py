"""Language-agnostic validation for a Tamil-capable alignment backend's result.

Selecting and invoking a Tamil aligner is deliberately outside this module. This
boundary ensures a backend cannot silently return incomplete or unordered spans.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from .tamil_frontend import PHONE_SET


class AlignmentError(ValueError):
    """An alignment result cannot safely be used for annotation."""


@dataclass(frozen=True)
class Span:
    token: str
    start_frame: int
    end_frame: int


def validate_alignment(tokens: Sequence[str], spans: Iterable[Span], *, total_frames: int) -> tuple[Span, ...]:
    if not isinstance(total_frames, int) or total_frames <= 0:
        raise AlignmentError("total_frames must be positive")
    acoustic = tuple(token for token in tokens if token in PHONE_SET)
    observed = tuple(spans)
    if len(observed) != len(acoustic):
        raise AlignmentError("alignment must contain exactly one span per acoustic token")
    previous_end = 0
    for expected, span in zip(acoustic, observed, strict=True):
        if span.token != expected:
            raise AlignmentError("alignment token order differs from frontend output")
        if not isinstance(span.start_frame, int) or not isinstance(span.end_frame, int):
            raise AlignmentError("alignment frame bounds must be integers")
        if span.start_frame != previous_end:
            raise AlignmentError("acoustic spans must be contiguous")
        if span.end_frame <= span.start_frame:
            raise AlignmentError("every acoustic token needs at least one frame")
        if span.end_frame > total_frames:
            raise AlignmentError("alignment span exceeds feature frames")
        previous_end = span.end_frame
    if previous_end != total_frames:
        raise AlignmentError("acoustic spans must cover all feature frames")
    return observed
