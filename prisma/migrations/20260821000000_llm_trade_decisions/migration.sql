-- CreateEnum
CREATE TYPE "LlmTradeAction" AS ENUM ('BUY', 'HOLD', 'EXIT');

-- CreateTable
CREATE TABLE "LlmTradeDecision" (
    "id" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asOf" TIMESTAMP(3) NOT NULL,
    "symbol" TEXT NOT NULL,
    "action" "LlmTradeAction" NOT NULL,
    "confidence" DECIMAL(6,4),
    "rationale" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "rawCompletion" TEXT NOT NULL,
    "marketSnapshot" JSONB NOT NULL,
    "watchlistFile" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "executionBlockedReason" TEXT NOT NULL DEFAULT 'LLM decisions are never sent to the broker.',

    CONSTRAINT "LlmTradeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmTradeDecision_decidedAt_idx" ON "LlmTradeDecision"("decidedAt");

-- CreateIndex
CREATE INDEX "LlmTradeDecision_symbol_decidedAt_idx" ON "LlmTradeDecision"("symbol", "decidedAt");
