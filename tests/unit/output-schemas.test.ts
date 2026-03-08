import { describe, it, expect } from 'vitest';
import {
  validateAgentOutput,
  hasOutputSchema,
  getSchemaAgentNames,
} from '../../src/agents/governance/output-schemas.js';

describe('Output Schemas', () => {
  describe('validateAgentOutput()', () => {
    // ── Explorer ──
    it('validates valid explorer output', () => {
      const output = {
        topic: 'AI Governance',
        findings: [
          { content: 'Singapore released MGF', importance: 5 },
          { content: 'McKinsey warns about chain vulnerabilities', importance: 4, source: 'mckinsey.com' },
        ],
        importance: 5,
      };
      const result = validateAgentOutput('explorer', output);
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('rejects explorer output with empty findings', () => {
      const output = { topic: 'Test', findings: [], importance: 3 };
      const result = validateAgentOutput('explorer', output);
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('rejects explorer output with importance out of range', () => {
      const output = {
        topic: 'Test',
        findings: [{ content: 'x', importance: 6 }],
        importance: 3,
      };
      const result = validateAgentOutput('explorer', output);
      expect(result.valid).toBe(false);
    });

    // ── Blog Writer ──
    it('validates valid blog-writer output', () => {
      const output = { title: 'My Post', content: 'A longer content body here.' };
      const result = validateAgentOutput('blog-writer', output);
      expect(result.valid).toBe(true);
    });

    it('rejects blog-writer with empty title', () => {
      const output = { title: '', content: 'Some content text here' };
      const result = validateAgentOutput('blog-writer', output);
      expect(result.valid).toBe(false);
    });

    // ── HN Digest ──
    it('validates valid hackernews-digest output', () => {
      const output = {
        stories: [{ title: 'Rust 2.0', summary: 'New release' }],
        trends: 'AI is dominant',
      };
      const result = validateAgentOutput('hackernews-digest', output);
      expect(result.valid).toBe(true);
    });

    it('rejects hackernews-digest with no stories', () => {
      const output = { stories: [] };
      const result = validateAgentOutput('hackernews-digest', output);
      expect(result.valid).toBe(false);
    });

    // ── Security Scanner ──
    it('validates valid security-scanner output', () => {
      const output = {
        findings: [
          {
            severity: 'high',
            title: 'SQL Injection',
            description: 'User input not sanitized',
            file: 'src/api.ts',
          },
        ],
        overallRisk: 'high',
      };
      const result = validateAgentOutput('security-scanner', output);
      expect(result.valid).toBe(true);
    });

    it('validates security-scanner with empty findings', () => {
      const output = { findings: [], overallRisk: 'none' };
      const result = validateAgentOutput('security-scanner', output);
      expect(result.valid).toBe(true); // empty findings is valid (nothing found)
    });

    it('rejects security-scanner with invalid severity', () => {
      const output = {
        findings: [{ severity: 'extreme', title: 'x', description: 'y' }],
        overallRisk: 'high',
      };
      const result = validateAgentOutput('security-scanner', output);
      expect(result.valid).toBe(false);
    });

    // ── Unknown Agent (backward-compatible pass-through) ──
    it('passes validation for unknown agent (no schema)', () => {
      const result = validateAgentOutput('some-new-agent', 'any output');
      expect(result.valid).toBe(true);
    });

    // ── JSON string parsing ──
    it('parses JSON string output', () => {
      const jsonStr = JSON.stringify({
        topic: 'Test',
        findings: [{ content: 'x', importance: 3 }],
        importance: 3,
      });
      const result = validateAgentOutput('explorer', jsonStr);
      expect(result.valid).toBe(true);
    });

    it('extracts JSON from markdown code block', () => {
      const markdown = `Here is my report:\n\n\`\`\`json\n${JSON.stringify({
        topic: 'Test',
        findings: [{ content: 'x', importance: 3 }],
        importance: 3,
      })}\n\`\`\``;
      const result = validateAgentOutput('explorer', markdown);
      expect(result.valid).toBe(true);
    });

    it('fails on plain text for schema-registered agent', () => {
      const result = validateAgentOutput('explorer', 'just some plain text without json');
      expect(result.valid).toBe(false);
      expect(result.errors![0]).toContain('plain text');
    });
  });

  describe('hasOutputSchema()', () => {
    it('returns true for registered agents', () => {
      expect(hasOutputSchema('explorer')).toBe(true);
      expect(hasOutputSchema('blog-writer')).toBe(true);
      expect(hasOutputSchema('hackernews-digest')).toBe(true);
      expect(hasOutputSchema('security-scanner')).toBe(true);
    });

    it('returns false for unregistered agents', () => {
      expect(hasOutputSchema('comment-monitor')).toBe(false);
      expect(hasOutputSchema('nonexistent')).toBe(false);
    });
  });

  describe('getSchemaAgentNames()', () => {
    it('returns all registered agent names', () => {
      const names = getSchemaAgentNames();
      expect(names).toContain('explorer');
      expect(names).toContain('blog-writer');
      expect(names).toContain('hackernews-digest');
      expect(names).toContain('security-scanner');
      expect(names).toHaveLength(4);
    });
  });
});
