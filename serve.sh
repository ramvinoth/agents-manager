#!/bin/bash
# Agents - Start server
# Serves the frontend and session files from ~/.claude/projects
# Accessible over Tailscale
exec python3 "$(dirname "$0")/server.py" "${1:-8091}"
