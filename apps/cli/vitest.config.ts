import { defineConfig } from 'vitest/config';

/**
 * vitest config. Coverage thresholds were added in #63 as the
 * minimum bar — they're intentionally lenient so adding tests to
 * close the gap can happen incrementally without breaking CI.
 * Tighten over time.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.ts'],
    // Shared test fixtures (no `describe`/`it`) live under
    // __tests__/fixtures and are imported by the real specs. Keep
    // them out of the test glob so vitest doesn't treat them as empty
    // suites and fail with "No test suite found".
    // `__tests__/docker/**` holds the host-agent Docker-E2E support files
    // (the Dockerfile + the stub-backend helper). The stub helper has no
    // `describe`/`it`, so — like the fixtures dir — it must stay out of the
    // glob or vitest fails it as an empty suite. The actual spec lives at
    // `__tests__/host-agent.docker.e2e.test.ts` and IS collected (it
    // self-skips when Docker / the DOCKER_E2E flag is absent).
    exclude: [
      '__tests__/fixtures/**',
      '__tests__/docker/**',
      '**/node_modules/**',
      '**/dist/**',
    ],
    coverage: {
      // v8 is faster than istanbul + ships in core Node, so no
      // sourcemap-translation step on the hot path.
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Limit reporting to our src tree — node_modules / __tests__ /
      // dist would inflate the lines-of-code denominator and make
      // the threshold meaningless.
      include: ['src/**/*.ts'],
      exclude: [
        'src/postinstall.ts', // no test surface — runs at npm install
        'src/index.ts', // top-level dispatcher; covered indirectly
        // Codespace provider integrations call out to gh/glab/railway
        // shell commands that we can't realistically mock for
        // coverage purposes.
        'src/services/providers/**',
        // Generated / vendored barrels — no logic to cover.
        '**/index.ts',
      ],
      // Start lenient (#63 audit recommendation). These floors sit
      // ~1-3 pp BELOW the current suite numbers (40.72 / 35.37 /
      // 40 / 39.5) — drop below them and CI fails; tighten by
      // bumping the numbers up as the suite grows. The lopsided
      // thresholds (branches lower than lines etc.) match the
      // shape of the codebase, not a uniform target.
      thresholds: {
        lines: 40,
        branches: 25,
        functions: 35,
        statements: 38,
      },
    },
  },
});
