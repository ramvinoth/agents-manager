---
name: write-spec
description: Turn an approved PRD into a functional spec saved as a Manager note — behaviour, states, edge cases and acceptance tests an engineer can build from. Use when the user asks for a spec, a functional/technical spec, or "how should this work".
---

# Write a spec

The spec is the contract between product and engineering: precise behaviour, testable.

## 1. Start from the PRD
- `mcp__viewer__note_list`, find `PRD: <Feature>` (tag `#prd`, `#feature/<name>`). No PRD?
  Say so and offer `write-prd` first — a spec without a "why" drifts.
- If a `Spec: <Feature>` note exists, update it; never fork a second spec.
- If the project has a Map lens, `mcp__viewer__code_map` shows the modules this touches.
  Name real paths; do not invent architecture.

## 2. Write the note
`mcp__viewer__note_create` with `title: "Spec: <Feature>"`:

```
Implements [[PRD: <Feature>]]
## Behaviour — numbered rules, each testable ("When X, the system does Y")
## States — every state the feature can be in, and what moves it between them
## Edge cases — empty, huge, offline, concurrent, unauthorized, partial failure
## Data — what is stored, where, retention
## Interfaces — routes / screens / tools touched (real paths from the code map)
## Acceptance tests — Given / When / Then, one per behaviour rule
## Out of scope
#spec #feature/<kebab-name>
```

## 3. Hand off
Offer `spec-to-cards` next. The spec is done when an engineer could build it without
asking you a question.
