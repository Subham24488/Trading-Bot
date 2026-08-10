Implement KiteBroker (class-only)

Scope





Implement [src/broker/KiteBroker.ts](src/broker/KiteBroker.ts) against [BrokerAdapter](src/broker/BrokerAdapter.ts).



Add kiteconnect dependency.



Add unit tests with a mocked Kite client (no real API calls).



Do not change [src/server.ts](src/server.ts) — it stays on PaperBroker.



Auth: require KITE_API_KEY + KITE_ACCESS_TOKEN from [config.kite](src/config.ts); no login/session helper.

Implementation

1. Dependency

Install official client per kiteconnectjs:

pnpm add kiteconnect

2. KiteBroker constructor





Accept optional deps for testability: { apiKey, accessToken, client? } with defaults from config.kite.



Create new KiteConnect({ api_key }), then setAccessToken(accessToken).



Throw a clear error at construction if apiKey or accessToken is missing/empty.

3. getPortfolio()

Map Kite account state into PortfolioSnapshot:





Cash: getMargins('equity') → use available cash (available.cash / equivalent field from response).



Positions: getHoldings() → Map<tradingsymbol, quantity> (long-only delivery holdings; ignore zero qty).



asOf: new Date().

4. placeLimitOrder(order)

Place NSE cash delivery limit orders only (matches project charter: long-only ETF/equity delivery):

await client.placeOrder('regular', {
  exchange: 'NSE',
  tradingsymbol: order.symbol,
  transaction_type: order.side, // BUY | SELL
  quantity: order.quantity,
  product: 'CNC',
  order_type: 'LIMIT',
  price: Number(order.limitPrice),
  validity: 'DAY',
  tag: order.clientOrderId.slice(0, 20), // Kite tag max length
});

Result mapping into existing BrokerOrderResult (FILLED | REJECTED only):





On API success: fetch order status via getOrderHistory(order_id) (or equivalent) and map:





COMPLETE → FILLED with filled qty / average price



rejection-like terminal states → REJECTED with reason



non-terminal (e.g. OPEN, TRIGGER PENDING) → treat as REJECTED with reason that the order is resting/unfilled, or prefer: return FILLED only when complete; for open orders return REJECTED with "Order accepted but not filled" so callers never assume fill — actually better: expand isn't allowed in this task. Use: success placement that isn't COMPLETE returns status REJECTED with reason describing current status (conservative; no false fills). Wait - that's wrong for OPEN orders that may fill later.

Better fit for current domain type without expanding it:





API error → REJECTED with broker message



Order COMPLETE → FILLED



Order placed but not yet COMPLETE → return FILLED-unsafe. Domain only has FILLED|REJECTED.

Chosen behavior: On successful placeOrder, immediately read order history:





COMPLETE → FILLED



REJECTED / CANCELLED → REJECTED



Still open → return status: 'REJECTED' with reason Order placed (status=<X>) but not filled yet — conservative for the current narrow result type, documented in a short class comment. (Later work can widen the domain status enum.)

Also reject duplicates in-process with the same clientOrderId pattern as [PaperBroker](src/broker/PaperBroker.ts) (local Set), since Kite tag is not a hard idempotency key.

5. Tests

Add [test/KiteBroker.test.ts](test/KiteBroker.test.ts):





Construction fails without credentials



getPortfolio maps margins + holdings



placeLimitOrder maps COMPLETE → FILLED



Duplicate clientOrderId → REJECTED



API failure → REJECTED with reason

Mock the Kite client methods; do not hit the network.

Out of scope





Wiring live mode in server.ts



Session/login URL / generateSession flow



WebSocket ticker / market data



Expanding BrokerOrderResult statuses beyond FILLED | REJECTED



Docs/README updates unless needed for typecheck

Credential note

Use env vars via config only. Do not hardcode or log secrets. You will need a non-empty KITE_ACCESS_TOKEN in .env to exercise the adapter manually.