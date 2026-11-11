-- Simulated replays share the table with live decisions; live reads filter on "simulated" = false.
ALTER TABLE "LlmTradeDecision" ADD COLUMN "simulated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LlmTradeDecision" ADD COLUMN "simulationId" UUID;

CREATE INDEX "LlmTradeDecision_simulationId_idx" ON "LlmTradeDecision"("simulationId");
