import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';

const TEST_PLUGINS_DIR = join(process.cwd(), '.test-plugins');

describe('Plugin Compiler (esbuild Context API)', () => {
  afterEach(async () => {
    const { disposeAllContexts } = await import('../../src/plugins/compiler.js');
    await disposeAllContexts();
    await rm(TEST_PLUGINS_DIR, { recursive: true, force: true });
  });

  it('compiles a TypeScript plugin to .mjs with timestamp', async () => {
    await mkdir(TEST_PLUGINS_DIR, { recursive: true });
    const src = join(TEST_PLUGINS_DIR, 'hello.ts');
    await writeFile(src, 'export const greeting: string = "hello";\n');

    const { compilePlugin } = await import('../../src/plugins/compiler.js');
    const outPath = await compilePlugin(src);

    expect(outPath).toMatch(/hello\.\d+\.mjs$/);
    const contents = await readFile(outPath, 'utf-8');
    expect(contents).toContain('greeting');
    expect(contents).toContain('hello');
  });

  it('produces different output paths on each compile (cache busting)', async () => {
    await mkdir(TEST_PLUGINS_DIR, { recursive: true });
    const src = join(TEST_PLUGINS_DIR, 'cache-test.ts');
    await writeFile(src, 'export const x = 1;\n');

    const { compilePlugin } = await import('../../src/plugins/compiler.js');

    const path1 = await compilePlugin(src);
    // Ensure different timestamp
    await new Promise((r) => setTimeout(r, 5));
    const path2 = await compilePlugin(src);

    expect(path1).not.toBe(path2);
    // Both should be valid JS
    const c1 = await readFile(path1, 'utf-8');
    const c2 = await readFile(path2, 'utf-8');
    expect(c1).toContain('x');
    expect(c2).toContain('x');
  });

  it('recovers from syntax errors on next rebuild', async () => {
    await mkdir(TEST_PLUGINS_DIR, { recursive: true });
    const src = join(TEST_PLUGINS_DIR, 'error-test.ts');

    const { compilePlugin } = await import('../../src/plugins/compiler.js');

    // First: valid source
    await writeFile(src, 'export const a = 1;\n');
    await compilePlugin(src);

    // Second: broken source — should throw
    await writeFile(src, 'export const ??? = syntax error!!\n');
    await expect(compilePlugin(src)).rejects.toThrow();

    // Third: fixed source — should recover (context still valid after BuildFailure)
    await writeFile(src, 'export const b = 2;\n');
    const outPath = await compilePlugin(src);
    expect(outPath).toMatch(/error-test\.\d+\.mjs$/);
    const contents = await readFile(outPath, 'utf-8');
    expect(contents).toContain('b');
  });

  it('disposeAllContexts allows fresh context creation', async () => {
    await mkdir(TEST_PLUGINS_DIR, { recursive: true });
    const src = join(TEST_PLUGINS_DIR, 'dispose-test.ts');
    await writeFile(src, 'export const d = 1;\n');

    const { compilePlugin, disposeAllContexts } = await import('../../src/plugins/compiler.js');

    await compilePlugin(src);
    await disposeAllContexts();

    // After dispose, next compile creates fresh context
    const outPath = await compilePlugin(src);
    expect(outPath).toMatch(/dispose-test\.\d+\.mjs$/);
  });

  it('cleanOldCompilations removes old files but keeps current', async () => {
    await mkdir(TEST_PLUGINS_DIR, { recursive: true });
    const src = join(TEST_PLUGINS_DIR, 'cleanup-test.ts');
    await writeFile(src, 'export const c = 1;\n');

    const { compilePlugin, cleanOldCompilations } = await import('../../src/plugins/compiler.js');

    const path1 = await compilePlugin(src);
    await new Promise((r) => setTimeout(r, 5));
    const path2 = await compilePlugin(src);

    // Both should exist before cleanup
    await expect(readFile(path1)).resolves.toBeDefined();
    await expect(readFile(path2)).resolves.toBeDefined();

    // Clean, keeping only path2
    await cleanOldCompilations('cleanup-test', path2);

    // path1 should be gone, path2 should remain
    await expect(readFile(path1)).rejects.toThrow();
    await expect(readFile(path2)).resolves.toBeDefined();
  });
});
