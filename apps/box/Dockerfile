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
# ⚠️ procps (`ps`): LOAD-BEARING for Beads. node:slim ships NO `ps`, and both
#   Dolt (port-conflict check) and bd's shared-server management enumerate
#   processes — without `ps`, Dolt reports "port 3308 is busy but cannot identify
#   the process", bd starts a COMPETING dolt server, and beads provisioning fails
#   ("shared dolt sql-server not up — beads disabled"). apt/dpkg can't run inside
#   the running box (--cap-drop ALL + no-new-privileges), so it MUST be baked here.
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
        procps \
    && rm -rf /var/lib/apt/lists/*

# The non-root box user — created UP FRONT so the in-place chown in the npm RUN
# below can target `box`. ⚠️ Do NOT set `ENV HOME=/home/box` here: the build's
# root RUNs (codeam --version, etc.) would then write config/telemetry to
# /home/box/.codeam as ROOT (0700) → the runtime `box` user gets EACCES on
# host-agent.json and the box crash-loops. HOME stays /root during the build;
# it's set to /home/box only at the very end (below).
RUN useradd --create-home --home-dir /home/box box

# ── codeam-cli + npm-global agents + Beads (→ /usr/local, box-owned) ───────
# ONE RUN: codeam-cli + codex + gemini + @beads/bd, then chown /usr/local
# IN-PLACE (same layer → no duplicate COW layer). box must own these so the
# hourly `npm i -g codeam-cli@latest` self-update works without sudo (the image
# ships none and the entrypoint runs as `box`); the pre-installed agents never
# re-install (findInPath skip), so leaking the prefix to box costs nothing —
# host isolation is entirely the fleet_create_box caller's flags.
#
# ⚠️ **PGlite va aquí, PRE-INSTALADO, y esa es la clave.**
#
# Es Postgres compilado a WASM: corre EN PROCESO, sin demonio, sin Docker y sin
# privilegios. Es la única forma de darle una base de datos a un proyecto
# dentro de una Box, donde `fleet_create_box` prohíbe expresamente
# `--privileged`, el montaje de `docker.sock` y cualquier bind del host — así
# que ahí no hay Docker que valga y un proyecto con Prisma arrancaba sin BD.
#
# `pglite-socket` le pone un puerto TCP hablando el protocolo de Postgres, así
# que para la app es un Postgres normal: su `DATABASE_URL=postgres://…` no
# cambia.
#
# Instalado en la imagen y no al vuelo porque bajarlo en el primer preview
# metería su descarga en el camino crítico del usuario — el mismo motivo por el
# que aquí ya viven el CLI, los agentes y el modelo de Headroom.
ARG CODEAM_CLI_VERSION=latest
RUN npm install -g --omit=optional \
        "codeam-cli@${CODEAM_CLI_VERSION}" \
        @openai/codex \
        @google/gemini-cli \
        opencode-ai \
        @beads/bd \
        @electric-sql/pglite \
        @electric-sql/pglite-socket \
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
    && echo "agent binaries present after install (pre-install is a deploy-speed" \
    && echo "optimization; a missing one is installed on first deploy — NEVER fail the build):" \
    && for b in "${AGENT_HOME}/.local/bin/claude" \
                "${AGENT_HOME}/.local/bin/cursor-agent" \
                "${AGENT_HOME}/.kimi-code/bin/kimi" \
                "${AGENT_HOME}/.local/bin/coderabbit"; do \
         if [ -x "$b" ]; then echo "  OK   $b"; else echo "  MISS $b (installs on first deploy)"; fi; \
       done

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

# ── Integration MCP servers — launchers + packages, pre-fetched ────────────
# Same rule as pglite/Headroom above, for the reason the agent makes expensive:
# it starts EVERY advertised MCP server inside `session/new` and gives each one
# a fixed budget (`MCP_TIMEOUT`; 30 s by default — see `MCP_STARTUP_TIMEOUT_MS`
# in the CLI). Our servers run through the `codeam mcp-run` shim, whose cold
# start had to fetch the vendor's package (`npx -y <pkg>@<version>`) — and, for
# jira/confluence, INSTALL `uv` first via `curl … astral.sh/uv/install.sh | sh`,
# a 180 s installer inside a 30 s budget. With a dozen integrations linked and
# one core, the slow ones ran out of budget and the agent filed them as
# `Server "<id>" is not connected`, with no retry for the rest of the session
# (rafaelph90.br@gmail.com, 2026-09-03: clickup, trello and postman all dead
# that way while `session/new` itself reported ok).
#
# ⚠️ THE PACKAGE LIST IS NOT WRITTEN HERE. `codeam mcp-warm` derives it from the
# registry the shim itself resolves at runtime (`@codeam/shared`), so adding or
# re-pinning an integration warms the right thing automatically. A list copied
# into this file would drift on the next version bump — and a cache warmed for
# the WRONG version is worse than a cold one, because it looks warm and still
# downloads.
#
# ⚠️ VOLUME-SHADOW RULE: the caches CANNOT live under $HOME. npm's default is
# `~/.npm` and uv's is `~/.local/share/uv`, both of which the runtime
# `-v codeam-box-<userId>:/home/box` mount would shadow — the bake would be
# invisible and every box would download from scratch anyway. They are moved to
# /opt via env, which the runtime inherits, so the shim's `npx`/`uvx` read the
# baked cache. Moving npm's cache also makes the hourly codeam-cli self-update
# hit a warm cache instead of an empty one.
#
# ⚠️ SIZE RULE: the warm runs AS `box`, not as root, so the files land
# box-owned and there is no `chown -R` of a multi-hundred-MB tree (which would
# duplicate the whole cache into another layer). `box` needs write access at
# runtime too — `npx` links each package into `_npx/` on first use.
#
# Measured on the real base (node:22-slim, aarch64, one package):
#   npx --offline  before warming .............. FAILS (the download is real)
#   npx -y --package <pkg> -c true ............. 16 s
#   npx --offline  after warming ............... 0 s, no network
# 16 s × every linked integration, racing on one core, against a 30 s
# per-server budget — that is the arithmetic that killed clickup/trello/postman.
#
# ⚠️ NEVER FAILS THE BUILD — same contract as the curl-installer agents above.
# A package that misses here is fetched at runtime exactly as it is today, and
# `mcp-warm` is absent from CLI versions older than 2.73.4, so an older pinned
# CODEAM_CLI_VERSION must build fine (it just reports MISS).
ENV npm_config_cache=/opt/npm-cache
ENV UV_CACHE_DIR=/opt/uv-cache
ENV UV_TOOL_DIR=/opt/uv-tools
ENV UV_NO_MODIFY_PATH=1
RUN install -d -o box -g box /opt/npm-cache /opt/uv-cache /opt/uv-tools \
    && (curl -LsSf --connect-timeout 15 --max-time 300 https://astral.sh/uv/install.sh \
          | env UV_INSTALL_DIR=/usr/local/bin sh || true) \
    && echo "uv (jira/confluence launcher; a MISS here means mcp-run installs it on first use):" \
    && (command -v uv >/dev/null 2>&1 && echo "  OK   $(uv --version)" || echo "  MISS uv") \
    && su box -s /bin/sh -c 'HOME=/home/box codeam mcp-warm' || true

# ── PATH: expose the curl-installer bin dirs under the runtime HOME=/home/box ─
ENV PATH="/opt/agents/.local/bin:/opt/agents/.kimi-code/bin:/opt/agents/bin:${PATH}"

# Runtime HOME + final ownership. Set HOME here (NOT earlier — see the useradd
# note) so the box's sealed identity lands in /home/box/.codeam. `chown -R
# /home/box` guarantees `box` owns its entire home even if a build step left a
# root-owned dotdir there; it's a tiny tree (skeleton + telemetry), no COW bloat.
ENV HOME=/home/box
RUN chown -R box:box /home/box

USER box
WORKDIR /home/box

# The supervisor. Enrolls on first boot from CODEAM_ENROLL_TOKEN, then re-opens
# the control channel from the sealed identity on every subsequent start.
ENTRYPOINT ["codeam", "host-agent"]
