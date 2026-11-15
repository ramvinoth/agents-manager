# The sandbox image a Harman turn leases. Plain Linux plus the unmodified Claude Code
# CLI, run as a non root user so --permission-mode bypassPermissions is allowed.
# Nothing secret is baked in: credentials arrive per turn as exec env.
FROM node:24-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.322
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && mkdir /work && chown node:node /work

# The base image's own non root user (uid 1000).
USER node
WORKDIR /work
# The lease keeps the box idle until the control plane execs a turn into it.
CMD ["sleep", "infinity"]
