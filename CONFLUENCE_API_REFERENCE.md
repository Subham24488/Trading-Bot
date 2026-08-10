# Trading Bot API Reference

| Field | Value |
|---|---|
| Document status | Current implementation contract |
| API version | `v1` |
| Last reviewed | 1 August 2026 |
| Base URL (local development) | `http://localhost:3000` |
| Content type | JSON responses; no request body is currently required by any endpoint |
| Authentication | `x-admin-token` required for control and manual-run endpoints |
| Deployment state | Paper-trading scaffold only; no live broker order endpoint exists |

> **Safety notice:** This API does not currently place real orders. `PaperBroker` is the sole enabled broker, the service begins in a paused state, and no investment strategy is enabled. Do not expose this local API to the public internet.

## 1. Overview

The Trading Bot API is a small operational API for observing and controlling the service. It is not a public trading API and should be accessed only from a trusted local machine or private network.

The server starts only after it has connected to PostgreSQL and started its PostgreSQL-backed scheduler. Therefore, a database connection failure prevents all API endpoints from becoming available.

### Service lifecycle

```text
Start service
  -> validate environment configuration
  -> connect pg-boss scheduler to PostgreSQL
  -> start Fastify HTTP server
  -> expose health/readiness/control endpoints

Initial state: paused
  -> authenticated operator resumes service
  -> scheduled or manual daily cycle can run
  -> current scaffold audits the cycle but creates no broker orders
```

## 2. Local setup and base URL

Create a `.env` file from `.env.example`, configure a working `DATABASE_URL` and a long random `ADMIN_TOKEN`, then apply migrations and start the service:

```powershell
pnpm db:deploy
pnpm dev
```

The default server address is:

```text
http://localhost:3000
```

The configured application port can be changed through the `PORT` environment variable. The process binds to `0.0.0.0`; use firewall rules or a reverse proxy before allowing any network access.

## 3. Authentication and authorization

### Admin token

The following endpoints require this HTTP header:

```http
x-admin-token: <value-of-ADMIN_TOKEN>
```

`ADMIN_TOKEN` must contain at least 24 characters. It is compared using a constant-time comparison and must never be committed to Git, added to Confluence, sent in chat, or included in screenshots.

The health and readiness endpoints are currently unauthenticated. Treat them as internal-only operational endpoints.

### Authentication failure

