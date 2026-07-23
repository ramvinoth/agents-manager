#!/usr/bin/env python3
"""Launcher — the implementation lives in the `viewer` package.

Kept as the entry point so `python3 server.py [PORT]` and the systemd/`make
serve` invocation are unchanged. `viewer.server` reads PORT from sys.argv at
import time, exactly as before.
"""
from viewer.server import main

if __name__ == "__main__":
    main()
