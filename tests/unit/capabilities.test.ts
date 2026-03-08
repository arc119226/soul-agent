import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../../src/core/debounced-writer.js', () => ({
  writer: { schedule: vi.fn() },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Capabilities', () => {
  let loadCapabilities: typeof import('../../src/evolution/capabilities.js')['loadCapabilities'];
  let addCapability: typeof import('../../src/evolution/capabilities.js')['addCapability'];
  let addPluginCapability: typeof import('../../src/evolution/capabilities.js')['addPluginCapability'];
  let removeCapability: typeof import('../../src/evolution/capabilities.js')['removeCapability'];
  let addLimitation: typeof import('../../src/evolution/capabilities.js')['addLimitation'];
  let removeLimitation: typeof import('../../src/evolution/capabilities.js')['removeLimitation'];
  let getCapabilities: typeof import('../../src/evolution/capabilities.js')['getCapabilities'];
  let getCapabilitiesData: typeof import('../../src/evolution/capabilities.js')['getCapabilitiesData'];
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockSchedule: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    mockSchedule = vi.fn();

    vi.doMock('node:fs/promises', () => ({ readFile: mockReadFile }));
    vi.doMock('../../src/core/debounced-writer.js', () => ({ writer: { schedule: mockSchedule } }));
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const mod = await import('../../src/evolution/capabilities.js');
    loadCapabilities = mod.loadCapabilities;
    addCapability = mod.addCapability;
    addPluginCapability = mod.addPluginCapability;
    removeCapability = mod.removeCapability;
    addLimitation = mod.addLimitation;
    removeLimitation = mod.removeLimitation;
    getCapabilities = mod.getCapabilities;
    getCapabilitiesData = mod.getCapabilitiesData;
  });

  describe('loadCapabilities()', () => {
    it('loads from disk when file exists', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        last_updated: '2026-01-01',
        core_capabilities: ['cap1'],
        plugin_capabilities: ['pcap1'],
        limitations: ['lim1'],
      }));

      await loadCapabilities();
      const data = getCapabilitiesData();
      expect(data.core_capabilities).toEqual(['cap1']);
      expect(data.plugin_capabilities).toEqual(['pcap1']);
      expect(data.limitations).toEqual(['lim1']);
    });

    it('starts fresh when file does not exist', async () => {
      await loadCapabilities();
      const data = getCapabilitiesData();
      expect(data.core_capabilities).toEqual([]);
      expect(data.plugin_capabilities).toEqual([]);
      expect(data.limitations).toEqual([]);
    });
  });

  describe('addCapability()', () => {
    it('adds a core capability and returns ok', () => {
      const result = addCapability('Respond in Chinese');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().core_capabilities).toContain('Respond in Chinese');
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('rejects duplicate capability', () => {
      addCapability('Feature A');
      const result = addCapability('Feature A');
      expect(result.ok).toBe(false);
    });
  });

  describe('addPluginCapability()', () => {
    it('adds a plugin capability and returns ok', () => {
      const result = addPluginCapability('Weather plugin');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().plugin_capabilities).toContain('Weather plugin');
    });

    it('rejects duplicate plugin capability', () => {
      addPluginCapability('Weather plugin');
      const result = addPluginCapability('Weather plugin');
      expect(result.ok).toBe(false);
    });
  });

  describe('removeCapability()', () => {
    it('removes a core capability', () => {
      addCapability('Feature X');
      const result = removeCapability('Feature X');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().core_capabilities).not.toContain('Feature X');
    });

    it('removes a plugin capability', () => {
      addPluginCapability('Plugin Y');
      const result = removeCapability('Plugin Y');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().plugin_capabilities).not.toContain('Plugin Y');
    });

    it('returns fail when capability not found', () => {
      const result = removeCapability('nonexistent');
      expect(result.ok).toBe(false);
    });
  });

  describe('addLimitation() / removeLimitation()', () => {
    it('adds a limitation', () => {
      const result = addLimitation('Cannot send images');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().limitations).toContain('Cannot send images');
    });

    it('rejects duplicate limitation', () => {
      addLimitation('Cannot send images');
      const result = addLimitation('Cannot send images');
      expect(result.ok).toBe(false);
    });

    it('removes a limitation', () => {
      addLimitation('Cannot send images');
      const result = removeLimitation('Cannot send images');
      expect(result.ok).toBe(true);
      expect(getCapabilitiesData().limitations).not.toContain('Cannot send images');
    });

    it('returns fail when limitation not found', () => {
      const result = removeLimitation('nonexistent');
      expect(result.ok).toBe(false);
    });
  });

  describe('getCapabilities()', () => {
    it('returns formatted markdown with all sections', () => {
      addCapability('Core feature');
      addPluginCapability('Plugin feature');
      addLimitation('Some limitation');

      const md = getCapabilities();
      expect(md).toContain('## Core Capabilities');
      expect(md).toContain('- Core feature');
      expect(md).toContain('## Plugin Capabilities');
      expect(md).toContain('- Plugin feature');
      expect(md).toContain('## Known Limitations');
      expect(md).toContain('- Some limitation');
    });

    it('returns empty string when no capabilities or limitations', () => {
      expect(getCapabilities()).toBe('');
    });
  });

  describe('getCapabilitiesData()', () => {
    it('returns a shallow copy (not the same reference)', () => {
      addCapability('test');
      const data1 = getCapabilitiesData();
      const data2 = getCapabilitiesData();
      expect(data1).toEqual(data2);
      expect(data1).not.toBe(data2);
    });
  });
});
