"""Score how human the live call brain sounds, on the regression corpus.

    .venv/bin/python tests/callnatural_sample.py [--runs N] [--json]

Plays every corpus utterance, in order and as one conversation, through the
real call brain (callbrain.call_turn) against the corpus's fixed snapshot, with
tools stubbed so nothing touches the board. Harman says the holding line
(calllive.ack_line) on each turn that runs a tool, as the live bridge does.
Prints callnatural.call_score per run and the mean. It needs the configured
brain to be reachable; it writes nothing.
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestrator import callbrain, callnatural, calllive  # noqa: E402

CORPUS = json.loads((Path(__file__).parent / "callnatural_corpus.json").read_text())
PRINCIPAL = {"actor": "user:eval", "human_role": "owner", "session_level": "", "session": ""}
STUB = {"delegate": "Created card 512.", "comment": "Comment posted.", "decide": "Moved to Approved.",
        "board_status": "Review: 488 Speakrail sound check; 498 Call naturalness loop. Doing: 4. Todo: 11.",
        "card_detail": "Card 488 Speakrail sound check, in Review for 2 hours. Last comment: ready for a listen."}


def one_call():
    history, replies, acks = [], [], []
    for line in CORPUS["utterances"]:
        out = callbrain.call_turn("eval", PRINCIPAL, line, history,
                                  tool_runner=lambda name, args, ctx: STUB.get(name, "ok"),
                                  snapshot_text=CORPUS["snapshot"])
        history = out["history"]
        if out["tools"]:
            acks.append(calllive.ack_line(len(acks)))
        replies.append(out["reply"])
    return replies, acks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    scores = []
    for i in range(a.runs):
        replies, acks = one_call()
        s = callnatural.call_score(replies, acks)
        scores.append(s["score"])
        if a.json:
            print(json.dumps({"run": i, **s, "replies": replies, "acks": acks}))
        else:
            print(f"run {i}: {s}")
            for line, r in zip(CORPUS["utterances"], replies):
                print(f"  > {line}\n    {r}  [{callnatural.reply_score(r)}]")
    print(f"mean {statistics.mean(scores):.2f} over {len(scores)} runs")


if __name__ == "__main__":
    main()
