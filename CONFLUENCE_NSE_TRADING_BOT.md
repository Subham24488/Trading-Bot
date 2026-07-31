# NSE Automated Investing Bot

| Field                 | Value                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Status                | Proposed — minimal-touch operating model agreed; awaiting broker and risk-policy validation |
| Project owner         | _Assign_                                                                                    |
| Technical owner       | _Assign_                                                                                    |
| Risk/compliance owner | _Assign_                                                                                    |
| Last reviewed         | 31 July 2026                                                                                |
| Next review           | _Assign a date before starting Phase 0_                                                     |
| Labels                | `nse`, `algo-trading`, `automation`, `zerodha`, `groww`, `risk-management`                  |

> **Decision summary:** Build a personal, low-turnover, long-only NSE cash-equity/ETF investing bot. Use one broker in v1, start with Zerodha + Kite Connect, and outsource broker connectivity, custody, exchange risk controls, and—if zero daily intervention is mandatory—broker-hosted execution. Do not trade F&O, use leverage, or use an LLM to place orders in v1.

## Purpose and scope

Build a production-quality system that analyses the NSE market and automatically places trades in the owner's account. The bot is for the owner's account only. It is not a public trading platform, pooled-investment product, investment-advisory service, or high-frequency system.

### In scope

- Systematic, rules-based, long-only NSE ETF/cash-equity investing.
- Market analysis, portfolio construction, pre-trade controls, limit-order execution, reconciliation, audit records, alerts and reporting.
- Zerodha as the initial broker; Groww retained as a possible later adapter.

### Out of scope for v1

- F&O, margin/leverage, intraday scalping, market/IOC orders, copy trading and client-account execution.
- Auto-generated strategy changes, browser/screen scraping, unattended 2FA bypass, and ML/LLM discretionary order decisions.

## Operating model: minimal manual intervention

The standard personal API routes require a daily supported authorisation step:

- Zerodha Kite access tokens expire at 6 AM the next day.
- Groww access tokens expire daily; its API-key/secret and TOTP flows also document a daily approval requirement.

The agreed model is **minimal-touch**: the owner completes the short daily authorisation and readiness check, then the bot automatically performs analysis, risk checks, execution, reconciliation, reporting and alerting. Do not automate or bypass 2FA/TOTP in a manner not expressly supported by the broker.

### Daily owner interaction (target: under two minutes)

1. A pre-market alert provides the official broker authorisation link; the bot stays paused.
2. The owner completes the official login/approval flow.
3. The bot validates session, static IP, cash/margins, market calendar, time synchronisation and prior reconciliation, then sends one **ready** or **blocked** alert.
4. If it is not ready by the configured cut-off, it places no new orders. No manual signal approval, order entry, spreadsheet upload or normal-path reconciliation is required.

## Regulatory guardrails

1. Trade only the owner's account. Do not sell signals, trade for others, pool money, or promise returns.
2. Treat all API orders as algo orders. Use broker-approved static-IP whitelisting and comply with order tagging and broker risk controls.
3. Keep client-generated automation at or below 10 orders/second per exchange/segment unless the broker completes the required registration process.
4. In v1, submit only limit and stop-limit orders; do not rely on market or IOC orders.
5. Retain a complete decision, order, fill, configuration and reconciliation history. NSE requires the broker audit trail to be retained for at least five years; the project will retain its own records as well.
6. Revalidate broker/API/NSE policies before production and after material strategy, infrastructure or regulatory changes.

## Recommended architecture

```text
Broker/NSE data ─┐
                 ├─> Signal & portfolio engine ─> Independent risk gate ─> Broker adapter ─> Broker API
Corporate data ──┘                                      │                          │
                                                        └─> Kill switch            └─> Order/position reconciler
                                                                                              │
                                                                                              └─> PostgreSQL audit ledger ─> Alerts/dashboard
```

The risk gate is a separate code module and has authority to block a valid strategy signal when data is stale, buying power is insufficient, price/size limits are breached, an order is duplicated, or broker state cannot be reconciled.

## Technology decisions

