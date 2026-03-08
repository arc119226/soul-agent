import { describe, it, expect } from 'vitest';

// layeredValidation calls tsc in integration layer, which can be slow (~10-30s).
// Tests that exercise the full pipeline get extended timeouts.

describe('Validator — layeredValidation', () => {
  describe('Syntax layer', () => {
    it('passes for existing valid TS files (full pipeline)', async () => {
      const { layeredValidation } = await import('../../src/evolution/validator.js');
      const result = await layeredValidation(['src/result.ts']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const syntaxIssues = result.value!.issues.filter(i => i.layer === 'syntax');
        expect(syntaxIssues).toHaveLength(0);
      }
    }, 90_000);

    it('reports missing files (stops at syntax layer)', async () => {
      const { layeredValidation } = await import('../../src/evolution/validator.js');
      const result = await layeredValidation(['src/nonexistent-file-xyz.ts']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.passed).toBe(false);
        expect(result.value!.issues.length).toBeGreaterThan(0);
        expect(result.value!.issues[0]!.layer).toBe('syntax');
        expect(result.value!.issues[0]!.message).toContain('does not exist');
      }
    });

    it('validates JSON syntax for .json files', async () => {
      const { layeredValidation } = await import('../../src/evolution/validator.js');
      const result = await layeredValidation(['package.json']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const syntaxIssues = result.value!.issues.filter(i => i.layer === 'syntax');
        expect(syntaxIssues).toHaveLength(0);
      }
    }, 90_000);
  });

  describe('Semantic layer', () => {
    it('passes for file with no imports (result.ts)', async () => {
      const { layeredValidation } = await import('../../src/evolution/validator.js');
      const result = await layeredValidation(['src/result.ts']);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const semanticIssues = result.value!.issues.filter(i => i.layer === 'semantic');
        expect(semanticIssues).toHaveLength(0);
      }
    }, 90_000);
  });

  describe('validateSyntax (tsc --noEmit)', () => {
    it('returns a Result', async () => {
      const { validateSyntax } = await import('../../src/evolution/validator.js');
      const result = await validateSyntax();
      expect(typeof result.ok).toBe('boolean');
      if (result.ok) {
        expect(result.message).toContain('passed');
      }
    }, 90_000);
  });

  describe('validateImports', () => {
    it('passes for empty file list', async () => {
      const { validateImports } = await import('../../src/evolution/validator.js');
      const result = await validateImports([]);
      expect(result.ok).toBe(true);
    });

    it('passes for non-ts/js files', async () => {
      const { validateImports } = await import('../../src/evolution/validator.js');
      const result = await validateImports(['README.md', 'package.json']);
      expect(result.ok).toBe(true);
    });
  });
});
