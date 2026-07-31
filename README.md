# NSE Trading Bot

A safety-first, TypeScript/Node.js foundation for a personal NSE automated-investing bot. It implements the project plan's operational foundations—configuration validation, a paper broker, independent pre-trade risk checks, audit schema, job scheduler, health/readiness API, pause control and CI.

## Safety defaults

- `TRADING_MODE=paper` is the default.
- The only implemented broker is `PaperBroker`; `KiteBroker` is intentionally disabled and cannot send a live order.
- The service starts **paused**. A supported daily broker authorisation/readiness workflow must be implemented before it can be resumed in production.
- No strategy is enabled, so the daily cycle records an audit event but creates no orders.
- Do not automate, store or bypass broker passwords, PINs or TOTP secrets.

This is intentional. A production strategy and a live broker adapter require separate review, paper/shadow validation and broker/NSE compliance confirmation.

## Prerequisites

- Node.js 22+
- pnpm 10+
- PostgreSQL 16+ (or Docker Desktop)

## Local setup

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate --name init
pnpm dev
```

The API listens on `http://localhost:3000`.

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/api/v1/readiness
```

Set a long random `ADMIN_TOKEN` in `.env` before using the pause/resume or manual-cycle endpoints. The server compares it in constant time through the `x-admin-token` header.

## Verification

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## Project documents

- [Detailed project plan](TRADING_BOT_PROJECT_PLAN.md)
- [Confluence-ready team page](CONFLUENCE_NSE_TRADING_BOT.md)

## Implementation sequence

1. Confirm Zerodha onboarding, static-IP whitelisting, daily authorisation and permitted API/algo workflow.
2. Implement the reviewed daily authorisation callback and readiness checks; keep the bot paused on any failure.
3. Implement a versioned strategy specification and a realistic, cost-aware backtest before enabling signals.
4. Complete 8–12 weeks of shadow operation with daily broker/position reconciliation.
5. Implement and independently review the Kite broker adapter, then perform a controlled paper-to-live release with the risk limits in the project plan.

See the project plan for regulatory, security, cost, risk and operating requirements. This project is not investment advice and does not promise returns.