If the header is missing or incorrect, the API returns HTTP `401`.

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "A valid x-admin-token is required."
}
```

## 4. Endpoints

### 4.1 `GET /health`

Checks that the HTTP service is running and PostgreSQL is reachable.

| Property | Value |
|---|---|
| Authentication | Not required |
| Request body | None |
| Success status | `200 OK` |
| Database behaviour | Executes `SELECT 1`; it is a real database readiness check |

Example:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Successful response:

```json
{
  "status": "ok",
  "mode": "paper"
}
```

`mode` reflects the `TRADING_MODE` configuration (`paper` or `live`). It does **not** mean live execution is available; the currently wired broker remains paper-only.

Failure behaviour:

- `500 Internal Server Error` when PostgreSQL is unreachable after the service has started.
- Connection failure/no response when the service cannot start, for example when `pg-boss` cannot connect to PostgreSQL.

### 4.2 `GET /api/v1/readiness`

Returns the current operational state. Use it before resuming the bot or investigating why a daily cycle did not place orders.

| Property | Value |
|---|---|
| Authentication | Not required |
| Request body | None |
| Success status | `200 OK` |

Example:

```powershell
Invoke-RestMethod http://localhost:3000/api/v1/readiness
```

Initial response after startup:

```json
{
  "mode": "PAPER",
  "broker": "paper",
  "paused": true,
  "reason": "Awaiting supported daily broker authorisation and readiness check.",
  "strategyEnabled": false
}
```

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `mode` | `PAPER` \| `LIVE` | Internal configured trading mode. It is not proof that live execution is enabled. |
| `broker` | string | Active broker adapter. Current value: `paper`. |
| `paused` | boolean | Whether the bot rejects the daily cycle before it creates a run. |
| `reason` | string \| `null` | Explanation for the current paused state. |
| `strategyEnabled` | boolean | Current value: `false`; no production strategy is implemented. |

### 4.3 `POST /api/v1/control/pause`

Immediately pauses normal daily-cycle execution. Use this as the operational kill switch for **new** work. It does not cancel an already-submitted broker order because real execution is not implemented yet.

| Property | Value |
|---|---|
| Authentication | Required: `x-admin-token` |
| Request body | None |
| Success status | `200 OK` |

Example:

```powershell
$headers = @{ 'x-admin-token' = $env:ADMIN_TOKEN }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/control/pause -Headers $headers
```

Successful response:

```json
{
  "mode": "PAPER",
  "broker": "paper",
  "paused": true,
  "reason": "Paused by an authenticated operator.",
  "strategyEnabled": false
}
```

### 4.4 `POST /api/v1/control/resume`

Removes the in-memory pause flag. In the current scaffold it only permits a daily cycle to create its audit record; it does not enable strategy signals or broker order placement.

| Property | Value |
|---|---|
| Authentication | Required: `x-admin-token` |
| Request body | None |
| Success status | `200 OK` |

Example:

```powershell
$headers = @{ 'x-admin-token' = $env:ADMIN_TOKEN }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/control/resume -Headers $headers
```

Successful response:

```json
{
  "mode": "PAPER",
  "broker": "paper",
  "paused": false,
  "reason": null,
  "strategyEnabled": false
}
```

> The pause state is currently in memory. Restarting the service returns it to the safe paused state. Persistent kill-switch state is a planned production enhancement.

### 4.5 `POST /api/v1/runs/daily`

Triggers the current daily-cycle workflow manually. This endpoint exists for controlled testing and operations; the scheduler runs the same workflow on weekdays at 08:15 Asia/Kolkata time.

| Property | Value |
|---|---|
| Authentication | Required: `x-admin-token` |
| Request body | None |
| Success status | `200 OK` |
| Side effects | Creates an audit `TradingRun` only when unpaused; current code creates no broker orders |

Example:

```powershell
$headers = @{ 'x-admin-token' = $env:ADMIN_TOKEN }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/runs/daily -Headers $headers
```

Paused response:

```json
{
  "status": "blocked",
  "reason": "Awaiting supported daily broker authorisation and readiness check."
}
```

Unpaused response in the current scaffold:

```json
{
  "runId": "clx...",
  "status": "completed",
  "reason": "No approved strategy is enabled."
}
```

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `runId` | string, optional | Database identifier for a created `TradingRun`. It is absent when the bot is paused. |
| `status` | `blocked` \| `completed` | Whether the cycle was stopped by control state or completed. |
| `reason` | string | Human-readable result explanation. |

## 5. Automated scheduled job

| Setting | Current behaviour |
|---|---|
| Job name | `daily-trading-cycle` |
| Scheduler | `pg-boss`, backed by PostgreSQL |
| Schedule | Weekdays at 08:15 Asia/Kolkata |
| Workflow | Calls the same `runDailyCycle()` service method as `POST /api/v1/runs/daily` |
| Current outcome | Remains blocked while paused; otherwise writes an audit run and creates no orders |

## 6. Database records created by the API

| Table | Created/updated by current API | Purpose |
|---|---|---|
| `TradingRun` | `POST /api/v1/runs/daily` when unpaused | Records a run’s mode, status, timestamps and failure reason. |
| `AuditEvent` | A started daily cycle | Records strategy status or errors linked to a run. |
| `BrokerOrder` | Not created yet | Reserved for future risk-approved broker orders. |

Inspect these records with Prisma Studio:

```powershell
pnpm db:studio
```

## 7. Current limitations and non-existent endpoints

The following are intentionally **not implemented** and must not be assumed to exist:

- Live Zerodha/Kite or Groww authentication, order placement, modification, cancellation or order-book APIs.
- Strategy configuration, signal generation, portfolio allocation, backtesting or trade recommendation endpoints.
- Broker position, holdings, margin, funds, P&L, contract-note or market-data endpoints.
- User accounts, browser login, token refresh, OAuth callback or automatic TOTP handling.
- Web UI/dashboard, OpenAPI/Swagger endpoint, rate limiting, request IDs, persistent pause state or multi-user authorization.

`TRADING_MODE=live` requires an explicit acknowledgement in environment configuration, but the process still instantiates `PaperBroker`. This is a deliberate fail-safe until a reviewed and broker-compliant adapter is completed.

## 8. API security and operational requirements

1. Keep the server behind the Windows firewall, a private network, or an authenticated reverse proxy. Do not port-forward port `3000`.
2. Generate a unique `ADMIN_TOKEN` of at least 32 random characters; rotate it after suspected disclosure.
3. Use HTTPS/TLS if the API is ever accessed off-host. Do not send `x-admin-token` over plain HTTP on an untrusted network.
4. Store secrets only in an approved secret manager or a local `.env` file excluded from Git.
5. Use `GET /health` for service/database monitoring and `GET /api/v1/readiness` for operational state monitoring.
6. Pause the bot before changing configuration, database schema, broker implementation or strategy code.
7. Treat an inability to reach `/health` as a fail-closed condition: do not manually assume an automated cycle has completed.

## 9. Example operational sequence

```powershell
# 1. Verify server and database availability
Invoke-RestMethod http://localhost:3000/health

# 2. Inspect state (normally paused after startup)
Invoke-RestMethod http://localhost:3000/api/v1/readiness

# 3. Provide the local admin token only from the current shell session
$headers = @{ 'x-admin-token' = $env:ADMIN_TOKEN }

# 4. Resume after the approved daily authorisation/readiness checks
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/control/resume -Headers $headers

# 5. Test the daily-cycle path (it will audit but will not trade)
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/runs/daily -Headers $headers

# 6. Pause again when testing is finished
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/control/pause -Headers $headers
```

## 10. Change-control requirements

Any new endpoint capable of moving money, changing risk limits, altering the allowed universe, submitting broker orders, or managing credentials requires:

- A written API contract and threat model.
- Stronger authentication and authorization than the current single admin token.
- Schema validation for every request and response.
- Idempotency keys, audit logging and reconciliation.
- Rate limits, request IDs, monitoring, alerts and integration tests.
- Paper/shadow validation and explicit release approval before live use.

> This document describes the code currently present in the repository. It is not investment advice and does not imply that live trading is enabled or approved.
