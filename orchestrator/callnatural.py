"""How human the live call sounds, scored offline.

Pure functions, no network: the call-naturalness eval (tests/callnatural_sample.py)
and its regression tests use them to grade the words Harman speaks and the time
it takes to start speaking. Every target here comes from published conversation
research or from the measured voice stack; the source is named beside each one.

Three parts:
  reply_report / reply_score   one spoken reply: customer-service phrasing,
                               length, contractions, response tokens, fillers
  response_gap_ms              caller stops talking -> Harman's first sound
  call_score                   a whole scripted call, 0..100
"""

import re

# Phrases that make a phone voice sound like a help desk instead of a person.
CS_PHRASES = [
    r"\bassist(ing|ance)? you\b", r"\bcertainly\b", r"\babsolutely\b",
    r"\bgreat question\b", r"\b(i'?d|i would) be (happy|glad|delighted) to\b",
    r"\bfeel free\b", r"\blet me know if\b", r"\banything else\b",
    r"\b(i )?apologi[sz]e for (any|the) inconvenience\b", r"\bas an ai\b",
    r"\brest assured\b", r"\bthank you for your patience\b", r"\bhope this helps\b",
    r"\bdon'?t hesitate\b", r"\bhow (can|may) i help\b", r"\bis there anything\b",
    r"\bi understand your\b", r"\bthank you for (reaching out|calling|asking)\b",
    r"\bplease note\b", r"\bkindly\b", r"\bmy pleasure\b", r"\bof course!",
    r"\bi'?m here to help\b", r"\bhappy to help\b",
]
_CS = [re.compile(p, re.I) for p in CS_PHRASES]

# Turn-initial response tokens people use to take a turn ("Yeah, ...", "Oh, ...").
RESPONSE_TOKENS = ("yeah", "yep", "oh", "mm", "mhm", "right", "okay", "ok", "so",
                   "well", "hmm", "ah", "huh", "sure", "nah", "no", "yes", "ha")
_FILLERS = re.compile(r"\b(um+|uh+|erm|i mean|you know|kind of|sort of)\b", re.I)
_CONTRACTABLE = re.compile(
    r"\b(i am|it is|that is|there is|do not|does not|did not|can not|cannot|will not|"
    r"is not|are not|was not|i have|you are|we are|they are|i will|you will|let us)\b", re.I)
_CONTRACTION = re.compile(r"\b\w+'(s|re|ve|ll|d|m|t)\b", re.I)
_MARKUP = re.compile(r"(^\s*([-*•]|\d+[.)])\s)|\*\*|#|`|\[.+\]\(", re.M)
_SENT = re.compile(r"[^.!?]+[.!?]*")

# Spoken replies: phone talk runs to one to three short sentences per turn.
# Spontaneous speech carries about 2 to 6 disfluencies per 100 words (published
# corpus counts), so more than 6 fillers per 100 words is a tic, not a person.
# The sentence and turn caps are HYPOTHESIS: talk between pauses is 4 to 6 words
# on phone corpora, and a turn of 45 words already runs past 13 s at phone speed.
MAX_SENTENCE_WORDS = 18
MAX_TURN_WORDS = 45
FILLER_PER_100_MAX = 6.0


def _words(text):
    return re.findall(r"[A-Za-z0-9']+", text or "")


def reply_report(text):
    """The measurable facts about one spoken reply."""
    text = (text or "").strip()
    words = _words(text)
    sents = [s.strip() for s in _SENT.findall(text) if _words(s)]
    first = words[0].lower() if words else ""
    return {
        "words": len(words),
        "sentences": len(sents),
        "max_sentence_words": max((len(_words(s)) for s in sents), default=0),
        "cs_hits": [p.pattern for p in _CS if p.search(text)],
        "markup": bool(_MARKUP.search(text)),
        "contractions": len(_CONTRACTION.findall(text)),
        "uncontracted": len(_CONTRACTABLE.findall(text)),
        "response_token": first if first in RESPONSE_TOKENS else "",
        "fillers": len(_FILLERS.findall(text)),
        # A help-desk sign-off as the last sentence ("Let me know if you need anything!").
        "ends_with_offer": bool(sents and re.search(r"anything else|let me know|need anything",
                                                    sents[-1], re.I)),
    }


