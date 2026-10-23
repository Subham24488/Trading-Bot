import type { SessionLogger } from '../broker/kite/KiteTickerStream.js';
import type { ContractCandidate } from '../strategy/contracts.js';
import { completeJsonWithRetry, type LlmChatClient } from './llmChatClient.js';
import {
  buildContractPickMessages,
  CONTRACT_PICK_MAX_OUTPUT_TOKENS,
  hashPrompt,
} from './prompts.js';
import { contractPickSchema } from './schemas.js';

export type PickedBy = 'llm' | 'only-candidate' | 'fallback';

export type ContractPickResult = {
  candidate: ContractCandidate;
  pickedBy: PickedBy;
  note: string;
  llm: { model: string; promptHash: string; rawCompletion: string } | null;
};

const RAW_COMPLETION_MAX_CHARS = 2_000;

/**
 * The only LLM call in the decision loop. Candidates arrive ranked best-first;
 * any LLM failure or an answer outside the list falls back to the top candidate.
 */
export async function pickContract(
  llm: LlmChatClient,
  input: {
    index: string;
    side: 'CE' | 'PE';
    score: number;
    minutesToSquareOff: number;
    candidates: readonly ContractCandidate[];
  },
  logger: SessionLogger,
): Promise<ContractPickResult> {
  const best = input.candidates[0];
  if (!best) {
    throw new Error('pickContract needs at least one candidate.');
  }
  if (input.candidates.length === 1) {
    return {
      candidate: best,
      pickedBy: 'only-candidate',
      note: 'Only one contract passed the checks.',
      llm: null,
    };
  }

  const messages = buildContractPickMessages(input);
  const promptHash = hashPrompt(messages);
  try {
    const completion = await completeJsonWithRetry(
      llm,
      messages,
      CONTRACT_PICK_MAX_OUTPUT_TOKENS,
      logger,
      'contract-pick',
    );
    const meta = {
      model: llm.getModel(),
      promptHash,
      rawCompletion: completion.text.slice(0, RAW_COMPLETION_MAX_CHARS),
    };
    const parsed = contractPickSchema.safeParse(completion.parsed);
    const chosen = parsed.success
      ? input.candidates.find((candidate) => candidate.symbol === parsed.data.symbol)
      : undefined;
    if (parsed.success && chosen) {
      return { candidate: chosen, pickedBy: 'llm', note: parsed.data.reason, llm: meta };
    }
    logger.warn(
      { parsed: completion.parsed },
      'LLM contract pick was not a candidate; using the top-ranked one.',
    );
    return {
      candidate: best,
      pickedBy: 'fallback',
      note: 'The AI answer was not one of the candidates, so the top-ranked contract was used.',
      llm: meta,
    };
  } catch (error: unknown) {
    logger.warn({ err: error }, 'LLM contract pick failed; using the top-ranked one.');
    return {
      candidate: best,
      pickedBy: 'fallback',
      note: 'The AI assistant was unavailable, so the top-ranked contract was used.',
      llm: null,
    };
  }
}
