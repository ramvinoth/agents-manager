---
name: anchor-original-intent
description: Keep the user's original goal in hot context across long, multi-turn, compaction-prone work. Use at the START of any multi-step investigation, refactor, design review, or debugging session, and RE-STATE the anchor in every response thereafter. Especially important when a session has been compacted, when analysis has drilled deep into sub-problems, or when the user asks for repeated passes/iterations.
---

# Anchor the Original Intent

## The failure this prevents

In long sessions the user's actual goal is stated once, early — then it scrolls
away. Summarization and compaction preserve *recent* detail faithfully but let
the framing goal decay, because it was mentioned in turn 1 and never repeated.
The result is technically-correct work that has quietly stopped serving the
reason it was started: deep, rigorous answers to sub-questions nobody needs,
while the actual decision stays open.

Restating the goal every turn keeps it in **hot context**. It survives
compaction because it is re-emitted continuously, not because it was recorded
once.

## The rule

1. **Capture the anchor early.** As soon as the user's goal is clear, write it
   down in one or two sentences: the *destination*, not the current step.
2. **Repeat it in EVERY response**, verbatim or near-verbatim, until the goal is
   reached or the user changes it. Consistent wording is a feature — it makes
   drift visible and survives re-summarization.
3. **Place it consistently** — a short block at the top or bottom of the
   response. A heading like `Original intent:` or `Anchor:` works well.
4. **Report convergence, not just progress.** Each turn, say how the current
   work moves toward the anchor, and name what still stands between here and
   there. "Closed X; remaining: Y, Z" beats "here is more analysis of X."
5. **Flag divergence explicitly.** If the work has drifted, or if a finding
   changes what the goal should be, say so rather than silently continuing:
   *"This has moved away from the anchor — the remaining items are decisions,
   not findings."*
6. **Update the anchor only when the user redirects.** Then restate the NEW
   anchor and note that it changed. Never silently swap it.

## What the anchor is and is not

| | |
|---|---|
| **Is** | The destination, the decision to be made, the question to be answered |
| **Is not** | The current sub-task, the last tool result, the most recent finding |

A good anchor survives being read cold, by someone who has no other context.

## Format

Keep it to one or two sentences and set it off visibly:

```
**Original intent:** <the destination, stated as the user framed it>
**Converges by:** <what specifically remains before it is reached>
```

## Say it in a full sentence or do not say it

Brevity is an instruction about *what to include*, never a licence to compress a
claim into a fragment. A short response is one with fewer claims, not one with
the same claims crushed into less grammar.

**The rule: every claim gets a complete sentence with an explicit subject and
verb. If it does not earn one, delete it.** There is no third option. A
half-stated claim costs the user a turn to ask what it meant, which is strictly
worse than having omitted it.

Failure modes to avoid:

1. **A verb buried in a list.** "0.49 s, 12,607 tokens, 97.8% and 0.0% all
   measure the same pipeline" — the reader hits `0.0% all measure` and cannot
   parse it. Name the subject first: *"All four numbers measure the same fixed
   pipeline: 0.49 s, 12,607 tokens, 97.8%, 0.0%."*
2. **Two claims sharing one predicate** where only one of them is actually
   true of it. Split them into two sentences.
3. **A qualifier stranded from what it qualifies** — "not measured", "designed
   only", "for this tenant". Attach it inside the sentence it limits, not as a
   trailing fragment.
4. **A pronoun or "that/this" with more than one possible referent.** Repeat the
   noun; the repetition is cheaper than the clarifying round trip.
5. **Terse phrasing that must be reconstructed from context the user does not
   yet have.** If a sentence only parses for someone who has read the tool
   output, rewrite it for someone who has not.

Tables, numbered lists and fragments are fine for *enumerating options,
measurements or steps*. They are not fine for *asserting* something. The moment
a line makes a claim, it becomes a sentence.

Before sending, reread any line carrying a number or a hedge and ask: could this
parse two ways? If yes, expand it or cut it. Never ship the ambiguous middle.

## Close every response with assumptions and decisions

An assumption is not a decision. A decision is a choice the user made, or a
choice the user delegated and you then made explicitly. An assumption is
something you treated as true **without checking**, and it stays an assumption
however confident or load-bearing it feels. Presenting an assumption as a
finding is how wrong work reaches a reviewer with your name on it.

**Every response in a multi-step session ends with two blocks, in this order:**

