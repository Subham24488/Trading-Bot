-- Supports session-review: filter action IN ('BUY','EXIT') over a decidedAt range.
CREATE INDEX "LlmTradeDecision_action_decidedAt_idx" ON "LlmTradeDecision"("action", "decidedAt");
