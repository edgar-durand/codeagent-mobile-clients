# ── `codeam mcp-run` shim — Docker integration-test image ────────────────────
#
# Test of record: apps/cli/__tests__/integration/mcp-shim.int.test.ts
#
# Simulates a DEPLOYED BOX running an integration MCP server: Python 3.12
# (uv/uvx + the real, pinned mcp-atlassian) + Node 20 + the real, built
# codeam-cli. The test drives `codeam mcp-run jira` end-to-end INSIDE this
# container: fake broker → token → uvx mcp-atlassian==<pin> → JSON-RPC over
# stdio → expiry-driven child restart → post-restart traffic.
#
# ── Determinism strategy (mirrors headroom-provision.Dockerfile) ──────────────
# The network-bound work — NodeSource apt, `pip install uv`, and the uvx
# resolve+download of mcp-atlassian and its ~115 wheels — happens at IMAGE
# BUILD time so Docker layer-caches it. Test-time `uvx mcp-atlassian==X.Y.Z`
# spawns straight from the warm uv cache (offline-fast, a few seconds).
#
# ⚠️ The mcp-atlassian version prewarmed here MUST match the pin in
# packages/shared/src/integrations/registry.ts (jira delivery args). The test
# passes it as a build arg sourced from the registry itself, so a pin bump
# re-warms automatically.
#
# Build context = apps/cli/__tests__/docker/ (same tiny dedicated context as
# the sibling Dockerfiles). The test copies the npm-packed tarball into that
# directory under a stable name before calling `docker build`.
#
# Runs as root (simplest): the manifest lands at /root/.codeam/, the uv cache
# at /root/.cache/uv, and the driver can read /proc/*/environ for the
# token-never-in-argv assertion without permission juggling.
#
# This image is NOT pushed to any registry; it is built locally by the test.

FROM python:3.12-slim

# ── System deps: Node 20 (NodeSource) + procps (`ps` for the argv assertion) ──
RUN set -e; \
    for attempt in 1 2 3; do \
      echo "==> apt-get update + install attempt $attempt"; \
      apt-get update \
      && apt-get install -y --no-install-recommends ca-certificates curl procps \
      && echo "==> apt-get install succeeded" && break; \
      [ "$attempt" -lt 3 ] && echo "==> retrying in 5s..." && sleep 5; \
    done; \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── uv/uvx + prewarm the PINNED mcp-atlassian into the uv cache ───────────────
# `codeam mcp-run` resolves the delivery spec to `uvx mcp-atlassian==<pin>`;
# prewarming here means the test-time spawn never touches the network.
ARG MCP_ATLASSIAN_PIN=mcp-atlassian==0.22.1
RUN set -e; \
    pip install --quiet uv; \
    for attempt in 1 2 3; do \
      echo "==> uvx prewarm ${MCP_ATLASSIAN_PIN} attempt $attempt"; \
      uvx "${MCP_ATLASSIAN_PIN}" --version && break; \
      [ "$attempt" -lt 3 ] && echo "==> retrying in 10s..." && sleep 10; \
    done

# ── CLI install ───────────────────────────────────────────────────────────────
# The pre-packed codeam-cli tarball (npm pack + copied into the build context
# by the test). Installs the real published surface: `codeam` on PATH.
ARG CODEAM_TARBALL=codeam-cli.tgz
COPY ${CODEAM_TARBALL} /tmp/codeam-cli.tgz
RUN npm install -g --omit=optional /tmp/codeam-cli.tgz \
    && rm -f /tmp/codeam-cli.tgz \
    && codeam --version

# ── Driver ────────────────────────────────────────────────────────────────────
# Plain-JS driver (node stdlib only — http server + child_process + /proc
# reads), so unlike the headroom driver it needs no tsup build step.
COPY mcp-shim-driver.js /opt/mcp-shim-driver.js

# Default command: idle. The test starts the container detached and invokes
# `docker exec … node /opt/mcp-shim-driver.js`.
CMD ["/bin/bash"]
