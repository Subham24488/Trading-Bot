-- AlterTable
ALTER TABLE "LlmTradeDecision" ADD COLUMN     "instrumentToken" INTEGER,
ADD COLUMN     "currentPrice" DECIMAL(18,4);

ALTER TABLE "LlmTradeDecision" ALTER COLUMN "model" DROP NOT NULL;
ALTER TABLE "LlmTradeDecision" ALTER COLUMN "promptHash" DROP NOT NULL;
ALTER TABLE "LlmTradeDecision" ALTER COLUMN "rawCompletion" DROP NOT NULL;
ALTER TABLE "LlmTradeDecision" ALTER COLUMN "marketSnapshot" DROP NOT NULL;
