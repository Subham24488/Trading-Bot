ML Paper Session — Implementation Plan
Goal
Deliver a local, long-running service that during 09:00–15:00 IST:

Streams Kite live quotes into the app via WebSocket for only instruments passed on session start

Scores those instruments with a trained LightGBM model

Places paper entries/exits through [RiskGate](src/risk/RiskGate.ts) → [PaperBroker](src/broker/PaperBroker.ts)

Persists entry and exit in Postgres

Operator controls the session with new start/stop APIs. The Node process stays up when stopped or outside hours.

Hard constraints
Constraint

Rule

Existing APIs

Do not change or remove GET /health, GET /api/v1/readiness, GET /api/v1/portfolio

Commented routes

Leave commented pause/resume/daily blocks in [src/server.ts](src/server.ts) untouched

Session universe

POST /api/v1/session/start requires instrumentToken per stock; subscribe/quote/history only that set

Execution

Session uses PaperBroker only; never KiteBroker.placeLimitOrder from the runner

Live data

WebSocket via official KiteTicker (Kite WebSocket docs); no hand-rolled binary parser

Current baseline
[KiteBroker](src/broker/KiteBroker.ts): implemented (kiteconnect, session, portfolio, live order path exists but unused by this feature)

[PaperBroker](src/broker/PaperBroker.ts): instant paper fills

[TradingService](src/services/TradingService.ts): no strategy; strategyEnabled: false

[prisma/schema.prisma](prisma/schema.prisma): TradingRun, BrokerOrder, AuditEvent only

No src/broker/kite/, no ml/, no session runner



flowchart LR
  StartAPI["POST session/start"] --> SessionControl
  StopAPI["POST session/stop"] --> SessionControl
  SessionControl --> Runner[MarketSessionRunner]
  SessionControl --> Ticker[KiteTickerStream]
  Ticker -->|"subscribe start tokens only"| KiteWS["wss://ws.kite.trade"]
  KiteWS --> QuoteCache
  QuoteCache --> Runner
  Runner --> ML[LightGBM infer]
  ML --> Risk[RiskGate]
  Risk --> Paper[PaperBroker]
  Paper --> DB[(PaperTrade)]
Phase 1 — Schema, config, domain types
Prisma migration
Add to [prisma/schema.prisma](prisma/schema.prisma):

PaperTrade — instrumentToken, symbol, quantity, status (OPEN  CLOSED), entry fields (entrySide, entryAt, entryPrice, entryClientOrderId, entryScore, entryModelVersion), exit fields (nullable while open), realizedPnl

MarketCandle — symbol, interval, ts, OHLCV, source; unique on (symbol, interval, ts)

ModelArtifact — version, trainedAt, metrics JSON, artifactPath, featureSchemaVersion

Run pnpm db:migrate.

Config ([src/config.ts](src/config.ts), [.env.example](.env.example))
Add Zod-validated keys:

STRATEGY_MODE (ml_paper_session  none, default none)

SESSION_START_HOUR, SESSION_END_HOUR (default 9 / 15)

SESSION_TICK_SECONDS (default 60)

KITE_WS_MODE (quote  ltp  full, default quote)

MAX_SESSION_INSTRUMENTS, QUOTE_STALE_MS, FLAT_AT_SESSION_END

ML_PYTHON_BIN, ML_ARTIFACT_PATH, ML_MIN_CONFIDENCE, ML_MAX_OPEN_TRADES

Domain ([src/domain.ts](src/domain.ts))
Add types: SessionInstrument, SessionStatus, PaperTradeView, MlSignal, Zod schemas for start request body.

Phase 2 — Kite market data layer
New package under src/broker/kite/:

File

Responsibility

QuoteCache.ts

In-memory last tick per instrumentToken (LTP, OHLC, volume, receivedAt)

KiteTickerStream.ts

KiteTicker lifecycle: connect with shared access token from KiteBroker, subscribe / setMode only active token list, reconnect + re-subscribe, unsubscribe + disconnect on stop

KiteMarketDataClient.ts

Daily instruments CSV cache for validation; scoped GET /quote (or ohlc/ltp) for exchange:tradingsymbol of session set only (market quotes); historical candles for training/warmup

Stale guard: if quoteAgeMs > QUOTE_STALE_MS, block new paper entries; audit via [AuditService](src/services/AuditService.ts).

