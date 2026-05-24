// Enforces Conventional Commits so the release pipeline can auto-generate
// CHANGELOG entries from commit messages. See .gitmessage for the template
// that contributors use locally, and CONTRIBUTING.md for the convention.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'refactor',
        'perf',
        'docs',
        'build',
        'ci',
        'test',
        'chore',
        'style',
        'revert',
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'cli',
        'vsc-plugin',
        'jetbrains-plugin',
        // Cross-plugin work: protocol-level changes that have to land
        // in both VS Code and JetBrains plugins in lock-step.
        'both-plugins',
        'shared',
        'workflow',
        'meta',
        'deps',
        'deps-dev',
        'release',
        'changelog',
      ],
    ],
    'subject-case': [0],
    'body-max-line-length': [1, 'always', 100],
    'footer-max-line-length': [1, 'always', 100],
  },
};
