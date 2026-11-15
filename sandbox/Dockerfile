# The box a sandboxed Harman run leases (orchestrator/runtime/backends/sandbox.py).
# Plain Linux plus the unmodified Claude Code CLI, run as a non root user so
# --permission-mode bypassPermissions is allowed. python3 runs the viewer's MCP
# servers and the folder sync; procps lets the backend signal claude inside.
# Nothing secret is baked in: credentials arrive per run as exec env.
# Build with the CLI version this server runs: --build-arg CLAUDE_CODE_VERSION=$(claude --version | cut -d' ' -f1)
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.322
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# The base image's own non root user (uid 1000).
USER node
# The box idles until the backend execs the run into it.
CMD ["sleep", "infinity"]
