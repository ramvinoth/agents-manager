---
name: write-prd
description: Write a product requirements document (PRD) for a feature or product idea and save it as a Manager note. Use when the user asks for a PRD, a product brief, requirements, or "what should we build and why".
---

# Write a PRD

A PRD answers WHY and WHAT, never HOW. The reader is someone with no context.

## 1. Look before writing
- `mcp__viewer__note_list` — is there already a `#prd` note for this feature? If so, update it
  (`note_update`) instead of writing a second one.
- Read related notes and open cards so the PRD reflects what exists.

## 2. Ask only what you cannot infer
One question at a time, only for facts that live in the owner's head: the target user,
the business goal, a hard constraint (date, budget, compliance). Everything else, draft
and mark as an assumption.

## 3. Write the note
`mcp__viewer__note_create` with `title: "PRD: <Feature>"` and this body:

```
## Problem — who hurts, how often, what it costs them today
## Users — primary / secondary
## Goals — measurable outcomes (metric, baseline, target)
## Non-goals — what we deliberately will not do
## User stories — "As a <user>, I want <x>, so that <y>", each with acceptance criteria
## Scope — must / should / could (MoSCoW)
## Risks and open questions — each with an owner
## Assumptions — everything you guessed, so the owner can correct it
#prd #feature/<kebab-name>
```

Tags matter: `#prd` makes it findable; `#feature/<name>` links the PRD, its spec and
its cards. Link the spec once it exists with `[[Spec: <Feature>]]`.

## 4. Hand off
Tell the owner, in one line, the note title and the one decision you need from them
(usually: approve scope, or answer one open question).
