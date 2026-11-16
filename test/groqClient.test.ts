import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    groq: {
      apiKey: 'test-key-123',
      baseUrl: 'https://api.groq.test/openai/v1',
      model: 'openai/gpt-oss-120b',
      timeoutMs: 5_000,
      maxTokens: 800,
      reasoningEffort: 'low',
    },
  },
}));

import { GroqClient } from '../src/llm/groqClient.js';
import { completeJsonWithRetry } from '../src/llm/llmChatClient.js';

function fakeFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/models')) {
      return new Response('{"data":[]}', { status: 200 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"symbol":"X","reason":"ok"}' } }] }),
      { status: 200 },
    );
  });
}

async function requestBody(model: string): Promise<Record<string, unknown>> {
  const fetchImpl = fakeFetch();
  const client = new GroqClient({
    apiKey: 'test-key-123',
    model,
    reasoningEffort: 'low',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  await client.connect();
  await client.completeJson([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
  const init = fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('GroqClient', () => {
  it('sends reasoning_effort to gpt-oss reasoning models', async () => {
    const body = await requestBody('openai/gpt-oss-120b');
    expect(body.reasoning_effort).toBe('low');
    expect(body.max_tokens).toBe(100);
  });

  it('omits reasoning_effort for non-reasoning models', async () => {
    const body = await requestBody('llama-3.1-8b-instant');
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('completeJsonWithRetry', () => {
  it('retries with a larger budget when the model runs out of tokens before writing JSON', async () => {
    const llm = {
      getModel: () => 'test-model',
      completeJson: vi
        .fn()
        .mockRejectedValueOnce(new Error('Groq chat completion failed (400 ): json_validate_failed'))
        .mockResolvedValueOnce({ text: '{"watchlist":[]}', parsed: { watchlist: [] } }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await completeJsonWithRetry(llm, [], 1024, logger, 'universe');
    expect(result.parsed).toEqual({ watchlist: [] });
    expect(llm.completeJson).toHaveBeenCalledTimes(2);
    expect(llm.completeJson.mock.calls[1]?.[1]).toEqual({ maxTokens: 4096 });
  });
});
