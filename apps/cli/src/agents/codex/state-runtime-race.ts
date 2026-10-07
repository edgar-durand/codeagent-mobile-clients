/**
 * Codex's first-run state-DB race.
 *
 * Every `codex` process (`codex app-server` under codex-acp, `codex exec` for
 * one-shots) opens and MIGRATES the SQLite DBs in `~/.codex`
 * (`state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`)
 * at startup. When `~/.codex` holds no DBs yet — the first deploy of a new
 * account — two codex processes starting at the same moment race on those
 * migrations and the loser exits 1 with:
 *
 *   Error: failed to initialize sqlite state runtime under /home/box/.codex:
 *   failed to initialize state runtime at /home/box/.codex
 *
 * Reproduced locally on codex-cli 0.143.0 (fresh HOME, 2–3 concurrent
 * `codex app-server`, or `codex app-server` + `codex exec`): one survives,
 * the others die with exactly that text. Once the DBs exist the race is gone
 * (3 concurrent starts on a warm `~/.codex` all succeed), which is why the
 * second deploy on the same home worked (replays 2026-10-05:
 * info.notifikasi.transaksi, jefrigt11). Pre-creating `~/.codex` does NOT
 * help — the race is on the DB files, not the directory.
 *
 * So the failure is transient by construction: a retry a beat later opens the
 * DBs the winner already migrated.
 */
export const CODEX_STATE_RUNTIME_RACE_RE = /failed to initialize (sqlite )?state runtime/i;
