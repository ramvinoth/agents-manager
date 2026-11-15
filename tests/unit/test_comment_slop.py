"""Comment guard: a comment states what the code is and why, as it is today.

Agents copy whatever the codebase already holds, so one stale or excusing comment
breeds more. Four kinds never belong in a comment:
  - an excuse for a stopgap ("for now", "quick fix", "hack", TODO/FIXME/XXX):
    fix the root cause, or put the follow-up on a board card;
  - change narration ("previously", "moved out of", "was renamed"): history
    lives in git, the comment describes the code that is here;
  - an assistant's voice ("I've", "let me", "the user asked"): say what the code
    does and the rule it keeps, not who asked for it;
  - AI filler and emoji ("it's worth noting", "seamlessly", "delve").
Quoted text inside a comment is ignored, so a comment may cite a phrase as data.
"""
import io
import re
import subprocess
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ("orchestrator", "web/src", "mobile-app/src", "server.py",
           "sandbox", "relay", "deploy", "desktop", "tests")
SUFFIXES = (".py", ".ts", ".tsx", ".js", ".mjs")
SELF = Path(__file__).resolve()

RULES = {
    "stopgap": (re.compile(r"\b(for now|quick fix|band-?aid|kludge|hack(y|ish)?)\b", re.I),
                "fix the root cause, or file the follow-up as a board card"),
    "marker": (re.compile(r"\b(TODO|FIXME|XXX)\b"),
               "do the work now, or file it as a board card"),
    "narration": (re.compile(r"\b(previously(?!-)|moved (out of|from|here)"
                             r"|(was|were|got) (renamed|moved|replaced|removed))\b", re.I),
                  "describe the code as it is now; git holds the history"),
    "assistant": (re.compile(r"\b(I've|let me|here's|you asked|the user asked)\b", re.I),
                  "state what the code does and the rule it keeps"),
    "filler": (re.compile(r"\b(it'?s (important|worth) (to note|noting)|delve|seamless(ly)?"
                          r"|game.?changer)\b", re.I),
               "say the plain fact"),
    "emoji": (re.compile("[\U0001F300-\U0001FAFF✅❌✨]"),
              "drop the emoji"),
}
QUOTED = re.compile(r"\"[^\"]*\"|`[^`]*`|“[^”]*”")
TS_COMMENT = re.compile(r"(?:^|\s)//(.*)$|^\s*(?:/\*+|\*)(.*)$")


def _py_comments(text):
    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                yield tok.start[0], tok.string
    except (tokenize.TokenError, SyntaxError):
        return


def _ts_comments(text):
    for n, line in enumerate(text.splitlines(), 1):
        m = TS_COMMENT.search(line)
        if m:
            yield n, m.group(1) or m.group(2) or ""


def _hits():
    files = subprocess.run(["git", "ls-files", "--", *SOURCES], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.split()
    for rel in files:
        p = ROOT / rel
        if p.suffix not in SUFFIXES or not p.is_file() or p.resolve() == SELF:
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        comments = _py_comments(text) if p.suffix == ".py" else _ts_comments(text)
        for n, comment in comments:
            bare = QUOTED.sub("", comment)
            for kind, (rx, fix) in RULES.items():
                if rx.search(bare):
                    yield f"{rel}:{n} [{kind}: {fix}] {comment.strip()[:100]}"


def test_no_slop_comments():
    hits = list(_hits())
    assert not hits, "comments that excuse, narrate or pad:\n" + "\n".join(hits)


def test_rules_catch_the_patterns_they_name():
    def flagged(text):
        return {k for k, (rx, _) in RULES.items() if rx.search(QUOTED.sub("", text))}
    assert flagged("# skip the lock for now") == {"stopgap"}
    assert flagged("# TODO wire this up") == {"marker"}
    assert flagged("# Previously this lived in two places") == {"narration"}
    assert flagged("# I've changed this to retry") == {"assistant"}
    assert flagged("# it's worth noting that this works seamlessly") == {"filler"}
    assert not flagged("# Run fn after all previously-queued transitions")
    assert not flagged('# The model often ends with "Let me know if you need anything!"')
    assert not flagged("# Todo is the first board column")
