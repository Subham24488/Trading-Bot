import { config } from '../config.js';
import { extractJsonObject } from './extractJson.js';
import type { LlmChatMessage } from './llmChatClient.js';

export type GroqClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string };
};

function readContent(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

export class GroqClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private connected = false;

  public constructor(options: GroqClientOptions = {}) {
    this.apiKey = (options.apiKey ?? config.groq.apiKey).trim();
    this.baseUrl = (options.baseUrl ?? config.groq.baseUrl).replace(/\/$/, '');
    this.model = options.model ?? config.groq.model;
    this.timeoutMs = options.timeoutMs ?? config.groq.timeoutMs;
    this.maxTokens = options.maxTokens ?? config.groq.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.apiKey) {
      throw new Error('GroqClient requires GROQ_API_KEY.');
    }
  }

  public getModel(): string {
    return this.model;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  /** Fail-fast boot check: key can list Groq models. */
  public async connect(): Promise<void> {
    const response = await this.request(`${this.baseUrl}/models`, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Groq LLM boot check failed (${response.status} ${response.statusText}): ${body.slice(0, 400)}`,
      );
    }

    this.connected = true;
  }

  public async completeJson(
    messages: LlmChatMessage[],
    options: { maxTokens?: number } = {},
  ): Promise<{ text: string; parsed: unknown }> {
    if (!this.connected) {
      throw new Error('Groq LLM is not connected. Application boot did not complete connect().');
    }

    const maxTokens = options.maxTokens ?? this.maxTokens;
    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' },
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Groq chat completion failed (${response.status} ${response.statusText}): ${raw.slice(0, 400)}`,
      );
    }

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error('Groq returned a non-JSON chat completion envelope.');
    }

    if (payload.error?.message) {
      throw new Error(`Groq chat completion error: ${payload.error.message}`);
    }

    const text = readContent(payload).trim();
    if (!text) {
      throw new Error('Groq returned an empty completion.');
    }

    return { text, parsed: extractJsonObject(text) };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Groq request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
