---
name: read-spec-first
description: Before changing code for a feature or card, find and read its spec and PRD in the project's Harman notes, so the change matches the agreed behaviour. Use at the start of any implementation, bug fix or refactor task.
---

# Read the spec before coding

1. Find the feature: from the card (`#feature/<name>` or a `[[Spec: …]]` link), or
   `mcp__viewer__note_list` and match `#spec` / `#prd` notes by title.
2. Read the spec (`mcp__viewer__note`). Its behaviour rules and acceptance tests are the
   definition of done. Its discussion thread (`mcp__viewer__note_comments`) may hold
   later decisions.
3. No spec? Small fix: proceed and say so. Feature-sized change: ask the owner whether
   to write one (the Product Manager agent's `write-spec`) or proceed from the card.
4. The spec conflicts with what the code must do? Do not silently diverge — comment on
   the spec note (`mcp__viewer__note_comment`) with the conflict and the option you
   recommend, and ask before building the divergent version.
5. Locate the code with `mcp__viewer__code_map` (see `navigate-with-map`) instead of
   reading whole directories.
