"""viewer.speakable — turn agent markdown into clean text a TTS model can read.

Kokoro (and any TTS) reads exactly what you give it, so raw markdown becomes
"asterisk asterisk bold asterisk asterisk", code blocks get read symbol by
symbol, and list bullets/headers run together with no pause. This module
converts a markdown reply into plain, well-punctuated prose:

  - strips inline markup (**bold**, *italic*, `code`, ~~strike~~) to its text
  - drops fenced code blocks, replacing each with a short spoken placeholder
  - turns headers, list items, and blockquotes into separate sentences so the
    TTS pauses between them (a trailing "." is the pacing signal Kokoro honors)
  - unwraps links [text](url) to just `text`; bare URLs become "a link"
  - removes emoji and stray symbols that would be voiced literally

Pure and dependency-free so it is unit-testable without the TTS service.
"""
import re

# One fenced code block ``` … ``` (optionally language-tagged). DOTALL so it
# spans lines; non-greedy so adjacent blocks don't merge.
_FENCE = re.compile(r"```[^\n]*\n.*?```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]+)`")
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_BARE_URL = re.compile(r"https?://\S+")
_BOLD_ITALIC = re.compile(r"(\*\*\*|\*\*|\*|___|__|_|~~)(.+?)\1")
_HEADER = re.compile(r"^\s{0,3}#{1,6}\s*")
_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?")
_LIST_MARK = re.compile(r"^\s*([*+-]|\d+[.)])\s+")
_HR = re.compile(r"^\s*([-*_])\s*(\1\s*){2,}$")
# Emoji + pictographs + variation selectors (voiced as noise otherwise).
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF←-⇿⬀-⯿️‍]"
)
_MULTISPACE = re.compile(r"[ \t]+")
_MULTINEWLINE = re.compile(r"\n{2,}")


def _ensure_sentence_end(line: str) -> str:
    """Give a line terminal punctuation so the TTS pauses after it. Headers and
    list items usually lack a period; without one they run into the next line."""
    line = line.rstrip()
    if line and line[-1] not in ".!?:;,":
        line += "."
    return line


def speakable(text: str) -> str:
    """Convert markdown `text` into plain prose suitable for TTS."""
    if not text:
        return ""

    # Block-level replacements first (before we split into lines).
    text = _FENCE.sub(" (code block omitted). ", text)
    text = _IMAGE.sub(" ", text)

    out_lines = []
    for raw in text.split("\n"):
        line = raw
        if _HR.match(line):
            continue  # horizontal rule — nothing to say
        was_block = bool(_HEADER.match(line) or _LIST_MARK.match(line) or _BLOCKQUOTE.match(line))
        line = _HEADER.sub("", line)
        line = _BLOCKQUOTE.sub("", line)
        line = _LIST_MARK.sub("", line)

        # Inline replacements.
        line = _INLINE_CODE.sub(r"\1", line)
        line = _LINK.sub(r"\1", line)
        line = _BARE_URL.sub("a link", line)
        # Collapse emphasis runs until stable (handles ***nested** cases).
        prev = None
        while prev != line:
            prev = line
            line = _BOLD_ITALIC.sub(r"\2", line)
        # Any leftover markdown emphasis chars that weren't paired.
        line = line.replace("**", "").replace("__", "").replace("~~", "")
        line = _EMOJI.sub("", line)
        line = _MULTISPACE.sub(" ", line).strip()
        if not line:
            continue
        # Headers/list items get a sentence end so the voice pauses between them.
        out_lines.append(_ensure_sentence_end(line) if was_block else line)

    result = "\n".join(out_lines)
    result = _MULTINEWLINE.sub("\n", result).strip()
    return result
