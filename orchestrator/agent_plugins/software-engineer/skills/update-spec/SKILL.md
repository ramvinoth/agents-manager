---
name: update-spec
description: After a change alters user-visible behaviour, update the feature's Manager spec note so the spec stays the truth. Use when finishing an implementation, fix or refactor that changed behaviour, states, data or interfaces.
---

# Keep the spec true

A spec that drifts from the code is worse than none. Before you call a change done:

1. Did behaviour, a state, stored data or an interface (route, screen, tool) change?
   No → nothing to do. Pure refactor → nothing to do.
2. Yes → `mcp__viewer__note_update` on `Spec: <Feature>`:
   - edit the affected rules in place (no "UPDATE:" appendices),
   - fix the Interfaces section with real paths,
   - add or fix the acceptance test for the new behaviour.
3. Changed something the PRD promised (scope, a goal)? That is a product decision:
   comment on the PRD (`mcp__viewer__note_comment`) and put the card in Review with the
   question — do not edit the PRD yourself.
4. In your card comment, link the spec: "Spec updated: [[Spec: <Feature>]] — <what changed>".