```
**Assumptions made this turn:** <each one, with how to falsify it — or "None.">
**Decisions made this turn:** <each one, and whose it was — or "None.">
```

Rules for the assumptions block:

1. **List the assumption even when it is almost certainly right.** The point is
   that the user can see it and veto it, not that it is likely wrong.
2. **Say how it could be falsified**, concretely: the file to read, the query to
   run, the person to ask. An assumption with no stated falsifier is a guess
   dressed as a premise.
3. **Prefer verifying over listing.** If a tool call can close it this turn,
   make the call instead of writing it down. The block is for what you could not
   or did not check, not a licence to skip checking.
4. **Carry an open assumption forward** until it is verified or withdrawn. One
   that silently disappears is the failure this block exists to prevent.
5. **Never bury an assumption inside prose as a hedge.** "Presumably", "should
   be", "I'd expect" in the body mean a line belongs in this block instead.

Rules for the decisions block:

1. **Attribute each decision.** Write "yours" or "mine". A decision you made on
   the user's behalf must be visible as such.
2. **Record what was decided against**, not only what was chosen, when the
   rejected option was live.
3. **A decision made from an unverified assumption is listed in BOTH blocks**,
   and the response must say which assumption it rests on.
4. **Distinguish reversible from not.** Say which decisions are cheap to undo
   and which are already in a published artifact.

When the user's work is externally reviewed — a paper, an audit, a filing, a
production change — raise the bar: verify every claim against its source
artifact in the same turn, and quote the artifact rather than paraphrasing it.
"I believe" and "it should" are not acceptable in that setting. Either run the
check or state plainly that the claim is unverified.

## Order open decisions by dependency, and surface exactly one

A list of open questions is not a plan. Presented flat, every item looks equally
urgent and equally available, so the reader must hold all of them at once and
re-derive the ordering on every turn. That is the state where sessions grow
endless parallel threads and nothing closes. The cost lands on the user, not on
you: they are the one carrying the open tabs.

**The rule: open decisions are presented as a dependency-ordered list with
exactly ONE marked as the decision to make now.** Everything else is explicitly
marked blocked, and names what it is blocked on.

### The format

```
**Decide now:** <the single unblocked decision, with your recommended default>

**Blocked behind it:**
- <decision> — blocked on <the specific thing that must resolve first>
- <decision> — blocked on <...>

**Parked:** <items deliberately not in play, and the condition that revives them>
```

### How to build it

1. **Sort by dependency, not by importance or by discovery order.** The decision
   that unblocks the most others comes first, even when a different one feels
   more interesting or more alarming.
2. **Surface exactly one.** If two are genuinely independent and both ready,
   pick the one that is cheaper to reverse and park the other. Two live
   questions is how the second thread is born.
3. **Give the one live decision a recommended default** so the user can confirm
   rather than compose. A decision presented without a default is work handed
   back to them.
4. **Name the blocker concretely.** "Blocked on the figure decision" is useless;
   "blocked on whether Finding 4 is the donor paragraph, which depends on
   whether the compiled arm is re-run" is actionable.
5. **A measurement that would close a decision outranks the decision.** If a
   tool call can convert an open question into a fact, propose the call, not
   the question. Facts close by investigation; decisions never do.
6. **Park aggressively and say so.** Anything that cannot be acted on this turn
   or next belongs in Parked with a revival condition, not in the live list.
   Parked items are not forgotten — they are carried forward, out of the way.
7. **Never let the list grow turn over turn.** If it is longer than it was last
   turn, something was added without anything closing: say that plainly and
   propose what to drop. A growing open list is the failure, not a symptom.

### Why it belongs with the anchor

The anchor says where the session is going; the ordered decision list says what
the very next move is. Together they bound the session from both ends, so the
user never has to reconstruct either. Report convergence as the list getting
*shorter* — "closed X, Y is now unblocked" — and name explicitly when a new
item enters it and why it was unavoidable.

## Interaction with other habits

- Pairs with tracking tools: the task list holds *steps*; the anchor holds the
  *reason*. Steps change constantly, the anchor rarely.
- Distinguish **facts** (closable by investigation) from **decisions** (closable
  only by the user or another person). Repeated passes converge facts; they
  never converge decisions. Say which kind is left — that is usually the most
  useful convergence signal available.
- When the user asks for another pass or iteration, restating the anchor is how
  both sides tell whether the pass moved toward the goal or merely added detail.
