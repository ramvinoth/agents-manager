# Review-fix loop — plan

Backup: branch `backup/pre-review-fixes` @ `5127f63`. Restore with
`git reset --hard backup/pre-review-fixes` if anything regresses.

Working branch: `voice-mode`. Fix ONE item per loop tick, verify, then commit.
Never batch unrelated fixes into one commit. After every code change run the
relevant gate before committing:
- Python (viewer/deploy): `python3 -c "import ast; ast.parse(open('<file>').read())"`
  + `ruff check <file>` if available; restart `make serve` only when testing behavior.
- Mobile (TS): `cd mobile-app && npm run check` (tsc + unit tests) — MUST be clean.
- Do NOT ship to TestFlight per tick; batch a single ship at the end if mobile changed.

## Order (highest leverage first)

### Tier 1 — Security (small, exploitable)
- [ ] S1 `adapters.py:34` — replace `startswith` guard with component check (`is_relative_to`/`in .parents`).
- [ ] S2 `fs.py:40` (+upload/compress) — deny secret files (~/.viewer-*.json, ~/.claude dotfiles) from download.

### Tier 2 — Thread-safety / data-loss (server)
- [ ] B1 `engine.py` SESSION_META — add dedicated lock around all read/mutate/save.
- [ ] B2 `engine.py` StatCache + `db.py` _session_cache — lock; bound _session_cache.

### Tier 3 — Real client/audio bugs
- [ ] B5 `useAssistantTurn.ts` — restore volume to 1.0 on teardown + top of playToEnd (ducking stick).
- [ ] B6 `voice.ts` — setVadThreshold also updates _endpointOpts.floorDb.
- [ ] B3 `ThreadScreen.tsx` — in-flight guard on poll loop.
- [ ] B4 `ThreadScreen.tsx` — reconcile optimistic bubbles by identity, not text.

### Tier 4 — Clean-code (low risk, do as reached)
- [ ] C2 dead code: sendMode/notifiedInput (ThreadScreen), customrun host/mode, unused imports.
- [ ] D3 fs.py — one _safe_name() helper (dedupe 4×).
- [ ] C1 save_json_file — log write failures instead of silent pass.

### Tier 5 — Architecture refactors (larger; only if loop reaches them)
- [ ] A4 engine.py — _new_job/_run_env/_finalize dedupe of start_*_run.
- [ ] A1/A2 god-file splits (engine.py, ThreadScreen.tsx) — biggest, do last / may defer.

## Regression guard
Each tick: change → verify gate → `git commit` with a scoped message. If a gate
fails and can't be fixed in the same tick, `git checkout -- <file>` to revert that
item and move on; never leave the tree broken between ticks.
