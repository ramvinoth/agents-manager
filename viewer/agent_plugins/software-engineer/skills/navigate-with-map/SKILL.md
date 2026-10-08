---
name: navigate-with-map
description: Navigate an unfamiliar or large codebase through the project's code Map (mcp__viewer__code_map) — modules, folders, files, classes and imports — before opening files. Use when locating where to change something, assessing the blast radius of a change, or explaining architecture.
---

# Navigate with the Map

Reading whole directories burns tokens; the Map is a pre-parsed index of the project.

1. `mcp__viewer__code_map` with `level: "project"` — top-level modules and how they
   depend on each other (edge weights = import counts).
2. Drill in: `level: "folder", path: "<folder>"` → its files and their imports;
   `level: "file", path: "<file>"` → its classes, functions and line numbers.
3. Open only the files the Map points at, at the line it gives.
4. Blast radius: in the folder view, every file importing yours is a caller to check.
5. Limits: the Map is exact for modules, imports and definitions; call relationships
   are not in it. It covers this machine's projects only. If it says the code map is
   not installed, fall back to grep.
6. Spot a layering fault (a core module importing an HTTP/route layer, a cycle)?
   Mention it on the card — the Map makes these visible on purpose.