def reply_score(text):
    """0..1: how much one reply sounds like a person on the phone. Penalties
    multiply, so one help-desk phrase costs more than a slightly long sentence."""
    r = reply_report(text)
    if not r["words"]:
        return 0.0
    s = 1.0
    s *= 0.55 ** len(r["cs_hits"])
    if r["markup"]:
        s *= 0.5
    if r["ends_with_offer"]:
        s *= 0.8
    if r["max_sentence_words"] > MAX_SENTENCE_WORDS:
        s *= max(0.5, 1 - 0.03 * (r["max_sentence_words"] - MAX_SENTENCE_WORDS))
    if r["words"] > MAX_TURN_WORDS:
        s *= max(0.4, 1 - 0.01 * (r["words"] - MAX_TURN_WORDS))
    total = r["contractions"] + r["uncontracted"]
    if total:
        s *= 0.7 + 0.3 * (r["contractions"] / total)
    if 100.0 * r["fillers"] / r["words"] > FILLER_PER_100_MAX:
        s *= 0.75
    return round(s, 4)


# ---------------------------------------------------------------- timing
# The gap from the caller's last word to Harman's first sound, as the shipped
# speakrail path builds it:
#   endpoint: the box ASR says "complete" after 640 ms of quiet, but only once
#             its transcript has caught up, and it declares 960 ms of lag; the
#             larger of the two binds (VERIFIED from the adapter source).
#   brain:    the whole reply is generated before TTS starts (non-streaming);
#             prefill + tokens / rate. Rates are HYPOTHESIS until measured.
#   tts:      Breeze first audio, 495 ms measured on the box.
ENDPOINT_QUIET_MS = 640
ASR_LAG_MS = 960
BRAIN_PREFILL_MS = 250
BRAIN_TOKENS_PER_S = 30.0
TTS_FIRST_AUDIO_MS = 495
TOKENS_PER_WORD = 1.35
HUMAN_GAP_MS = 236            # mean English gap between turns (cross-language studies)
# The score's zero. Listeners already mark a reply down past 600 to 700 ms, but a
# floor that low would score every reply on today's stack as 0 and hide progress;
# 2.5 s is where a caller starts to wonder if the line dropped (HYPOTHESIS).
SLOW_GAP_MS = 2500


def response_gap_ms(reply_words, endpoint_quiet_ms=ENDPOINT_QUIET_MS, asr_lag_ms=ASR_LAG_MS,
                    prefill_ms=BRAIN_PREFILL_MS, tokens_per_s=BRAIN_TOKENS_PER_S,
                    tts_first_ms=TTS_FIRST_AUDIO_MS):
    """Estimated ms of silence before Harman answers a reply of `reply_words` words."""
    endpoint = max(endpoint_quiet_ms, asr_lag_ms)
    brain = prefill_ms + 1000.0 * reply_words * TOKENS_PER_WORD / tokens_per_s
    return round(endpoint + brain + tts_first_ms)


def gap_score(gap_ms):
    """1 at a human gap, 0 at a gap long enough to sound like a dropped line."""
    if gap_ms <= HUMAN_GAP_MS:
        return 1.0
    return round(max(0.0, 1 - (gap_ms - HUMAN_GAP_MS) / (SLOW_GAP_MS - HUMAN_GAP_MS)), 4)


# ---------------------------------------------------------------- a whole call

def variety(lines):
    """Share of distinct lines among the non-empty `lines` (1 = never repeats)."""
    lines = [l.strip().lower() for l in lines if l and l.strip()]
    return len(set(lines)) / len(lines) if lines else 1.0


def call_score(replies, acks=()):
    """0..100 for one scripted call: `replies` are Harman's spoken answers in order,
    `acks` the holding lines it said while a tool ran. Weights: words 50, speed 30,
    turn openings and ack variety 20 (a call that opens every turn the same way,
    or says the same holding line each time, sounds scripted)."""
    if not replies:
        return {"score": 0.0, "words": 0.0, "speed": 0.0, "variety": 0.0}
    words = sum(reply_score(r) for r in replies) / len(replies)
    speed = sum(gap_score(response_gap_ms(reply_report(r)["words"])) for r in replies) / len(replies)
    tokens = [reply_report(r)["response_token"] for r in replies]
    opened = sum(1 for t in tokens if t) / len(replies)
    # People open a fair share of turns with a response token, not every one;
    # reward 25..75 % and penalise either extreme.
    open_fit = 1.0 if 0.25 <= opened <= 0.75 else 0.5
    used = [t for t in tokens if t]
    var = (open_fit + (variety(used) if used else 1.0) + variety(acks)) / 3
    score = 50 * words + 30 * speed + 20 * var
    return {"score": round(score, 2), "words": round(words, 4),
            "speed": round(speed, 4), "variety": round(var, 4)}
