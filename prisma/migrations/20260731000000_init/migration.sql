-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "TradingRunStatus" AS ENUM ('STARTED', 'COMPLETED', 'BLOCKED', 'FAILED');

-- CreateEnum
CREATE TYPE "BrokerOrderStatus" AS ENUM ('CREATED', 'FILLED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "TradingRun" (
    "id" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "status" "TradingRunStatus" NOT NULL DEFAULT 'STARTED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,

    CONSTRAINT "TradingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerOrder" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "limitPrice" DECIMAL(18,4) NOT NULL,
    "notional" DECIMAL(18,4) NOT NULL,
    "status" "BrokerOrderStatus" NOT NULL DEFAULT 'CREATED',
    "brokerOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BrokerOrder_clientOrderId_key" ON "BrokerOrder"("clientOrderId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_category_idx" ON "AuditEvent"("category");

-- AddForeignKey
ALTER TABLE "BrokerOrder" ADD CONSTRAINT "BrokerOrder_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TradingRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TradingRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
