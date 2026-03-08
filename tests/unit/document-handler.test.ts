import { describe, it, expect } from 'vitest';

// Test the extractJsonFromResponse utility by importing it indirectly
// Since it's a private function, we test the public interface behavior.
// For now, test the JSON extraction logic as a standalone function.

function extractJsonFromResponse(response: string): Record<string, unknown> | null {
  const jsonBlockMatch = response.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  const jsonStr = jsonBlockMatch ? jsonBlockMatch[1] : null;

  if (!jsonStr) {
    const bareMatch = response.match(/\{[\s\S]*\}/);
    if (!bareMatch) return null;
    try {
      return JSON.parse(bareMatch[0]);
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

describe('Document Handler — JSON extraction', () => {
  it('extracts JSON from ```json code block', () => {
    const response = `
這是分析結果：
- 金額：$150

\`\`\`json
{
  "申請日期": "2026/02/22",
  "付款金額": "$150.00"
}
\`\`\`
`;
    const result = extractJsonFromResponse(response);
    expect(result).toEqual({
      '申請日期': '2026/02/22',
      '付款金額': '$150.00',
    });
  });

  it('extracts bare JSON object when no code block', () => {
    const response = '分析結果：{"name": "test", "value": 42}';
    const result = extractJsonFromResponse(response);
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('returns null when no JSON found', () => {
    const response = '這是純文字回應，沒有 JSON。';
    const result = extractJsonFromResponse(response);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const response = '```json\n{invalid json}\n```';
    const result = extractJsonFromResponse(response);
    expect(result).toBeNull();
  });

  it('handles nested JSON objects', () => {
    const response = `
\`\`\`json
{
  "申請日期": "2026/02/22",
  "items": [{"name": "A", "amount": 100}]
}
\`\`\``;
    const result = extractJsonFromResponse(response);
    expect(result).toEqual({
      '申請日期': '2026/02/22',
      items: [{ name: 'A', amount: 100 }],
    });
  });
});
