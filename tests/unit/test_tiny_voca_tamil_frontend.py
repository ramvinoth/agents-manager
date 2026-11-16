"""Pure Tamil-script frontend and alignment-result contract tests."""

import pytest

from experiments.tiny_voca_tamil.alignment import AlignmentError, Span, validate_alignment
from experiments.tiny_voca_tamil.tamil_frontend import (
    BOS, EOS, SP, TamilFrontendError, frontend_fingerprint, is_phone, phonemize,
)


def test_tamil_script_emits_stable_phonemes_and_structure():
    result = phonemize("தமிழ் மொழி!")
    assert result.symbols == (BOS, "t", "a", "m", "i", "ɻ", SP, "m", "o", "ɻ", "i", "!", EOS)
    assert tuple(is_phone(result.ids)) == tuple(symbol not in {BOS, EOS, SP, "!"} for symbol in result.symbols)
    assert len(result.ids) == len(result.symbols) == len(result.stress)
    assert not result.unknown


@pytest.mark.parametrize("text", ["தமிழ்‎", "tamil", "தமிழ் 123", "தமிழ்🙂", "...", ""])
def test_unsupported_or_nonlexical_input_is_rejected(text):
    with pytest.raises(TamilFrontendError):
        phonemize(text)


def test_repeated_punctuation_collapses_and_no_duplicate_spaces():
    result = phonemize("அம்மா!!  அப்பா")
    assert result.symbols.count("!") == 1
    assert not any(left == right == SP for left, right in zip(result.symbols, result.symbols[1:]))


def test_frontend_fingerprint_is_deterministic():
    assert len(frontend_fingerprint()) == 64
    assert frontend_fingerprint() == frontend_fingerprint()


def test_alignment_accepts_exact_acoustic_frame_cover():
    phones = phonemize("அம்மா")
    acoustic = [token for token in phones.symbols if token not in {BOS, EOS, SP}]
    spans = tuple(Span(token, index, index + 1) for index, token in enumerate(acoustic))
    assert validate_alignment(phones.symbols, spans, total_frames=len(spans)) == spans


@pytest.mark.parametrize("spans,total", [
    ((Span("i", 0, 1),), 1),
    ((Span("a", 1, 2),), 2),
    ((Span("a", 0, 0),), 1),
])
def test_invalid_alignment_cannot_be_accepted(spans, total):
    phones = phonemize("அ")
    with pytest.raises(AlignmentError):
        validate_alignment(phones.symbols, spans, total_frames=total)
