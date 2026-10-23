-- One id per trade: set on BUY, reused on its HOLDs and EXIT; SKIP rows stay null.
ALTER TABLE "LlmTradeDecision" ADD COLUMN "tuuid" UUID;

CREATE INDEX "LlmTradeDecision_tuuid_idx" ON "LlmTradeDecision"("tuuid");
