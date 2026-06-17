# ── Self-hosted host-agent — Docker integration-test image ──────────────
#
# Design of record:
#   docs/superpowers/specs/2026-06-17-self-hosted-execution-plane-design.md
#   ("Testing → Real Docker integration test")
#
# Simulates the USER'S BOX: a minimal Linux container with Node 20 + the
# real, built `codeam-cli` installed globally. The container runs the real
# `codeam host-agent` supervisor as PID-equivalent entrypoint; it enrolls
# against the in-test stub backend, opens the control channel, receives a
# `self_hosted_deploy`, and spawns a real `codeam pair-auto` CHILD — a real
# process tree, not mocks.
#
# Build context = apps/cli (so the pre-built `npm pack` tarball is in scope).
# The test (`host-agent.docker.e2e.test.ts`) builds this image, passing the
# tarball name via the CODEAM_TARBALL build-arg, and runs the container with
# CODEAM_API_URL + CODEAM_ENROLL_TOKEN injected so all outbound traffic hits
# the stub.
#
# Kept small + cache-friendly: a single FROM, deps installed in one layer,
# git present only because `prepareWorkspace` may shell `git clone` (the test
# points at an absolute path so the clone path is not exercised, but git is
# cheap and keeps the image honest about a real box).

FROM node:20-slim

# git: prepareWorkspace clones repo refs (the test uses an absolute path, so
# this is belt-and-suspenders for a faithful "real box"). ca-certificates so
# any https the agent attempts resolves cleanly.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The pre-packed codeam-cli tarball (produced by `npm pack` on the host and
# placed in the build context by the test). Installing the tarball lets npm
# resolve the CLI's runtime dependencies (chokidar, ws, zod, node-pty, …)
# that tsup leaves as external require()s — a bare `dist/` copy would miss
# them. Mirrors the macOS "install-and-help smoke" CI step.
ARG CODEAM_TARBALL=codeam-cli.tgz
COPY ${CODEAM_TARBALL} /tmp/codeam-cli.tgz

# Install globally. The CLI's postinstall is `node dist/postinstall.js ||
# true`, so a missing optional (@beads/bd) never fails the build.
RUN npm install -g --omit=optional /tmp/codeam-cli.tgz \
    && rm -f /tmp/codeam-cli.tgz \
    && codeam --version

# A non-root home so ~/.codeam (sealed host identity, 0600) + ~/.claude
# (provisioned agent creds) land somewhere writable that mirrors a real
# user box rather than /root.
ENV HOME=/home/box
RUN useradd --create-home --home-dir /home/box box
USER box
WORKDIR /home/box

# The supervisor. CODEAM_ENROLL_TOKEN + CODEAM_API_URL are supplied at
# `docker run` time by the test; the host-agent redeems on first run, seals
# the identity, opens the control channel, and supervises children. It runs
# until the container is killed (the test asserts on the stub, then tears the
# container down) — exactly how systemd would hold it on a real box.
ENTRYPOINT ["codeam", "host-agent"]
