"""Tests for viewer.speakable — markdown → TTS-friendly prose."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from viewer.speakable import speakable  # noqa: E402


def test_strips_bold_italic_marks():
    assert speakable("This is **bold** and *italic* text.") == "This is bold and italic text."
    assert "*" not in speakable("***very*** important")


def test_inline_code_kept_as_words():
    assert speakable("Run `make serve` now.") == "Run make serve now."


def test_fenced_code_block_replaced():
    md = "Here:\n```python\nprint('hi')\n```\nDone."
    out = speakable(md)
    assert "print" not in out
    assert "code block omitted" in out
    assert "Done." in out


def test_headers_become_sentences_with_pause():
    out = speakable("# Title\nBody text.")
    # header gets a terminal period so the TTS pauses before the body
    assert out.startswith("Title.")


def test_list_items_are_separate_sentences():
    md = "- first item\n- second item\n- third"
    lines = speakable(md).split("\n")
    assert lines == ["first item.", "second item.", "third."]


def test_links_unwrapped_to_text():
    assert speakable("See [the docs](https://x.com/y) here.") == "See the docs here."


def test_bare_url_becomes_a_link():
    assert speakable("Visit https://example.com/page now.") == "Visit a link now."


def test_blockquote_marker_removed():
    assert speakable("> quoted line") == "quoted line."


def test_horizontal_rule_dropped():
    assert speakable("a\n\n---\n\nb") == "a\nb"


def test_emoji_removed():
    assert speakable("Great job! 🎉👍").strip() == "Great job!"


def test_numbered_list():
    assert speakable("1. one\n2. two").split("\n") == ["one.", "two."]


def test_empty_and_whitespace():
    assert speakable("") == ""
    assert speakable("   \n  \n") == ""


def test_plain_prose_unchanged():
    s = "A normal sentence, with a comma; and a semicolon."
    assert speakable(s) == s


if __name__ == "__main__":
    import traceback
    passed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                passed += 1
            except Exception:
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"{passed} passing")
