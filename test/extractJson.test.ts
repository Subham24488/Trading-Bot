import { describe, expect, it } from 'vitest';

import { extractJsonObject } from '../src/llm/extractJson.js';

describe('extractJsonObject', () => {
  it('parses fenced JSON', () => {
    expect(extractJsonObject('```json\n{"action":"HOLD"}\n```')).toEqual({ action: 'HOLD' });
  });

  it('rejects prose without an object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(/JSON object/);
  });
});
