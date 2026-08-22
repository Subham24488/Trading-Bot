import { config } from '../config.js';
import { extractJsonObject } from './extractJson.js';

export type HuggingFaceChatMessage = {
  role: 'system' | 'user';
  content: string;
};

export type HuggingFaceClientOptions = {
  token?: string;
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
  if (typeof content === 'string') {
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

export class HuggingFaceClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private connected = false;

  public constructor(options: HuggingFaceClientOptions = {}) {
    this.token = (options.token ?? config.huggingface.token).trim();
    this.baseUrl = (options.baseUrl ?? config.huggingface.baseUrl).replace(/\/$/, '');
    this.model = options.model ?? config.huggingface.model;
    this.timeoutMs = options.timeoutMs ?? config.huggingface.timeoutMs;
    this.maxTokens = options.maxTokens ?? config.huggingface.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.token) {
      throw new Error('HuggingFaceClient requires HF_TOKEN.');
    }
  }

  public getModel(): string {
    return this.model;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Fail-fast boot check: token can list Inference Providers models.
   */
  public async connect(): Promise<void> {
    const response = await this.request(`${this.baseUrl}/models`, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Hugging Face LLM boot check failed (${response.status} ${response.statusText}): ${body.slice(0, 400)}`,
      );
    }

    this.connected = true;
  }

  public async completeJson(messages: HuggingFaceChatMessage[]): Promise<{ text: string; parsed: unknown }> {
    if (!this.connected) {
      throw new Error('Hugging Face LLM is not connected. Application boot did not complete connect().');
    }

    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: this.maxTokens,
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' },
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(
        `Hugging Face chat completion failed (${response.status} ${response.statusText}): ${raw.slice(0, 400)}`,
      );
    }

    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      throw new Error('Hugging Face returned a non-JSON chat completion envelope.');
    }

    if (payload.error?.message) {
      throw new Error(`Hugging Face chat completion error: ${payload.error.message}`);
    }

    const text = readContent(payload).trim();
    if (!text) {
      throw new Error('Hugging Face returned an empty completion.');
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
          Authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Hugging Face request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
