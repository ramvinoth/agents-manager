"""orchestrator.callnatural: the offline scorer for how human the live call
sounds. The labelled corpus is the regression set: a change to the scorer or to
the persona must keep the human reply ahead of the help-desk one in every pair."""
import json
from pathlib import Path

import pytest

from orchestrator import callnatural as cn

CORPUS = json.loads((Path(__file__).parent.parent / "callnatural_corpus.json").read_text())
PAIRS = CORPUS["pairs"]


@pytest.mark.parametrize("pair", PAIRS, ids=[p["user"] for p in PAIRS])
def test_human_reply_beats_help_desk_reply(pair):
    assert cn.reply_score(pair["human"]) > cn.reply_score(pair["cs"])


@pytest.mark.parametrize("pair", PAIRS, ids=[p["user"] for p in PAIRS])
def test_detector_flags_every_help_desk_reply_and_no_human_one(pair):
    assert cn.reply_report(pair["cs"])["cs_hits"]
    assert not cn.reply_report(pair["human"])["cs_hits"]


def test_report_facts():
    r = cn.reply_report("Yeah, it's 488. I mean, the sound check one.")
    assert r["response_token"] == "yeah"
    assert r["fillers"] == 1
    assert r["contractions"] == 1 and r["uncontracted"] == 0
    assert r["sentences"] == 2 and not r["markup"]
    assert cn.reply_report("- one\n- two")["markup"]
    assert cn.reply_report("Done. Let me know if you need more.")["ends_with_offer"]
    assert not cn.reply_report("Let me know. Then we go.")["ends_with_offer"]


def test_score_edges():
    assert cn.reply_score("") == 0.0
    assert cn.reply_score("Sure, 488 is the sound check.") == 1.0
    assert cn.reply_score("It is fine.") < cn.reply_score("It's fine.")
    long = " ".join(["word"] * 80) + "."
    assert cn.reply_score(long) < 0.7
    assert cn.reply_score("Um, uh, um, well, uh, yeah.") < 1.0


def test_gap_grows_with_reply_length_and_never_beats_the_endpoint():
    gaps = [cn.response_gap_ms(n) for n in (0, 5, 20, 60)]
    assert gaps == sorted(gaps) and len(set(gaps)) == 4
    assert gaps[0] >= max(cn.ENDPOINT_QUIET_MS, cn.ASR_LAG_MS) + cn.TTS_FIRST_AUDIO_MS
    assert cn.response_gap_ms(10, asr_lag_ms=0) < cn.response_gap_ms(10)


def test_gap_score_bounds():
    assert cn.gap_score(100) == 1.0
    assert cn.gap_score(cn.SLOW_GAP_MS) == 0.0
    assert cn.gap_score(10_000) == 0.0
    assert 0 < cn.gap_score(1200) < 1


def test_call_score_prefers_the_human_call():
    human = cn.call_score([p["human"] for p in PAIRS], acks=["One sec.", "Let me look.", "Checking."])
    desk = cn.call_score([p["cs"] for p in PAIRS], acks=["One sec, checking."] * 3)
    assert human["score"] > desk["score"]
    assert cn.call_score([])["score"] == 0.0


def test_variety():
    assert cn.variety(["a", "b"]) == 1.0
    assert cn.variety(["a", "A ", "a"]) == pytest.approx(1 / 3)
    assert cn.variety([]) == 1.0
