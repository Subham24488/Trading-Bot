---
name: Manual LLM loop API
overview: Stop auto-starting the BUY/HOLD/EXIT interval at boot. Arm and stop that loop only through admin APIs, mirroring session start/stop. Universe suggest stays a separate POST.
todos:
  - id: remove-boot-start
    content: Remove startDecisionLoop() from main(); keep HF connect and onClose stop()
    status: completed
  - id: loop-api
    content: Add GET/POST start/stop /api/v1/llm/decisions* and isDecisionLoopRunning + 400 if already started; run first cycle immediately
    status: completed
isProject: false
---

# Manual LLM decision-loop start

## Change

[`main()`](src/server.ts) currently connects Hugging Face and then calls `llmAdvisor.startDecisionLoop()` before listen. Remove that auto-start. Hugging Face `connect()` stays at boot so `POST /api/v1/llm/universe` still works without starting the 15-minute loop.

## API (session-style)

Add three admin-token routes next to the existing universe endpoints in [`src/server.ts`](src/server.ts):

- `POST /api/v1/llm/decisions/start` → `startDecisionLoop()` then return status
- `POST /api/v1/llm/decisions/stop` → `stop()` then return status
- `GET /api/v1/llm/decisions` → status only (running, interval, watchlist file, included symbols)

`POST /api/v1/llm/universe` does **not** start the loop.

## Service tweaks

In [`src/llm/LlmTradeAdvisorService.ts`](src/llm/LlmTradeAdvisorService.ts):

- Add `isDecisionLoopRunning()` (timer defined).
- `startDecisionLoop()`: if already running, throw 400 (same pattern as [`MarketDataSessionService.start`](src/services/MarketDataSessionService.ts)).
- After arming `setInterval`, **run one `runDecisionCycle()` immediately** so a manual start does not wait a full 15 minutes. Cycles still skip when there is no watchlist or no quote snapshots.
- `stop()` stays idempotent; keep calling it from the Fastify `onClose` hook.

Return a small status object from start/stop/get, e.g. `{ running, decisionIntervalMinutes, includedSymbols, watchlistFile }`.

## Tests

- [`test/llmAdvisor.test.ts`](test/llmAdvisor.test.ts): source check that `server.ts` `main()` does not call `startDecisionLoop` (only the route handler may).
- Optional: start-when-already-running throws 400; stop when idle is fine.

No broker orders, no universe pipeline changes.