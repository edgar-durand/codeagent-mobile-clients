# ── codeam-box — CodeAgent Box rescue-fleet runtime image ──────────────────
#
# Design of record:
#   docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md
#   docs/superpowers/plans/2026-07-15-fleet-p2-clients.md (Task 2)
#
# The fleet host (`fleet_create_box` handler in apps/cli/src/commands/host-agent.ts)
# `docker run`s ONE of these per rescued user. That handler owns EVERY isolation
# flag (--cap-drop ALL, no-new-privileges, memory/cpus/pids caps, the isolated
# fleet-net network, a single named volume at /home/box, the com.codeagent.*
# labels) — this image contributes only the non-root user + entrypoint half of
# that contract; it never enforces its own isolation.
#
# ── Runtime env contract (set by fleet_create_box, `-e KEY=value`) ────────
#   CODEAM_ENROLL_TOKEN  (required) single-use enroll token; redeemed on first
#                        boot and sealed into ~/.codeam/host-agent.json. NEVER logged.
#   CODEAM_API_URL       (required) backend origin for control channel + heartbeat.
#   REPO_URL / GIT_TOKEN (optional) private-repo clone creds (env, never argv).
#
# ── Pre-installed agents + tooling (deploy-speed optimization) ─────────────
# EVERY supported agent CLI (claude-code, codex, cursor-agent, coderabbit,
# gemini, kimi, aider), the GitHub + GitLab CLIs (gh, glab), and Beads + Dolt +
# Headroom (with its Kompress ONNX model pre-warmed) are baked into the image so
# a rescued user's FIRST deploy skips the per-session installs entirely (each of
# those otherwise shells out to a curl|sh / pip / npm installer on first use;
# Headroom's model download alone is ~840 MB). A box boots agent-ready. The
# deploy provisioners are all skip-if-present (agents/beads/dolt via findInPath;
# Headroom via the baked-image guard in headroom-bootstrap.ts), so the bake is
# actually skipped at deploy time rather than re-run.
#
# ⚠️ VOLUME-SHADOW RULE (load-bearing): at runtime the box mounts
# `-v codeam-box-<userId>:/home/box`, which SHADOWS anything baked under
# /home/box. So NOTHING here lives under /home/box — every binary + the model
# cache go to NON-home locations that survive the mount:
#   • npm-global agents + codeam-cli → /usr/local/{lib,bin}
#   • curl-installer agents (claude/cursor/kimi/coderabbit) → /opt/agents
#   • dolt / aider / headroom / gh / glab → /usr/local/bin
#   • Headroom's HF model cache → /opt/hf-cache (HF_HOME)
#
# ⚠️ SIZE RULE: NEVER `chown -R` a large tree in its own RUN — Docker's
# copy-on-write duplicates every touched file into a new layer (a standalone
# `chown -R /opt/hf-cache` once doubled the image by ~5 GB). The models +
# /opt/agents are read-only at runtime (box only needs read/execute → the
# default root-owned 0755 suffices), so they are NEVER chowned. Only
# /usr/local/{lib,bin} needs `box` ownership (the hourly codeam-cli self-update
# runs `npm i -g` without sudo), and that chown is done IN-PLACE inside the same
# RUN that installs the packages, so it adds no duplicate layer.
#
# Build (the release pipeline pins CODEAM_CLI_VERSION to the tag being cut):
#   docker build --build-arg CODEAM_CLI_VERSION=2.61.33 -t codeam-box:2.61.33 apps/box

FROM node:22-slim

# System deps:
# git/ca-certificates: prepareWorkspace clones the rescued user's repo.
# curl/unzip/xz-utils: the agent + dolt/glab installers are curl|sh recipes;
#   coderabbit downloads a zip (unzip); dolt's tarball is xz.
# python3/python3-pip/python3-venv: aider + headroom are pip packages, and the
#   rescued project's own native-addon build (node-gyp) needs python3.
# build-essential: C toolchain for node-gyp / native pip wheels.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        unzip \
        xz-utils \
        python3 \
        python3-pip \
        python3-venv \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

# The non-root box user + the volume mount point — created UP FRONT so the
# in-place chown in the npm RUN below can target `box`.
ENV HOME=/home/box
RUN useradd --create-home --home-dir /home/box box

# ── codeam-cli + npm-global agents + Beads (→ /usr/local, box-owned) ───────
# ONE RUN: codeam-cli + codex + gemini + @beads/bd, then chown /usr/local
# IN-PLACE (same layer → no duplicate COW layer). box must own these so the
# hourly `npm i -g codeam-cli@latest` self-update works without sudo (the image
# ships none and the entrypoint runs as `box`); the pre-installed agents never
# re-install (findInPath skip), so leaking the prefix to box costs nothing —
# host isolation is entirely the fleet_create_box caller's flags.
ARG CODEAM_CLI_VERSION=latest
RUN npm install -g --omit=optional \
        "codeam-cli@${CODEAM_CLI_VERSION}" \
        @openai/codex \
        @google/gemini-cli \
        @beads/bd \
    && codeam --version \
    && npm cache clean --force \
    && chown -R box:box /usr/local/lib/node_modules /usr/local/bin

