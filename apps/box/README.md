# codeam-box

Production runtime image for the **CodeAgent Box rescue fleet** — the
per-user container a `fleet_create_box` command spins up on the shared
fleet VPS when a user is rescued from a broken local dev environment.

Design of record:
[`docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md`](../../../docs/superpowers/specs/2026-07-15-fleet-inhouse-selfhosted-rescue-design.md)
(in the container repo alongside this one).

## What this image is

`node:20-slim` + git + ca-certificates + python3 + build-essential, a
non-root `box` user (`HOME=/home/box`), `codeam-cli` installed globally from
npm, entrypoint `codeam host-agent`. It is otherwise **identical** to any
other self-hosted `codeam host-agent` box — the fleet's per-user isolation
comes entirely from how the fleet host `docker run`s the container (see
below), not from anything inside the image itself.

## Build

```bash
# Track the current npm release (default):
docker build -t codeam-box:latest apps/box

# Pin to a specific codeam-cli version (what the fleet release pipeline does):
docker build --build-arg CODEAM_CLI_VERSION=2.61.0 -t codeam-box:2.61.0 apps/box
```

## Runtime env contract

The fleet host's `fleet_create_box` handler
(`apps/cli/src/commands/host-agent.ts`) sets these via `docker run -e`:

| Var | Required | Purpose |
|---|---|---|
| `CODEAM_ENROLL_TOKEN` | yes | Single-use self-hosted enroll token minted for the rescued user. The `codeam host-agent` entrypoint redeems it on first boot and seals the resulting host identity to `~/.codeam/host-agent.json` (0600) — on the box's own named volume, so a later sleep/wake (`docker stop` / `docker start`) reuses it without re-enrolling. **Never logged.** |
| `CODEAM_API_URL` | yes | The backend origin for the control channel, heartbeat, and preview/beads calls (e.g. `https://api.codeagent-mobile.com`). |
| `REPO_URL` | no | When the rescued user's deploy targets a private repo the box can't clone with ambient git auth. Threaded the same way a normal self-hosted deploy passes a repo target. |
| `GIT_TOKEN` | no | Short-lived clone token paired with `REPO_URL`. Delivered via env, never argv, **never logged**. |

No credentials, backend URL, or fleet-specific config are baked into the
image — every box is generic; identity comes entirely from the env vars
above at `docker run` time.

## Isolation — enforced by the CALLER, not this image

This image does **not** self-isolate. Every hard-isolation invariant is
applied by the `fleet_create_box` handler's `docker run` argv
(`apps/cli/src/commands/host-agent.ts`):

- `--cap-drop ALL`, `--security-opt no-new-privileges`
- Resource caps: `--memory <memoryMb>m --cpus <cpus> --pids-limit <pidsLimit>`
- Network: `--network fleet-net` (isolated bridge, `icc=false` — boxes can't
  see each other; created once by `infra/fleet/setup-vps.sh` in the
  `codeagent-mobile` repo)
- Storage: **one** named volume, `codeam-box-<userId>`, mounted at
  `/home/box` — the box's ONLY writable surface. No host bind mounts, no
  `docker.sock`.
- Identity: **never** `--privileged`. The image's `box` user (created at
  build time) is the only user the entrypoint ever runs as.
- Ops labels: `com.codeagent.user-id`, `com.codeagent.box-id`,
  `com.codeagent.created-by=fleet` — so the fleet host can enumerate/audit
  its own containers without touching anything else on the VPS.

See `apps/cli/__tests__/integration/fleet-box.int.test.ts` for the
real-Docker CI gate that asserts every one of these invariants via
`docker inspect` against a container this image actually produced.

## Local testing

The Docker E2E test fixture this image was forked from —
`apps/cli/__tests__/docker/host-agent.Dockerfile` — remains the lightweight
fixture for `host-agent.docker.e2e.test.ts` (self-hosted execution-plane
acceptance gate, no python3/build-essential). Use **this** image
(`apps/box/Dockerfile`) for anything fleet-specific, including the
`fleet-box.int.test.ts` real-Docker integration test
(`RUN_FLEET_INT=1 npx vitest run fleet-box.int` from `apps/cli`).
