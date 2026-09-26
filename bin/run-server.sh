#!/bin/bash
# agents-manager server launcher for launchd.
# Runs the web app on :8091 with the custom-login bypass enabled.
set -e
cd "$HOME/agents-manager"
export VIEWER_ASSUME_LOGGED_IN=1
exec /usr/bin/python3 server.py 8091
