/**
 * Prompt the CLI sends to the user's linked agent (Claude, Codex, …)
 * in a headless one-shot to detect how to start the project's dev
 * server. Same pattern as the AI Insights "summary" prompt — the
 * agent runs locally with the user's auth, has read access to the
 * project, and returns a tiny JSON blob the CLI parses.
 *
 * Kept here (in `@codeagent/shared`) so the CLI build inlines the
 * exact string at compile time without runtime fetch from the backend.
 */
export const PREVIEW_DETECT_PROMPT = `
Analyze the project in the current working directory and return how to start
its development server for in-app preview.

Read package.json, Procfile, Dockerfile, docker-compose.yml, manage.py, app.json,
mix.exs, Cargo.toml, go.mod, requirements.txt, Gemfile, and any other framework
markers you find at depth <= 2.

Return ONLY a JSON object on stdout (no prose, no markdown fences):

{
  "framework": "<name, or 'unsupported'>",
  "command": "<executable>",
  "args": ["..."],
  "port": <number>,
  "ready_pattern": "<regex matching the server-ready stdout line>",
  "env": { "HOST": "0.0.0.0" },
  "setup_commands": [],
  "notes": "<one-line caveat or null>"
}

Rules:
- Pick the script the developer would run locally to see the app (typically "dev", "start", "serve").
- Prefer binding to 0.0.0.0 — most frameworks default to localhost which the tunnel cannot reach.
- For Expo: framework="Expo", command="npx", args=["expo","start","--tunnel"], port=8081, notes="Scan QR with Expo Go".
- If no dev server applies (CLI library, lambda, batch script): {"framework":"unsupported","notes":"<reason>"}.

CRITICAL — setup_commands:
- DO NOT include an install command (npm install, pnpm install, yarn install,
  yarn, bun install) in setup_commands. A lockfile-aware pre-flight installer
  runs BEFORE setup_commands and picks the correct package manager from the
  lockfile present (pnpm-lock.yaml -> pnpm, yarn.lock -> yarn, bun.lockb -> bun,
  else npm). Emitting an install here either duplicates that work or, worse,
  uses the WRONG package manager on top of node_modules just populated by the
  pre-flight, which crashes (e.g. npm errors with "Cannot read properties of
  null (reading 'matches')" when run over pnpm's .pnpm/ layout).
- ONLY include setup_commands for genuinely non-install work the project needs
  before its dev server can boot: prisma generate, codegen, prebuild scripts,
  database migrations against a local SQLite, etc.
- For most projects, setup_commands should be an empty array [].

OUTPUT JSON ONLY. NO MARKDOWN. NO COMMENTARY.
`.trim();