# ── curl-installer agents → /opt/agents (root-owned 0755; box executes) ────
# Each installer honours $HOME for its drop dir, so building with HOME=/opt/agents
# lands them under /opt/agents/.local/bin (claude, cursor, coderabbit) and
# /opt/agents/.kimi-code/bin (kimi) instead of the runtime-shadowed /home/box.
# Wrapped in `|| true` (several exit non-zero cosmetically after a verified
# install); the authoritative check is the explicit `ls` — the build fails only
# if an agent is genuinely missing.
ENV AGENT_HOME=/opt/agents
RUN mkdir -p "${AGENT_HOME}" \
    && (HOME="${AGENT_HOME}" bash -c 'curl -fsSL --connect-timeout 15 --max-time 300 https://claude.ai/install.sh | bash' || true) \
    && (HOME="${AGENT_HOME}" bash -c 'curl -fsS  --connect-timeout 15 --max-time 300 https://cursor.com/install | bash' || true) \
    && (HOME="${AGENT_HOME}" bash -c 'curl -fsSL --connect-timeout 15 --max-time 300 https://code.kimi.com/kimi-code/install.sh | bash' || true) \
    && (HOME="${AGENT_HOME}" sh   -c 'curl -fsSL --connect-timeout 15 --max-time 300 https://cli.coderabbit.ai/install.sh | sh' || true) \
    && echo "verifying agent binaries landed…" \
    && ls -l "${AGENT_HOME}/.local/bin/claude" \
             "${AGENT_HOME}/.local/bin/cursor-agent" \
             "${AGENT_HOME}/.kimi-code/bin/kimi" \
             "${AGENT_HOME}/.local/bin/coderabbit"

# ── aider (pip) ────────────────────────────────────────────────────────────
# Debian's system Python is PEP-668 "externally managed" → --break-system-packages
# (the container is single-user; no other Python consumer to protect).
RUN pip install --no-cache-dir --break-system-packages aider-chat

# ── Dolt (beads memory backend; server-mode @beads/bd needs a standalone dolt) ─
RUN curl -L --connect-timeout 15 --max-time 300 \
        https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash \
    && dolt version

# ── GitHub (gh) + GitLab (glab) CLIs — part of the generic base stack ──────
# Every box clones + operates on the rescued user's repo; gh/glab give the agent
# first-class PR/MR + auth tooling. The GitLab deploy path specifically shells
# out to `glab` for clone/auth (mirrors apps/cli/src/commands/host/git-tooling.ts).
RUN set -eux; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    GLAB_VER="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' \
        | grep -oE '"tag_name":"v?[0-9.]+"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"; \
    GLAB_VER="${GLAB_VER:-1.54.0}"; \
    curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VER}/downloads/glab_${GLAB_VER}_linux_amd64.tar.gz" -o /tmp/glab.tgz; \
    mkdir -p /tmp/glab && tar -xzf /tmp/glab.tgz -C /tmp/glab; \
    install -m 0755 "$(find /tmp/glab -type f -name glab | head -1)" /usr/local/bin/glab; \
    rm -rf /tmp/glab /tmp/glab.tgz; \
    gh --version; glab --version

# ── Headroom (token-compression proxy) + pre-warmed ONNX model ─────────────
# `[proxy,code]` = the self-hosted surface (HEADROOM_EXTRAS_BY_SURFACE.selfHosted),
# which is exactly what a box's deploy uses. It pulls the ONNX backend, NOT torch
# (multi-GB, cold-on-first-prompt). The Kompress model is pre-downloaded into
# HF_HOME with the SAME allow_patterns the runtime uses (@codeam/shared's
# HEADROOM_MODELS), so the layout is a byte-identical cache HIT at deploy time AND
# the image skips the multi-GB torch .safetensors artifacts. /opt/hf-cache stays
# root-owned (box only reads it → NO chown, avoiding a duplicate layer).
ENV HF_HOME=/opt/hf-cache
ENV HEADROOM_KOMPRESS_BACKEND=onnx_cpu
RUN pip install --no-cache-dir --break-system-packages \
        "headroom-ai[proxy,code]" fastapi uvicorn "httpx[http2]" websockets zstandard "huggingface-hub[cli]" \
    && python3 - <<'PY'
from huggingface_hub import snapshot_download
# BYTE-IDENTICAL to the runtime pre-download (HEADROOM_MODELS + allow_patterns in
# @codeam/shared's headroom manifest) → guaranteed cache HIT at deploy time.
snapshot_download("chopratejas/kompress-v2-base", allow_patterns=["*.json", "onnx/*.onnx", "kompress-int8-wo.onnx"])
snapshot_download("answerdotai/ModernBERT-base", allow_patterns=["*.json", "tokenizer*", "*.txt", "vocab*", "merges*"])
PY

# ── PATH: expose the curl-installer bin dirs under the runtime HOME=/home/box ─
ENV PATH="/opt/agents/.local/bin:/opt/agents/.kimi-code/bin:/opt/agents/bin:${PATH}"

USER box
WORKDIR /home/box

# The supervisor. Enrolls on first boot from CODEAM_ENROLL_TOKEN, then re-opens
# the control channel from the sealed identity on every subsequent start.
ENTRYPOINT ["codeam", "host-agent"]
