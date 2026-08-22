import { describe, expect, it } from 'vitest';

import { extractJsonObject } from '../src/llm/extractJson.js';

describe('extractJsonObject', () => {
  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"action":"HOLD"}\n```')).toEqual({ action: 'HOLD' });
  });

  it('strips Qwen think blocks before parsing', () => {
    expect(
      extractJsonObject('<think>reason about RELIANCE</think>\n{"watchlist":[{"symbol":"RELIANCE","include":true,"rationale":"RESULT"}]}'),
    ).toEqual({
      watchlist: [{ symbol: 'RELIANCE', include: true, rationale: 'RESULT' }],
    });
  });

  it('recovers JSON after an unclosed think prefix', () => {
    expect(extractJsonObject('<think>still reasoning\n{"decisions":[{"symbol":"TCS","action":"HOLD","rationale":"range"}]}')).toEqual({
      decisions: [{ symbol: 'TCS', action: 'HOLD', rationale: 'range' }],
    });
  });

  it('rejects prose without an object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/JSON object/);
  });

  it('rejects an unclosed think block with no JSON', () => {
    expect(() => extractJsonObject('<think>Okay, let us go through each filing...')).toThrow(/JSON object/);
  });
});
