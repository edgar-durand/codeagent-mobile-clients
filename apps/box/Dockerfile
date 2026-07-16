# ── codeam-box — CodeAgent Box rescue-fleet runtime image ──────────────────
#
# Design of record:
#   docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md
#   docs/superpowers/plans/2026-07-15-fleet-p2-clients.md (Task 2)
#
# Forked from the Docker E2E test fixture
# (apps/cli/__tests__/docker/host-agent.Dockerfile) — production-shaped:
# the box additionally carries python3 + build-essential so the rescued
# user's project (in-app Preview dependency install, node-gyp native addons,
# etc.) can actually build inside the container, not just run `codeam`.
#
# The fleet host (infra/fleet/setup-vps.sh in the codeagent-mobile repo)
# `docker run`s ONE of these per rescued user via the `fleet_create_box`
# control-plane handler (apps/cli/src/commands/host-agent.ts). That handler
# owns EVERY isolation flag (--cap-drop ALL, --security-opt
# no-new-privileges, memory/cpus/pids caps, the isolated `fleet-net`
# network, a single named volume mounted at /home/box, the
# com.codeagent.* ops labels) — this image contributes only the non-root
# user + entrypoint half of that contract; it is never trusted to enforce
# its own isolation.
#
# ── Runtime env contract (set by fleet_create_box, `-e KEY=value`) ────────
#
#   CODEAM_ENROLL_TOKEN   (required) Single-use self-hosted enroll token
#                         minted for the rescued user. The `codeam
#                         host-agent` entrypoint redeems it on first boot
#                         and seals the resulting host identity into
#                         ~/.codeam/host-agent.json (0600) on the box's own
#                         named volume, so a stop/start (sleep/wake) reuses
#                         it without re-enrolling. NEVER logged.
#
#   CODEAM_API_URL        (required) The backend origin the box's control
#                         channel + heartbeat + preview/beads calls all
#                         target (e.g. https://api.codeagent-mobile.com).
#
#   REPO_URL / GIT_TOKEN  (optional) When the rescued user's deploy clones a
#                         private repo the box can't read with ambient git
#                         auth, these are threaded the same way a normal
#                         self-hosted deploy passes a clone token. GIT_TOKEN
#                         is delivered via env, NEVER argv, NEVER logged.
#
# Build (pin the CLI version being released — defaults to @latest so a
# manual build always picks up the current npm release):
#
#   docker build --build-arg CODEAM_CLI_VERSION=2.61.0 -t codeam-box:2.61.0 apps/box
#
# The image carries NO credentials, NO backend URL, and NO fleet-specific
# config baked in — every box is generic; identity comes entirely from the
# env vars above at `docker run` time.

FROM node:20-slim

# git + ca-certificates: prepareWorkspace clones the rescued user's repo.
# python3 + build-essential: the rescued project's own `npm install` /
# in-app Preview dependency pre-flight may need to build native addons
# (node-gyp) — a bare node:20-slim lacks a C toolchain.
# curl: the CodeRabbit CLI install path is `curl -fsSL …/install.sh | sh`
# (apps/cli/src/agents/coderabbit/installer.ts). node:20-slim ships without
# curl, so a rescued user setting up CodeRabbit on the box got an endless
# "Restoring…/First-time setup…" spinner (the install could never run).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install codeam-cli from npm. Unpinned (@latest) by default so a plain
# `docker build` always tracks the current release; the fleet's release
# pipeline pins CODEAM_CLI_VERSION to the tag being cut (see the plan's
# "Release" section) so a fleet rollout is reproducible.
ARG CODEAM_CLI_VERSION=latest
RUN npm install -g --omit=optional "codeam-cli@${CODEAM_CLI_VERSION}" \
    && codeam --version

# A non-root home. This is the mount point for the box's named volume
# (fleet_create_box: `-v codeam-box-<userId>:/home/box`) — the rescued
# user's ENTIRE persisted state (sealed host identity, cloned workspace,
# agent credentials) lives here and nowhere else is writable.
ENV HOME=/home/box
RUN useradd --create-home --home-dir /home/box box
USER box
WORKDIR /home/box

# The supervisor. Runs until the fleet host stops/removes the container
# (sleep-on-idle / reap); enrolls on first boot from CODEAM_ENROLL_TOKEN,
# then re-opens the control channel from the sealed identity on every
# subsequent start.
ENTRYPOINT ["codeam", "host-agent"]
