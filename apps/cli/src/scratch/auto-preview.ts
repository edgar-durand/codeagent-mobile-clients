import fs from 'node:fs';
import path from 'node:path';
import { isScratchWorkspace } from './workspace';

/**
 * From-scratch sessions: open the Preview when the agent built something and
 * did not open it itself.
 *
 * The scratch skill (workflow hint + `suggest_save_project` description) TELLS
 * the agent to finish with `start_preview`, but a told agent does not always
 * do it: on 2026-09-30 a managed session built index.html + style.css, said
 * "Done. Three files created" and never called the tool, so the user never saw
 * the page (scratch-preview RCA). Same lesson as the save card, which the CLI
 * already offers itself on the first `preview_ready`: the step the whole
 * feature exists for must not depend on the model obeying a hint.
 */

/** Root files that mean "there is something a dev server could serve". */
const SERVABLE_ROOT_FILES = new Set([
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'manage.py',
  'app.py',
  'main.py',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
  'composer.json',
]);

/** Agent instruction files: present in a project nobody has built yet. */
const AGENT_NOTES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);

function rootEntries(cwd: string): string[] | null {
  try {
    return fs.readdirSync(cwd);
  } catch {
    return null;
  }
}

/** True when the project has an entry point detection can work with. */
export function hasServableProject(cwd: string): boolean {
  const entries = rootEntries(cwd);
  if (!entries) return false;
  if (entries.some((e) => SERVABLE_ROOT_FILES.has(e) || /\.html?$/i.test(e))) return true;
  // 'dist'/'build' are the conventional output dirs for an already-built
  // static site (Vite/Parcel default to dist, CRA to build) — the agent ran
  // the build but never served the result, same gap this module exists to
  // close for a root index.html.
  return ['public', 'src', 'dist', 'build'].some((dir) =>
    fs.existsSync(path.join(cwd, dir, 'index.html')),
  );
}

/**
 * A scratch project the agent has not written anything into yet: only
 * dotfiles (`.git`, `.gitignore`, `.beads`) and agent notes. Asking the
 * agent how to serve it burns a 6-50 s one-shot to learn there is nothing.
 */
export function isEmptyScratchProject(cwd: string): boolean {
  if (!isScratchWorkspace(cwd)) return false;
  const entries = rootEntries(cwd);
  return entries !== null && entries.every((e) => e.startsWith('.') || AGENT_NOTES.has(e));
}

/** Sessions where some preview bring-up already ran in this process. */
const bringUps = new Set<string>();

/** Called by every bring-up (button, agent tool, restore, restart). */
export function notePreviewBringUp(sessionId: string): void {
  bringUps.add(sessionId);
}

/** Test-only. */
export function resetAutoPreviewForTests(): void {
  bringUps.clear();
}

/** The slice of `AgentPreviewBridge` this needs (the bridge is the pipeline
 *  the agent's own `start_preview` runs, so the app sees an agent preview). */
export interface AutoPreviewBridge {
  status(): { status: string };
  start(): Promise<unknown>;
}

/**
 * Call after a turn ends normally. Starts the preview when ALL hold:
 * - the cwd is a from-scratch project;
 * - no preview was ever brought up for this session in this process (so a
 *   preview the user stopped stays stopped);
 * - the agent bridge is idle (no agent start in flight, no earlier failure);
 * - the project now has something servable.
 * Returns whether it started one. Never throws.
 */
export function maybeAutoOpenScratchPreview(
  sessionId: string,
  bridge: AutoPreviewBridge,
  cwd: string = process.cwd(),
): boolean {
  if (!isScratchWorkspace(cwd) || bringUps.has(sessionId)) return false;
  if (bridge.status().status !== 'idle') return false;
  if (!hasServableProject(cwd)) return false;
  // Mark now: the bring-up marks it too, but only once detection resolves.
  bringUps.add(sessionId);
  void bridge.start().catch(() => {
    /* the bridge reports every failure to the app itself */
  });
  return true;
}
