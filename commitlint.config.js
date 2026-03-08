/**
 * Commitlint configuration for soul-agent
 *
 * Enforces Conventional Commits format with project-specific scopes.
 *
 * Format: type(scope): message
 * Examples:
 *   - feat(blog): add new post about AI trust crisis
 *   - fix(evolution): prevent genesis.md modification
 *   - chore(deps): update dependencies
 */

export default {
  extends: ['@commitlint/config-conventional'],

  rules: {
    // Type enum: allowed commit types
    'type-enum': [
      2,
      'always',
      [
        'feat',     // New feature
        'fix',      // Bug fix
        'chore',    // Maintenance (deps, config, etc.)
        'docs',     // Documentation only
        'refactor', // Code refactoring (no functional change)
        'test',     // Adding or updating tests
        'perf',     // Performance improvements
        'ci',       // CI/CD changes
        'revert',   // Revert previous commit
      ],
    ],

    // Scope enum: allowed scopes (optional but recommended)
    'scope-enum': [
      1, // Warning, not error (allows other scopes)
      'always',
      [
        // Core systems
        'blog',
        'evolution',
        'soul',
        'lifecycle',
        'memory',
        'identity',
        'metacognition',

        // Integration
        'claude-code',
        'telegram',
        'mcp',

        // Features
        'auth',
        'safety',
        'plugins',
        'agents',
        'skills',
        'proactive',
        'pipeline',
        'workers',

        // Infrastructure
        'core',
        'config',
        'deps',
        'ci',
        'git',
        'docs',
        'site',
        'report',
        'commands',
      ],
    ],

    // Subject case: allow any case (sentence-case, lower-case, etc.)
    'subject-case': [0],

    // Max line length: 100 characters for header
    'header-max-length': [2, 'always', 100],

    // Body max line length: 100 characters
    'body-max-line-length': [1, 'always', 100],
  },

  // Allow special commit formats
  ignores: [
    // Allow "pre-evolution checkpoint: <hash>" commits
    (message) => message.startsWith('pre-evolution checkpoint:'),

    // Allow merge commits
    (message) => message.startsWith('Merge '),
  ],
};