| Layer              | Decision                                                                                               | Rationale                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Application        | Node.js 22 LTS, TypeScript, Fastify, Zod, typed domain models                                          | A single strongly typed language for API, scheduler, strategy, risk and broker adapters; runtime validation protects the order boundary. |
| Broker integration | Broker adapter interface; `KiteAdapter` first, `GrowwAdapter` later if justified                       | Keeps broker APIs out of strategy logic and supports test doubles/migration.                                                             |
| Storage            | PostgreSQL, Prisma ORM and version-controlled migrations                                               | Transactional audit ledger and controlled schema evolution.                                                                              |
| Research           | TypeScript strategy simulator, `decimal.js`, and custom cost/slippage modelling                        | Repeatable research in the same language as production; avoids floating-point errors and backtest/live divergence.                       |
| Hosting            | Docker on Linux VM with a reserved public IPv4                                                         | Static broker-whitelisted egress IP and isolation from personal devices.                                                                 |
| Security           | Secret manager/encrypted secrets, least-privilege SSH, MFA, encrypted backups, pinned dependencies     | Prevents account compromise and accidental secret leakage.                                                                               |
| Monitoring         | Structured logs, health checks, error tracking, uptime monitor, Telegram/email alerts                  | Detects failed, partial and delayed order flows quickly.                                                                                 |
| Quality            | GitHub, Actions CI, pnpm, ESLint, Prettier, TypeScript strict mode, Vitest, dependency/container scans | Blocks unsafe changes before deployment.                                                                                                 |

**v1 architecture decision:** a modular monolith on one static-IP VM. Do not use microservices or Kubernetes until operational evidence requires them.

## Build vs. outsource

| Capability                                                          | Approach                                                               | Reason                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Execution, custody, exchange membership, contract notes, broker RMS | Outsource to the broker                                                | Core regulated broker/exchange capabilities.                      |
| Data feed and instrument master                                     | Start with selected broker APIs                                        | Lowest-cost path for a low-frequency personal system.             |
| Truly hands-free execution                                          | Outsource only to broker-supported, NSE-empanelled provider            | Avoids building a non-compliant/unsupported authentication route. |
| Signal, allocation, risk policy, decision record                    | Build and retain control                                               | These are the project’s transparent, testable logic.              |
| Fundamental/corporate action data                                   | Use a reviewed source; license it before depending on it automatically | Do not rely on unaudited scraping for money-moving decisions.     |
| Source control, monitoring, backups                                 | Use managed/commodity services                                         | Reduces operations risk.                                          |

### Provider due diligence (mandatory before purchase)

- Confirm current NSE empanelment and algo type; white-box is preferred.
- Confirm the exact commercial and technical link with Zerodha or Groww—not merely NSE listing.
- Obtain clarity on static IP, algo tagging, registration, hosting, authentication, alerting, audit export, kill switch, SLA, data ownership and termination.
- Never disclose broker passwords, PINs, raw TOTP seeds or unencrypted access tokens.
- Evaluate performance only after realistic costs, slippage, impact, corporate actions, survivorship and delistings are included.

## Delivery roadmap and gates

| Phase                          |             Target | Deliverables                                                             | Exit gate                                                                                    |
| ------------------------------ | -----------------: | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 0. Charter & broker validation |             Week 1 | Investment/risk objectives; broker responses; one broker chosen          | Written broker answer on API, static IP, tagging, daily auth and hosted-provider route.      |
| 1. Strategy specification      |          Weeks 1–2 | Universe, horizon, benchmark, entry/exit/allocation rules, limits        | A versioned rules document exists before implementation.                                     |
| 2. Research & data validation  |          Weeks 2–5 | Reproducible pipeline, walk-forward/out-of-sample report, test suite     | No look-ahead/survivorship bias; results include all expected costs.                         |
| 3. Execution & safety controls |          Weeks 4–7 | Adapter, risk gate, reconciliation, audit log, secrets, alerts, recovery | Fault tests prove safe handling of timeout, duplicate, stale data, restart and partial fill. |
| 4. Shadow operation            | Minimum 8–12 weeks | Live signals with simulated orders; daily mismatch and cost reports      | No unexplained order/position mismatch; recovery rehearsal passes.                           |
| 5. Controlled production       |   At least 4 weeks | Small pre-approved capital deployment                                    | Actual outcome/fills/costs match expectations; risk owner signs release review.              |
| 6. Operations                  |            Ongoing | Daily report, monthly review, quarterly restore test                     | Records, backups, patching and kill switch are demonstrated.                                 |

