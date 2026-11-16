"""Frozen, Tamil-script-only text frontend for the experiment proof.

This is deliberately not a general Tanglish G2P. Unsupported input fails closed.
The phone inventory is an experiment contract, not evidence of acoustic quality.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import unicodedata
from typing import Iterable


FRONTEND_VERSION = 1
PAD, BOS, EOS, SP, UNK = "<pad>", "<bos>", "<eos>", "<sp>", "<unk>"
SPECIALS = (PAD, BOS, EOS, SP, UNK)
PUNCTUATION = (",", ".", "?", "!", ";", ":", "…")

# Append-only. Reordering invalidates token IDs and all dependent annotations.
CONSONANTS = (
    "k", "ŋ", "tʃ", "ɲ", "ʈ", "ɳ", "t", "n", "p", "m", "j", "r", "l", "ʋ", "ɻ", "ɭ", "r̪", "n̪",
    "dʒ", "ʃ", "s", "h", "kʂ",
)
VOWELS = ("a", "aː", "i", "iː", "u", "uː", "e", "eː", "ai", "o", "oː", "au")
PHONES = CONSONANTS + VOWELS
SYMBOLS = SPECIALS + PUNCTUATION + PHONES
SYMBOL_TO_ID = {symbol: index for index, symbol in enumerate(SYMBOLS)}
PHONE_SET = frozenset(PHONES)
PHONE_IDS = frozenset(SYMBOL_TO_ID[symbol] for symbol in PHONES) | {SYMBOL_TO_ID[UNK]}
VOWEL_SET = frozenset(VOWELS)

INDEPENDENT_VOWELS = {
    "அ": "a", "ஆ": "aː", "இ": "i", "ஈ": "iː", "உ": "u", "ஊ": "uː", "எ": "e", "ஏ": "eː",
    "ஐ": "ai", "ஒ": "o", "ஓ": "oː", "ஔ": "au",
}
DEPENDENT_VOWELS = {
    "ா": "aː", "ி": "i", "ீ": "iː", "ு": "u", "ூ": "uː", "ெ": "e", "ே": "eː", "ை": "ai",
    "ொ": "o", "ோ": "oː", "ௌ": "au",
}
CONSONANT_MAP = {
    "க": "k", "ங": "ŋ", "ச": "tʃ", "ஞ": "ɲ", "ட": "ʈ", "ண": "ɳ", "த": "t", "ந": "n",
    "ப": "p", "ம": "m", "ய": "j", "ர": "r", "ல": "l", "வ": "ʋ", "ழ": "ɻ", "ள": "ɭ", "ற": "r̪", "ன": "n̪",
    # Grantha letters included deliberately for FLEURS names/loanwords.
    "ஜ": "dʒ", "ஷ": "ʃ", "ஸ": "s", "ஹ": "h", "க்ஷ": "kʂ",
}
PULLI = "்"
AYTAM = "ஃ"


class TamilFrontendError(ValueError):
    """The input is outside this frozen Tamil-script proof contract."""


class NothingToPronounce(TamilFrontendError):
    """No Tamil lexical material was present."""


@dataclass(frozen=True)
class Phonemized:
    symbols: tuple[str, ...]
    ids: tuple[int, ...]
    stress: tuple[int, ...]
    unknown: tuple[str, ...]

    def __len__(self) -> int:
        return len(self.ids)


def frontend_identity() -> dict[str, object]:
    return {
        "frontend": "tamil-script-proof",
        "frontend_version": FRONTEND_VERSION,
        "symbols": list(SYMBOLS),
        "independent_vowels": INDEPENDENT_VOWELS,
        "dependent_vowels": DEPENDENT_VOWELS,
        "consonants": CONSONANT_MAP,
        "pulli": PULLI,
        "aytam": AYTAM,
        "unsupported_romanized_tamil": True,
    }


def frontend_fingerprint() -> str:
    return hashlib.sha256(json.dumps(frontend_identity(), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize_text(text: str) -> str:
    if not isinstance(text, str):
        raise TamilFrontendError("text must be a string")
    text = unicodedata.normalize("NFC", text)
    if any(unicodedata.category(char) == "Cf" for char in text):
        raise TamilFrontendError("format/control characters are unsupported")
    text = " ".join(text.split())
    if not text:
        raise TamilFrontendError("text must not be blank")
    return text


def _next_grapheme(text: str, index: int) -> tuple[tuple[str, ...], int]:
    char = text[index]
    # The only multi-codepoint base allowed by the mapping is க்ஷ.
    if text.startswith("க்ஷ", index):
        return ("க்ஷ",), index + 3
    if char in INDEPENDENT_VOWELS or char == AYTAM:
        return (char,), index + 1
    if char not in CONSONANT_MAP:
        raise TamilFrontendError(f"unsupported Tamil character: {char!r}")
    index += 1
    if index < len(text) and text[index] == PULLI:
        return (char, PULLI), index + 1
    if index < len(text) and text[index] in DEPENDENT_VOWELS:
        return (char, text[index]), index + 1
    if index < len(text) and text[index] in (PULLI, *DEPENDENT_VOWELS):
        raise TamilFrontendError("invalid Tamil vowel-sign sequence")
    return (char,), index


def _word_phones(word: str) -> tuple[str, ...]:
    phones: list[str] = []
    index = 0
    while index < len(word):
        cluster, index = _next_grapheme(word, index)
        base = cluster[0]
        if base in INDEPENDENT_VOWELS:
            phones.append(INDEPENDENT_VOWELS[base])
        elif base == AYTAM:
            phones.append("h")
        else:
            phones.append(CONSONANT_MAP[base])
            if len(cluster) == 1:
                phones.append("a")
            elif cluster[1] != PULLI:
                phones.append(DEPENDENT_VOWELS[cluster[1]])
    return tuple(phones)


def phonemize(text: str) -> Phonemized:
    text = normalize_text(text)
    symbols: list[str] = [BOS]
    unknown: list[str] = []
    lexical = False
    words_since_boundary = False
    for part in _parts(text):
        if part in PUNCTUATION:
            if symbols[-1] != part:
                symbols.append(part)
            words_since_boundary = False
            continue
        phones = _word_phones(part)
        if words_since_boundary:
            symbols.append(SP)
        symbols.extend(phones)
        lexical = True
        words_since_boundary = True
    symbols.append(EOS)
    if not lexical:
        raise NothingToPronounce("the text has no Tamil letters to pronounce")
    return Phonemized(tuple(symbols), tuple(SYMBOL_TO_ID[s] for s in symbols), tuple(0 for _ in symbols), tuple(unknown))


def _parts(text: str) -> Iterable[str]:
    current: list[str] = []
    for char in text:
        if char.isspace():
            if current:
                yield "".join(current)
                current.clear()
            continue
        if char in PUNCTUATION:
            if current:
                yield "".join(current)
                current.clear()
            yield char
            continue
        if "A" <= char <= "z" or char.isdigit() or not ("஀" <= char <= "௿"):
            raise TamilFrontendError(f"unsupported non-Tamil input: {char!r}")
        current.append(char)
    if current:
        yield "".join(current)


def is_phone(token_ids: Iterable[int]) -> list[bool]:
    return [int(token_id) in PHONE_IDS for token_id in token_ids]
