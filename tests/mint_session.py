#!/usr/bin/env python3
"""Print a login-session token for the test suite (the Makefile's e2e target
passes it to Playwright as the session cookie). The account + its per-machine
random secret are managed by tests/ci_auth.py."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ci_auth import mint  # noqa: E402

print(mint())