## Mandatory controls

- **Capital:** approved maximum portfolio deployment, single-stock position, sector exposure, daily purchase amount and cash reserve.
- **Loss/anomaly:** block new orders after the configured loss threshold, repeated rejected orders, stale data, unexpected spread, broker outage or reconciliation failure.
- **Execution:** deterministic client order IDs, price/notional/quantity limits, price collars, limit/stop-limit orders, no averaging down and no unbounded retries.
- **Emergency:** an independently accessible kill switch must disable new entries; exit policy must be defined in advance.
- **Change management:** pull request, tests, review, versioned config, shadow validation and cooling period before material changes go live.

## Broker assessment

| Topic                    | Zerodha + Kite Connect                                                                                    | Groww Trading API                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| API cost                 | Personal order/account API: free. Real-time/historical-data Connect plan: ₹500/month per app.             | ₹499/month plus taxes for data, orders, portfolio and margin APIs.                    |
| Supported v1 market      | NSE cash-equities/ETFs; other activated segments subject to broker/account terms                          | NSE/BSE cash and F&O; docs say MCX is not available via this API.                     |
| Daily session constraint | Access token expires at 6 AM the next day.                                                                | Token expires daily; documented API-key/secret and TOTP flows require daily approval. |
| Static IP                | Required for API-based order placement from 1 April 2026.                                                 | Confirm current onboarding policy with Groww in writing.                              |
| v1 recommendation        | **Use as primary** if daily authorisation is acceptable or a broker-supported hosted option is confirmed. | Evaluate as a later adapter after reconciliation controls have been proven.           |

Do not run one strategy through both brokers until order, position, cash, tax and contract-note reconciliation works reliably with a single broker.

## Monthly operating-cost estimate

_Planning estimate, 31 July 2026. Excludes investment capital, one-time engineering, exchange/broker registration and transaction-linked charges. Verify official prices at purchase time._

| Item                                 |                Estimate/month | Assumption                                                                |
| ------------------------------------ | ----------------------------: | ------------------------------------------------------------------------- |
| Zerodha data API                     |       ₹500 + GST (about ₹590) | Select this **or** Groww, not both.                                       |
| Groww API                            |       ₹499 + GST (about ₹589) | Alternative to Zerodha in v1.                                             |
| 2 GB Linux static-IP VM              |           about ₹1,000–₹1,200 | AWS Lightsail currently lists US$12/month for public IPv4, plus FX/taxes. |
| Encrypted backup, monitoring, alerts |                     ₹200–₹800 | Free tiers are acceptable only for early shadow use.                      |
| **In-house v1 fixed cost**           | **about ₹1,800–₹2,600/month** | One broker + VM + basic operations; cloud tax/FX may vary.                |
| **Resilient configuration**          | **about ₹3,500–₹6,500/month** | Warm standby, independent backups, expanded monitoring/log retention.     |

Variable costs are material: brokerage, STT, exchange transaction charge, GST, stamp duty and DP charges vary by broker, trade type and turnover. Equity delivery at Zerodha has zero brokerage but is not charge-free. Budget them separately from infrastructure.

## Risk register

| Risk                                                   | Severity | Control/response                                                                                                 |
| ------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| Strategy loss, overfitting or regime change            | Critical | Walk-forward testing, conservative capital ramp, benchmark comparison, maximum-drawdown policy and review.       |
| Leverage/F&O/concentration magnifies loss              | Critical | Excluded from v1; hard position, sector, notional and cash limits.                                               |
| Duplicate/stale/buggy order                            | Critical | Idempotency, pre-trade risk checks, reconciliation, fault tests and kill switch.                                 |
| Broker outage, rejection, partial fill or token expiry | High     | Daily readiness test, state reconciliation, backoff, alerting and runbook; a timeout never means “no order.”     |
| Regulatory breach                                      | Critical | Whitelisted static IP, tagging, <=10 OPS unless registered, allowed order types, broker/provider confirmation.   |
| Credential theft/unauthorised trade                    | Critical | MFA, secret manager, least privilege, no secret in code/logs/chat, IP whitelist and token rotation.              |
| Bad/stale price or corporate-action data               | High     | Freshness/integrity checks, versioned instrument master, corporate-action-aware testing; block on inconsistency. |
| Illiquidity, gaps, slippage, partial fills             | High     | Liquid universe, price collar, participation cap, limit orders and fill-aware rebalancing.                       |
| VM/static-IP failure                                   | High     | Encrypted backup, restore tests, documented approved failover/static-IP path.                                    |
| Tax/reporting error                                    | High     | Preserve contract notes and charge data; daily reconciliation; use qualified Indian tax advice.                  |
| Vendor failure/mis-selling                             | High     | NSE/broker verification, export rights, termination plan, no performance promises.                               |
| Change/config error                                    | Medium   | PR review, CI, separated environments, immutable config versions and break-glass process.                        |

