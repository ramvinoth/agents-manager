# Contributing

Thanks for your interest in improving Agents. This is a small, dependency-light
project — a Python `http.server` backend (`viewer/`) and a React + Vite frontend
(`web/`). The goal is to keep it that way: readable, modular, and easy to run.

## Development setup

- **Backend**: Python 3.11+. Run `python3 server.py 8091` (or `make serve`).
  The server serves the built frontend from `web/dist` and the API.
- **Frontend**: Node 20+. `cd web && npm install`, then `npm run dev` for the
  Vite dev server, or `make web` to type-check + build into `web/dist`.

## The gate: `make check`

Run `make check` before and after every change — it must stay green. It runs:

| Stage   | What                                                            |
|---------|----------------------------------------------------------------|
| `lint`  | `ruff` (real-defect rules) + Python/JS syntax                  |
| `unit`  | `pytest tests/unit` — fast, hermetic (no server/DB/SSH)        |
| `web`   | `tsc` type-check + Vite production build                       |
| `smoke` | API characterization suite against a running server           |
| `e2e`   | Playwright UI suite against a running server                   |

`smoke` and `e2e` need a running server — start one with `make serve` first.

- **Unit tests** are the fast inner loop: `make unit`. Add one for any pure
  function you touch (adapters, guards, flag builders, parsers). Keep them
  hermetic — no network, DB, or SSH.
- **Remote smoke** is opt-in: the SSH half is skipped unless you pass a host id
  via `make check REMOTE=<host-id>` or set `VIEWER_TEST_REMOTE`.

## Style

- Match the surrounding code. Comments explain the *why*, not the *what*.
- Python: `ruff` clean. Frontend: TypeScript, Tailwind, shadcn/ui.
- Keep modules cohesive and prefer small, testable functions.

## Pull requests

1. Branch from the default branch.
2. Make the change; add/extend a unit test where it applies.
3. Ensure `make check` passes.
4. Open a PR describing what changed and why.
