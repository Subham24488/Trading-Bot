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
