---
name: spec-to-cards
description: Break a Manager spec note into board cards — one card per shippable slice, each self-contained, with dependencies recorded. Use when the user asks to plan the work, create tickets/cards/tasks from a spec, or "break this down".
---

# Spec → cards

## 1. Read the spec
`mcp__viewer__note_list`, then `mcp__viewer__note` for `Spec: <Feature>`. No spec? Offer
`write-spec` first.

## 2. Slice vertically
Each card is a slice a user could see working (route + UI + test), not a layer
("all the backend"). 1–3 days of work each. Check `mcp__viewer__card_list` first so you
never duplicate a card that exists.

## 3. Create the cards
`mcp__viewer__card_create` into Todo. Each body stands alone for a reader with no context:

```
What: one sentence, plain language
Why: the user outcome, quoting the PRD goal
Done when: the acceptance tests from the spec this slice covers
Spec: [[Spec: <Feature>]]  #feature/<kebab-name>
```

## 4. Order them
`mcp__viewer__card_dep_add` for every real "cannot start until" edge. No edge means the
cards can run in parallel — say so.

## 5. Report
One message: how many cards, the critical path, and anything that needs the owner's
decision before work starts (put that card in Needs-info with the question).
