#!/usr/bin/env python3
"""Entry point for `python3 server.py [PORT]`.

The implementation lives in `orchestrator.server`; `orchestrator.config` reads
PORT from sys.argv (or the PORT env var, default 8091) at import time.
"""
from orchestrator.server import main

if __name__ == "__main__":
    main()
