# ── Headroom on-demand — Docker integration-test image ───────────────────────
#
# Test of record: apps/cli/__tests__/integration/headroom-provision.int.test.ts
#
# Simulates a USER'S BOX: Python 3.12 + Node 20 + the real, built codeam-cli
# (including dist/headroom-runner-driver.js). The test runs the REAL
# headroom provisioning flow (pip install, model pre-download, headroom init,
# proxy spawn, and disable/restore) entirely inside this container so the host
# developer's ~/.claude/settings.json and pip environment are never touched.
#
# Build context = apps/cli/__tests__/docker/ (the same tiny, dedicated context
# the host-agent Dockerfile uses). The test copies the npm-packed tarball into
# that directory under a stable name before calling `docker build`.
#
# Key constraints:
#  • Python 3.12 must be present (headroom-ai[proxy,code,image] requires it).
#  • Node 20 for the CLI.
#  • The model pre-download (~840 MB) happens INSIDE the container at runtime,
#    not at image-build time — so cold image builds stay fast.
#  • HOME=/home/box (non-root) so ~/.claude/settings.json and ~/.codeam/ land
#    somewhere writable, exactly as on a real user box.
#
# This image is NOT pushed to any registry; it is built locally by the test.

FROM python:3.12-slim

# ── System deps ───────────────────────────────────────────────────────────────
# nodejs / npm 20: install via NodeSource; ca-certificates for TLS + HuggingFace.
# curl is used by the NodeSource setup script. procps provides `pkill`, which
# the Headroom disable path uses to stop the proxy — python:3.12-slim omits it,
# and its absence is exactly the ENOENT the disable path must survive.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates \
         curl \
         procps \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── CLI install ───────────────────────────────────────────────────────────────
# The pre-packed codeam-cli tarball (produced by `npm pack` + copied into the
# docker build context by the test). Installing it via npm installs the CLI's
# runtime dependencies (chokidar, ws, zod, …) and makes dist/ available at
# `$(npm root -g)/codeam-cli/dist/`.
#
# The headroom-runner-driver.js is NOT part of the published tarball (it is a
# test-only script intentionally excluded from the npm files allowlist). It is
# copied separately from the build context into the global dist/ so that
# `docker exec … node $GLOBAL_ROOT/codeam-cli/dist/headroom-runner-driver.js`
# works inside the container exactly as if it were installed.
ARG CODEAM_TARBALL=codeam-cli.tgz
COPY ${CODEAM_TARBALL} /tmp/codeam-cli.tgz
COPY headroom-runner-driver.js /tmp/headroom-runner-driver.js

RUN npm install -g --omit=optional /tmp/codeam-cli.tgz \
    && rm -f /tmp/codeam-cli.tgz \
    && cp /tmp/headroom-runner-driver.js "$(npm root -g)/codeam-cli/dist/headroom-runner-driver.js" \
    && rm -f /tmp/headroom-runner-driver.js \
    && codeam --version

# ── Non-root user ─────────────────────────────────────────────────────────────
# Mirrors real-user-box semantics: ~/.codeam/, ~/.claude/, ~/.local/ (where pip
# installs to PATH when run as non-root) all land under /home/box.
ENV HOME=/home/box
RUN useradd --create-home --home-dir /home/box box

# ~/.local/bin is where pip --user puts the headroom binary on Linux.
ENV PATH="/home/box/.local/bin:${PATH}"

USER box
WORKDIR /home/box

# Default command: drop to shell. The test calls `docker run … node … enable`
# and `… disable` directly — no daemon entrypoint needed.
CMD ["/bin/bash"]