## Team responsibilities

| Role                  | Accountabilities                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Project owner         | Approves strategy scope, broker choice, capital, risk limits and release gates; accepts investment risk.    |
| Technical owner       | Architecture, implementation, test coverage, deployments, incident remediation and backup/restore evidence. |
| Risk/compliance owner | Reviews policies, regulatory changes, provider due diligence, kill-switch controls and release evidence.    |
| Operations owner      | Daily report health, alert routing, reconciliation follow-up, credential rotation and review scheduling.    |
| Tax adviser           | Reviews reporting, realised gains/losses, charges and records before scale-up.                              |

## Decisions and open actions

| ID   | Decision/action                                                                                                     | Owner                     | Due date     | Status  |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------ | ------- |
| D-01 | Daily authorisation is acceptable; minimise routine manual work to the supported authorisation and readiness check. | Project owner             | 31 July 2026 | Decided |
| D-02 | Obtain written API/retail-algo answers from Zerodha and Groww.                                                      | Project owner             | _Assign_     | Open    |
| D-03 | Choose the initial broker and verify static-IP onboarding.                                                          | Project + technical owner | _Assign_     | Open    |
| D-04 | Approve investment/risk policy and v1 universe.                                                                     | Project + risk owner      | _Assign_     | Open    |
| D-05 | If zero-touch is required, shortlist broker-supported providers from the current NSE list.                          | Risk + technical owner    | _Assign_     | Open    |
| D-06 | Create repository, CI/security controls and phase-0 evidence folder.                                                | Technical owner           | _Assign_     | Open    |

## Project update cadence

- **Daily during shadow/live operation:** automatic run, exposure, order/fill, error and reconciliation summary.
- **Weekly:** delivery status, open risks, incidents, broker/API changes and upcoming releases.
- **Monthly:** strategy performance vs. benchmark, realised costs/slippage, risk-limit review, dependency/security patch review and provider review.
- **Quarterly:** disaster recovery/restore test and full access/credential review.

## Authoritative references

- [SEBI: Safer participation of retail investors in algorithmic trading](https://www.sebi.gov.in/legal/circulars/feb-2025/safer-participation-of-retail-investors-in-algorithmic-trading_91614.html)
- [NSE: Retail-algo implementation standards](https://nsearchives.nseindia.com/content/circulars/INVG67858.pdf)
- [NSE: Retail-algo FAQs](https://nsearchives.nseindia.com/web/sites/default/files/inline-files/FAQ_Retail%20Algo_03112025_NSE.pdf)
- [NSE: Current empanelled algo-provider list](https://www.nseindia.com/static/trade/empanelled-algo-providers-exchange)
- [Zerodha: Kite Connect plans and price](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/what-are-the-charges-for-kite-apis)
- [Zerodha: Static-IP requirement](https://support.zerodha.com/category/trading-and-markets/general-kite/kite-api/articles/static-ip)
- [Zerodha: Session lifecycle](https://kite.trade/docs/connect/v3/user/)
- [Groww: Trading API plans](https://groww.in/trade-api)
- [Groww: API authentication and rate limits](https://groww.in/trade-api/docs/curl)
- [Zerodha: Brokerage and statutory charges](https://zerodha.com/charges/)
- [AWS Lightsail: Linux public-IPv4 bundle prices](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)

> This page is an engineering and operating plan, not personal investment advice or a promise of returns. Have a SEBI-registered professional and a qualified Indian tax adviser review the strategy and personal circumstances before live deployment.