Reuse KiteBroker.ensureAccessToken() — inject KiteBroker into ticker/data client, do not duplicate auth.

Phase 3 — Session control and HTTP APIs (additive only)
SessionControl (src/services/SessionControl.ts)
Dedicated running flag + active SessionInstrument[]. Do not repurpose [TradingControl](src/services/TradingControl.ts) (keeps commented pause/resume free for later).

PaperTradeService (src/services/PaperTradeService.ts)
CRUD for open/close trades, list for GET /api/v1/trades.

Register in [src/server.ts](src/server.ts) without altering existing route handlers:
Method

Path

Behaviour

POST

/api/v1/session/start

Validate body; intersect with ALLOWED_SYMBOLS; start ticker + runner

POST

/api/v1/session/stop

Stop runner; unsubscribe/disconnect ticker

GET

/api/v1/session

Session + stream health fields

GET

/api/v1/trades

Paper entry/exit list

Start body (required): instruments[] with instrumentToken, exchange, tradingsymbol; optional mode. Empty/invalid → 400, no ticker connect.

Also construct PaperBroker beside existing KiteBroker on TradingService (portfolio path unchanged).

Phase 4 — Python ML sidecar
New ml/ package:

requirements.txt — lightgbm, pandas, numpy, scikit-learn, joblib

features.py, labels.py — no-lookahead indicators and labels

train.py — walk-forward train → ml/artifacts/ + metrics JSON

infer.py — stdin/argv JSON in → { symbol, side, score, confidence }[] stdout

Node invokes via child_process using ML_PYTHON_BIN. Add pnpm scripts: ml:train, ml:infer (optional ml:fetch-history for offline backfill).

MlSignalStrategy (src/strategy/MlSignalStrategy.ts)
Build feature snapshot from QuoteCache (+ recent candles if needed), call infer, filter by ML_MIN_CONFIDENCE.

Phase 5 — Market session runner
MarketSessionRunner (src/services/MarketSessionRunner.ts)
Register interval timer at server startup; gate on SessionControl.isRunning() + IST market window

Each tick when active:

Require websocketConnected and fresh quotes

Infer for active instruments only

BUY + no open PaperTrade → size from notional → RiskGate.evaluate → PaperBroker.placeLimitOrder (limit = stream LTP) → insert OPEN row + optional BrokerOrder/AuditEvent

SELL / exit signal → close OPEN → update exit fields + realizedPnl

If FLAT_AT_SESSION_END near 15:00, close remaining opens

Outside hours or stopped: no-op; do not exit process

Keep [scheduler.ts](src/scheduler.ts) daily-trading-cycle as-is.

Phase 6 — Tests and docs
Vitest
Start without instruments → 400; ticker not connected

Start with tokens A,B → subscribe exactly [A,B]

Symbol outside ALLOWED_SYMBOLS rejected

Mock ticker tick → QuoteCache update

Stale/disconnected stream blocks new entries

Entry creates OPEN; exit closes with PnL

Existing health/readiness/portfolio behaviour unchanged

Docs
Add [docs/ML_PAPER_SESSION_API.md](docs/ML_PAPER_SESSION_API.md) (presentation-style spec already drafted in conversation). Optionally sync Confluence manually.

Implementation order
Prisma models + config + domain types

QuoteCache, KiteTickerStream, KiteMarketDataClient

SessionControl, PaperTradeService, session/trades routes (additive in server)

ml/ train/infer + first artifact on small universe

MlSignalStrategy + MarketSessionRunner

Tests + docs

Explicit non-goals
Changing/removing existing HTTP APIs or commented control blocks

Live Kite orders from the model

Auto-subscribing ALLOWED_SYMBOLS without start body tokens

Full-market quote/stream fetches

Persisting every tick to Postgres in v1

Key files to create
src/broker/kite/KiteTickerStream.ts, QuoteCache.ts, KiteMarketDataClient.ts

src/services/SessionControl.ts, MarketSessionRunner.ts, PaperTradeService.ts

src/strategy/MlSignalStrategy.ts

ml/ (Python package)

[prisma/schema.prisma](prisma/schema.prisma), [src/config.ts](src/config.ts), [src/domain.ts](src/domain.ts), [src/server.ts](src/server.ts) (additive wiring only)