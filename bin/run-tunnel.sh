#!/bin/bash
# Cloudflare tunnel launcher for launchd.
# --retries pushes past the periodic edge handshake resets we see on this network.
exec /opt/homebrew/bin/cloudflared tunnel \
  --config "$HOME/.cloudflared/config.yml" \
  --retries 20 --grace-period 30s \
  run mac
