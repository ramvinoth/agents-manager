# Agents — developer gate.
#
# `make check` runs the whole net: lint (ruff + Python/JS syntax + React build)
# + the API smoke suite + the React UI e2e. Run it before and after any change.
#
# The smoke & e2e targets need a running server; `make serve` (re)starts one,
# and the test targets fail with a clear message if nothing is listening.

PORT   ?= 8091
BASE   ?= http://localhost:$(PORT)
# Remote host id for the smoke suite's SSH half. Empty by default (no machine-
# specific id in the repo); set VIEWER_TEST_REMOTE or `make check REMOTE=<id>`
# to exercise the remote path — otherwise the remote checks are skipped.
REMOTE ?= $(VIEWER_TEST_REMOTE)
NODE_PATH := $(shell npm root -g)

.DEFAULT_GOAL := help
.PHONY: help lint unit web smoke e2e test check serve _up

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

lint:  ## Ruff (real defects only) + Python & JS syntax
	ruff check .
	python3 -m py_compile server.py viewer/*.py tests/*.py tests/unit/*.py
	@for f in tests/*.js; do echo "  node --check $$f"; node --check "$$f" || exit 1; done
	@echo "lint: OK"

unit:  ## Fast hermetic unit tests (pure functions; no server/DB/SSH)
	python3 -m pytest tests/unit -q

web:  ## Type-check + build the React app (web/ → web/dist)
	cd web && npm run build

smoke:  ## API characterization suite (needs a running server)
	@$(MAKE) --no-print-directory _up
	python3 tests/smoke.py $(BASE) $(REMOTE)

e2e:  ## React UI suite against the live server (the default UI)
	@$(MAKE) --no-print-directory _up
	VIEWER_SESSION=$$(python3 tests/mint_session.py) NODE_PATH=$(NODE_PATH) node tests/e2e-react.js $(BASE) Mac

test: smoke e2e  ## smoke + React e2e

check: lint unit web test  ## Full gate: lint + unit + React build + smoke + e2e

serve:  ## (Re)start the production server on $(PORT) [React UI]
	-fuser -k $(PORT)/tcp 2>/dev/null; sleep 1
	env -u ANTHROPIC_MODEL nohup python3 server.py $(PORT) > /tmp/agents.log 2>&1 & sleep 2
	@curl -sf -o /dev/null $(BASE)/ \
	  && echo "serve: up on $(PORT)" || (echo "serve: FAILED — see /tmp/agents.log"; exit 1)

_up:
	@curl -sf -o /dev/null $(BASE)/ \
	  || (echo "No server at $(BASE) — run 'make serve' first."; exit 1)
