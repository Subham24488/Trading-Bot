import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';

const TOKEN_CUT_RETRY_MAX_TOKENS = 4096;

export type LlmChatMessage = {
  role: 'system' | 'user';
  content: string;
};

export type LlmChatClient = {
  getModel(): string;
  completeJson(
    messages: LlmChatMessage[],
    options?: { maxTokens?: number },
  ): Promise<{ text: string; parsed: unknown }>;
};

/**
 * One retry. A token cut (Groq `json_validate_failed`, usually hidden reasoning eating the budget)
 * retries with a larger budget; any other failure retries at the same budget.
 */
export async function completeJsonWithRetry(
  llm: LlmChatClient,
  messages: LlmChatMessage[],
  maxTokens: number,
  logger: SessionLogger,
  label: string,
): Promise<{ text: string; parsed: unknown }> {
  try {
    return await llm.completeJson(messages, { maxTokens });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const tokenCut =
      message.includes('json_validate_failed') || message.includes('max completion tokens');
    const retryTokens = tokenCut ? Math.max(maxTokens, TOKEN_CUT_RETRY_MAX_TOKENS) : maxTokens;
    logger.warn({ err: error, label, retryTokens }, 'LLM JSON completion failed; retrying once.');
    return llm.completeJson(messages, { maxTokens: retryTokens });
  }
}
