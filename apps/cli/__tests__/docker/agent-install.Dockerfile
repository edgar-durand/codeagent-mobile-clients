# ── Per-agent REAL install — Docker integration-test image ──────────────────
#
# Test of record: apps/cli/__tests__/integration/agent-install.int.test.ts
#
# Reproduces the exact box shape the stale-PATH / half-finished-install class
# (fleet-1, 2026-08-14) was found on, so the gate can never be vacuous:
#
#  • Base + system deps MIRROR apps/box/Dockerfile (the production fleet image):
#    node 20 + git + ca-certificates + curl + unzip + xz-utils + python3 +
#    procps. Each is load-bearing for at least one agent installer —
#    coderabbit's install.sh hard-requires unzip AND git and aborts before
#    downloading anything when either is missing.
#
#  • A NON-ROOT user with a real HOME. `npm config set prefix ~/.local` puts
#    every `npm install -g` under /home/agent/.local — which is precisely what
#    the fleet-1 box did, and precisely why the daemon's PATH could never see
#    the installed `codex`.
#
#  • The test then execs the driver with a deliberately MINIMAL, systemd-like
#    PATH (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin). NOTHING here
#    adds an agent bin dir to PATH — if the image pre-seeded ~/.local/bin the
#    whole gate would prove nothing.
#
# The image is built by the test (or reused via AGENT_INSTALL_IMAGE_TAG) and is
# never pushed to a registry. Build context = apps/cli/__tests__/docker/.

FROM node:20-slim

# Retry loop guards transient apt mirror hiccups (same pattern as
# headroom-provision.Dockerfile).
RUN set -e; \
    for attempt in 1 2 3; do \
      echo "==> apt-get update + install attempt $attempt"; \
      apt-get update \
      && apt-get install -y --no-install-recommends \
           git \
           ca-certificates \
           curl \
           unzip \
           xz-utils \
           python3 \
           python3-pip \
           procps \
      && echo "==> apt-get install succeeded" && break; \
      [ "$attempt" -lt 3 ] && echo "==> retrying in 5s..." && sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*

# ── codeam-cli (root, /usr/local) ────────────────────────────────────────────
# Installs the CLI's runtime dependency tree so the driver bundle can resolve
# its externals. `--omit=optional` skips the ~250 MB Claude SDK platform
# binary: no case in this gate touches claude (its binary ships with the SDK
# and has no install snippet).
#
# agent-install-driver.js is test-only and excluded from the npm `files`
# allowlist, so it is copied in separately — exactly like the headroom driver.
ARG CODEAM_TARBALL=codeam-cli.tgz
COPY ${CODEAM_TARBALL} /tmp/codeam-cli.tgz
COPY agent-install-driver.js /tmp/agent-install-driver.js
# ⚠️ The install and the driver copy MUST fail the build if they fail — a
# missing driver would turn every agent case into an unparseable-output error
# that looks like a vendor problem. Only the informational resolve probe is
# allowed to be non-fatal, so its `|| true` is scoped to its own RUN line.
RUN npm install -g --omit=optional /tmp/codeam-cli.tgz \
    && rm -f /tmp/codeam-cli.tgz \
    && cp /tmp/agent-install-driver.js "$(npm root -g)/codeam-cli/dist/agent-install-driver.js" \
    && rm -f /tmp/agent-install-driver.js \
    && test -s "$(npm root -g)/codeam-cli/dist/agent-install-driver.js"
RUN node -e "require.resolve('codeam-cli/package.json')" >/dev/null 2>&1 || true

# ── Non-root user with a per-user npm prefix (the fleet-1 shape) ─────────────
RUN useradd --create-home --home-dir /home/agent agent \
    && printf 'prefix=/home/agent/.local\n' > /home/agent/.npmrc \
    && chown agent:agent /home/agent/.npmrc

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent

# ⚠️ Deliberately NO `ENV PATH=...` line. The test supplies the minimal,
# systemd-like PATH on the `docker exec`; adding an agent bin dir here would
# make every probe assertion vacuous.

CMD ["sleep", "infinity"]
