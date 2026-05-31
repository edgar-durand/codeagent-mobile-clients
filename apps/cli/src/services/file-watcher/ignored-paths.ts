/**
 * Defensive ignore predicate, applied at the CLI's emit pipeline
 * before any debounce / coalesce / diff / POST work happens.
 *
 * chokidar's `ignored` option is the first line of defence and
 * filters most events at the watcher level, but it has known edge
 * cases on macOS fsevents and Windows ReadDirectoryChangesW where
 * paths inside a freshly-created `node_modules/` (think `npm
 * install` running mid-session) can sneak past the regex
 * matcher. Server-side the api-v2 `isIgnoredFilePath` will drop
 * these anyway — but doing it CLI-side too avoids:
 *
 *   - The `git diff <path>` spawn per leaked event (cheap per
 *     call, expensive in aggregate when 3k node_modules headers
 *     queue up).
 *   - The producer outbox accumulating retries against api-v2's
 *     filtered `null` response.
 *   - Memory bloat in the chokidar / coalesce buffers during a
 *     huge install (~3k entries observed in the field).
 *
 * Pattern source MUST match apps/api-v2/src/files/ignored-paths.ts
 * so a path that the CLI ships is never silently dropped by the
 * API (or vice versa). When extending: edit BOTH files.
 */
const IGNORED_PATH_PATTERN =
  /(^|[\\/])(?:\.git|\.next|\.expo|\.turbo|\.cache|\.parcel-cache|\.vercel|\.idea|\.vscode|node_modules|dist|build|out|coverage|target|__pycache__|\.gradle|Pods|DerivedData|\.dart_tool|venv|\.venv|\.tox|\.mypy_cache|\.pytest_cache|\.DS_Store|Thumbs\.db)([\\/]|$)/i;

export function isIgnoredFilePath(filePath: string | null | undefined): boolean {
  if (!filePath || filePath.length === 0) return true;
  return IGNORED_PATH_PATTERN.test(filePath);
}
