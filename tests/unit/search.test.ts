import { describe, it, expect } from 'vitest';
import { parseDDGHtml, formatSearchResults, type SearchResult } from '../../src/web/search.js';

describe('parseDDGHtml — HTML parsing', () => {
  it('returns empty array for empty HTML', () => {
    expect(parseDDGHtml('')).toEqual([]);
  });

  it('returns empty array for HTML with no results', () => {
    expect(parseDDGHtml('<html><body>No results</body></html>')).toEqual([]);
  });

  it('parses a single result with link and snippet', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://example.com">Example Title</a>
      <a class="result__snippet" href="https://example.com">This is a snippet about the example.</a>
    `;
    const results = parseDDGHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: 'Example Title',
      url: 'https://example.com',
      snippet: 'This is a snippet about the example.',
    });
  });

  it('parses multiple results', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://a.com">Result A</a>
      <a class="result__snippet" href="https://a.com">Snippet A</a>
      <a rel="nofollow" class="result__a" href="https://b.com">Result B</a>
      <a class="result__snippet" href="https://b.com">Snippet B</a>
    `;
    const results = parseDDGHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe('Result A');
    expect(results[1]!.title).toBe('Result B');
  });

  it('strips HTML tags and entities from text', () => {
    const html = `
      <a rel="nofollow" class="result__a" href="https://x.com">Title &amp; More</a>
      <a class="result__snippet" href="https://x.com">It&#39;s <b>great</b> &amp; useful</a>
    `;
    const results = parseDDGHtml(html);
    expect(results[0]!.title).toBe('Title & More');
    expect(results[0]!.snippet).toBe("It's great & useful");
  });

  it('limits results to MAX_RESULTS (8)', () => {
    const links = Array.from({ length: 12 }, (_, i) =>
      `<a rel="nofollow" class="result__a" href="https://r${i}.com">R${i}</a>
       <a class="result__snippet" href="https://r${i}.com">S${i}</a>`,
    ).join('\n');
    const results = parseDDGHtml(links);
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

describe('formatSearchResults', () => {
  it('returns no-results message for empty array', () => {
    const msg = formatSearchResults([], 'test');
    expect(msg).toContain('No results found');
    expect(msg).toContain('test');
  });

  it('formats results with numbered list', () => {
    const results: SearchResult[] = [
      { title: 'First', url: 'https://first.com', snippet: 'First snippet' },
      { title: 'Second', url: 'https://second.com', snippet: 'Second snippet' },
    ];
    const msg = formatSearchResults(results, 'query');
    expect(msg).toContain('*1.*');
    expect(msg).toContain('*2.*');
    expect(msg).toContain('[First](https://first.com)');
    expect(msg).toContain('First snippet');
  });
});
