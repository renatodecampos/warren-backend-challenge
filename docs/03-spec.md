# 03. Spec

Input: [01 Requirements](01-requirements.md), [02 Design](02-design.md) and the [ADRs](adr/README.md). Output: the code and the tests.

The requirements say **what** the brief asks. The ADRs say **why** each decision was taken. This document says **exactly what to build**: the contract of every endpoint, the rules behind it, the schema changes, the tests, and the order of work. It does not repeat reasons; it links to them.

## 1. How this spec is used

The code is written from this spec with an AI coding assistant. The decisions, the spec and the review of every change are mine.

Rules for whoever implements it, person or assistant:

1. **Spec first.** If the code needs a behaviour that is not written here, stop, decide, and write it here before coding it.
2. **Test first.** Each slice in section 8 starts with its failing tests from section 7.
3. **Nothing extra.** No endpoint, field, dependency or abstraction that this spec does not ask for.
4. **One source per fact.** If this spec and an ADR disagree, that is a defect in one of them: fix the document, then the code.
5. **A slice is done** when its tests pass, the full suite passes, and the type check is clean.

## 2. Conventions

| Topic | Rule |
| --- | --- |
| Format | JSON in and out, `Content-Type: application/json` |
| Money | Pesos as JSON numbers with at most two decimals (`930`, `450.5`, `99999999.99`). More than two decimals is a `400` |
| Percentages | Numbers with two decimals, already multiplied by 100 (`18.18` means 18.18%), rounded half away from zero. `null` when undefined |
| Ids | Positive 32-bit integers |
| Dates | ISO 8601, UTC |
| Request id | Every response carries `X-Request-Id`. An incoming `X-Request-Id` is reused, otherwise one is generated. It is in every log line |
| Logs | One JSON line per request: `requestId`, `method`, `path`, `status`, `durationMs` |
| Errors | Always `{ "error": { "code": "...", "message": "..." } }`. Clients switch on `code` |
| Unknown fields | Refused with `400 VALIDATION_ERROR` |

Internal rule: all arithmetic is in integer cents ([ADR 0006](adr/0006-integer-cents-and-order-value-cap.md)). Requests are converted with `Math.round(value x 100)` after the two-decimal check; responses are converted back at the last step.

### Error codes

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body, query, path or `Idempotency-Key` header does not match the schema, or the body is not valid JSON |
| 400 | `INVALID_INSTRUMENT` | The cash instrument (`MONEDA`) used in `POST /orders` |
| 404 | `USER_NOT_FOUND`, `INSTRUMENT_NOT_FOUND`, `ORDER_NOT_FOUND` | The id or ticker does not exist |
| 404 | `NOT_FOUND` | No such route |
| 409 | `ORDER_NOT_CANCELLABLE` | Cancel of an order that is not `NEW` |
| 422 | `AMOUNT_BELOW_ONE_SHARE` | `amount` buys less than one share |
| 422 | `NO_PRICE_FOR_AMOUNT` | `amount` given and the instrument has no market price |
| 422 | `ORDER_VALUE_TOO_LARGE` | `size x price` above 99,999,999.99, or an `amount` that buys more shares than one order can hold |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request |
| 503 | `BUSY` | Lock or statement timeout. Safe to retry with the same idempotency key |
| 503 | `DATABASE_UNAVAILABLE` | Health check only: the database did not answer |
| 500 | `INTERNAL_ERROR` | Anything else. The message never contains internals |

Rejections by the market are **not** errors. They are a `201` with `status: "REJECTED"` and a `rejectionReason` of `INSUFFICIENT_FUNDS`, `INSUFFICIENT_SHARES` or `NO_MARKET_PRICE` ([ADR 0005](adr/0005-rejected-orders-are-stored.md)).

## 3. Account state: the rule everything shares

One pure function, no I/O, used by the portfolio and by every write. Source: [ADR 0001](adr/0001-orders-table-as-ledger.md), [0002](adr/0002-open-limit-orders-reserve-funds.md), [0007](adr/0007-return-definitions.md).

Input: the user's `FILLED` orders ordered by `datetime`, then `id`, and the user's `NEW` orders.

Output: `cashCents`, `reservedCashCents`, and per instrument `quantity`, `costCents`, `reservedQuantity`.

| Order | Effect |
| --- | --- |
| `FILLED` `CASH_IN` | cash + `size x price` |
| `FILLED` `CASH_OUT` | cash - `size x price` |
| `FILLED` `BUY` | cash - `size x price`; quantity + `size`; cost + `size x price` for the shares that end above zero (all of them when quantity was not negative) |
| `FILLED` `SELL`, `size` < quantity | cash + `size x price`; cost - `round(cost x size / quantity)` computed in `BigInt`, half rounds up; quantity - `size` |
| `FILLED` `SELL`, `size` >= quantity | cash + `size x price`; cost = 0; quantity - `size` (can go below zero) |
| `NEW` `BUY` | reserved cash + `size x price` |
| `NEW` `SELL` | reserved quantity + `size` |
| `REJECTED`, `CANCELLED` | none |

Derived:

- `available cash = cash - reserved cash`
- `available shares = quantity - reserved quantity`

## 4. Endpoints

### 4.1 `GET /users/:userId/portfolio`

FR-P1 to FR-P6. Runs in one `REPEATABLE READ READ ONLY` transaction. Takes no lock.

`200`:

```json
{
  "userId": 1,
  "accountNumber": "10001",
  "currency": "ARS",
  "totalAccountValue": 904784,
  "cashBalance": 753000,
  "reservedCash": 125500,
  "availableBalance": 627500,
  "positions": [
    {
      "instrumentId": 54,
      "ticker": "METR",
      "name": "MetroGAS S.A.",
      "quantity": 500,
      "averageCost": 250,
      "marketPrice": 229.5,
      "marketValue": 114750,
      "totalReturnPercent": -8.2,
      "dailyReturnPercent": -1.08,
      "priceAvailable": true
    },
    {
      "instrumentId": 47,
      "ticker": "PAMP",
      "name": "Pampa Holding S.A.",
      "quantity": 40,
      "averageCost": 930,
      "marketPrice": 925.85,
      "marketValue": 37034,
      "totalReturnPercent": -0.45,
      "dailyReturnPercent": 0.44,
      "priceAvailable": true
    }
  ]
}
```

These are the real values for user 1 of my seed, computed by hand, and they are test P1. PAMP: bought 50 at 930.00, sold 10, so 40 shares at a cost of 37,200.00. BMA (instrument 31) was oversold and is not listed.

Rules:

- `totalAccountValue = cashBalance + sum of marketValue`. Reserved cash is not subtracted.
- Only positions with `quantity > 0` are listed, ordered by `marketValue` descending.
- `marketPrice` is the latest non-null `close`. `marketValue = quantity x marketPrice`, computed in `BigInt` and checked with `Number.isSafeInteger`.
- `averageCost = cost / quantity`, rounded to the cent.
- `totalReturnPercent = (marketValue - cost) / cost x 100`. `null` when cost is zero.
- `dailyReturnPercent = (close - previousClose) / previousClose x 100`. `null` when `previousClose` is null or zero.
- No market price: `marketPrice: null`, `marketValue` = cost, both returns `null`, `priceAvailable: false`.

Errors: `400` bad id, `404 USER_NOT_FOUND`.

### 4.2 `GET /instruments?q=&limit=&offset=`

FR-S1, FR-S2. `q` is required, 1 to 100 characters after trim. `limit` 1 to 100, default 20. `offset` 0 to 2,147,483,647, default 0. An unknown query field is refused like an unknown body field.

`200`: an array of `{ "id", "ticker", "name", "type" }`.

Rules:

- Case-insensitive substring match on `ticker` or `name`. `%` and `_` in `q` are literal.
- The cash instrument (`MONEDA`) is never returned.
- Order: exact ticker, then ticker prefix, then name prefix, then the rest; ties by ticker.

Errors: `400` missing or invalid `q`, `limit`, `offset`.

### 4.3 `POST /orders`

FR-O1 to FR-O7, FR-O10. Optional header `Idempotency-Key` (1 to 50 printable ASCII characters).

Body:

| Field | Type | Rule |
| --- | --- | --- |
| `userId` | id | required |
| `instrumentId` or `ticker` | id, or string of 1 to 10 | exactly one. Ticker match is case-insensitive |
| `side` | `BUY`, `SELL` | required |
| `type` | `MARKET`, `LIMIT` | required |
| `size` or `amount` | positive 32-bit integer, or money | exactly one |
| `price` | money, above zero | required for `LIMIT`, refused for `MARKET` |

Steps, in this order ([ADR 0003](adr/0003-per-user-row-lock.md), [0004](adr/0004-idempotency-key.md)):

1. Validate the body and, if sent, the key. `400` if invalid.
2. `BEGIN` at `READ COMMITTED`.
3. `SELECT id FROM users WHERE id = $1 FOR UPDATE`. `404 USER_NOT_FOUND` if no row.
4. If a key was sent, look for an order of this user with that key. Found with the same `request_hash`: return it with `200`. Found with another hash: `422 IDEMPOTENCY_KEY_REUSED`.
5. Resolve the instrument. `404 INSTRUMENT_NOT_FOUND`; `400 INVALID_INSTRUMENT` for cash.
6. Price: `LIMIT` uses the given price; `MARKET` uses the latest non-null `close`. A `close` that is not above zero is no price.
7. No price (only possible for `MARKET`): with `size`, store `REJECTED` with `NO_MARKET_PRICE` and a null price; with `amount`, `422 NO_PRICE_FOR_AMOUNT`.
8. Size: given, or `floor(amount / price)`. Zero: `422 AMOUNT_BELOW_ONE_SHARE`.
9. `size x price` above the cap: `422 ORDER_VALUE_TOO_LARGE`. Checked before any other use of the product. The same answer when `amount` gives a `size` above 2,147,483,647.
10. Load the account state (section 3).
11. `BUY` with `size x price` > available cash: `REJECTED`, `INSUFFICIENT_FUNDS`. `SELL` with `size` > available shares: `REJECTED`, `INSUFFICIENT_SHARES`.
12. Otherwise status is `FILLED` for `MARKET` and `NEW` for `LIMIT`.
13. `INSERT` the order with the key and the hash, `COMMIT`, answer `201`.

Any `4xx` after step 2 rolls back and stores nothing, including the key.

`201` (or `200` on a replay):

```json
{
  "id": 12,
  "userId": 1,
  "instrumentId": 47,
  "ticker": "PAMP",
  "side": "BUY",
  "type": "MARKET",
  "size": 10,
  "price": 925.85,
  "status": "FILLED",
  "rejectionReason": null,
  "datetime": "2026-11-12T14:03:22.000Z"
}
```

`request_hash` is the SHA-256, in hex, of the validated body serialised as JSON with keys sorted and absent fields omitted.

### 4.4 `POST /orders/:orderId/cancel`

FR-O8. Body: `{ "userId": 1 }`.

One statement, no lock: `UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND userId = $2 AND status = 'NEW' RETURNING ...`.

- A row came back: `200` with the order.
- No row and the order exists for that user: `409 ORDER_NOT_CANCELLABLE`.
- No row otherwise, including an order of another user: `404 ORDER_NOT_FOUND`.

### 4.5 `GET /orders?userId=&status=&limit=&offset=`

`userId` required. `status` optional, one of the four. Same paging as 4.2. `200`: an array of orders in the shape of 4.3, newest first.

### 4.6 `POST /transfers`

FR-O9. Optional `Idempotency-Key`, same rules as 4.3.

Body: `{ "userId": 1, "side": "CASH_IN" | "CASH_OUT", "amount": 1000 }`. `amount` is a positive integer of whole pesos, at most 99,999,999.

Same steps 2 to 4 as `POST /orders`. Then: the instrument is the cash instrument (`ARS`), `type` is `MARKET`, `price` is 1, `size` is `amount`. A `CASH_OUT` above available cash is stored `REJECTED` with `INSUFFICIENT_FUNDS`; everything else is `FILLED`. Response as in 4.3.

### 4.7 `GET /health`

`200 { "status": "ok" }` after `SELECT 1`. `503 DATABASE_UNAVAILABLE`, in the error shape, if the database does not answer.

## 5. Database

Base: `db/database.sql`, the schema and seed I rebuilt from the brief ([02 Design, section 1](02-design.md#1-the-picture)). It is not edited. One migration, `db/migrations/001_constraints_indexes.sql`, idempotent, with exactly what [02 Design, section 5](02-design.md#5-changes-to-the-schema) lists:

| Change | Detail |
| --- | --- |
| `orders.rejection_reason` | `VARCHAR(40)`, nullable |
| `orders.idempotency_key` | `VARCHAR(50)`, nullable |
| `orders.request_hash` | `CHAR(64)`, nullable |
| Unique index | `(userId, idempotency_key)` |
| `NOT NULL` | `instrumentId`, `userId`, `side`, `size`, `type`, `status`, `datetime`. Not `price` |
| `CHECK` | `side`, `type` and `status` in their allowed values; `size > 0` |
| Indexes | `orders (userId, status)`; `marketdata (instrumentId, date DESC)`; `pg_trgm` GIN on `instruments.ticker` and `instruments.name` |

Connection settings: `lock_timeout = 2s`, `statement_timeout = 5s`. Either one firing is a `503 BUSY`.

## 6. Structure and operation

Stack and reasons: [ADR 0009](adr/0009-stack-and-data-access.md).

```
src/
  server.ts          start, graceful shutdown (stop accepting, finish requests, close the pool)
  app.ts             express app, request id, logging, error handler
  routes.ts          HTTP and validation only
  money.ts           cents conversion, the cap, BigInt products        (pure)
  accountState.ts    the replay of section 3                           (pure) + its two queries
  orders.ts          submit, cancel, list, transfer; owns the transactions
  portfolio.ts       section 4.1
  instruments.ts     section 4.2
  db.ts              pool, transaction and read-snapshot helpers
  errors.ts          AppError(status, code, message)
db/                  database.sql, migrations/
tests/               functional tests against a real PostgreSQL; unit tests for the pure modules
```

Configuration by environment variables: `PORT`, `DATABASE_URL`, and `TEST_ADMIN_URL` for the tests. Docker Compose starts PostgreSQL 16 with the base file and the migration applied. The test run creates and drops its own database.

### Guard-rails

The code is written with an AI assistant, so the rules of section 1 are backed by checks that fail by themselves. Three layers, all in slice 0:

| Layer | What | Stops |
| --- | --- | --- |
| 1. One command | `npm run check` runs the type check (strict), the linter (type-aware, so an un-awaited promise is an error) and the whole suite | A slice called done with a red test, a type error or a floating promise |
| 2. CI and branches | GitHub Actions runs `npm run check` on every pull request to `development` and `main`, against a real PostgreSQL. Both branches are protected: no direct push, merge only with the check green | Code reaching a shared branch without passing layer 1 |
| 3. Limits on the assistant | `.claude/settings.json`, versioned: it cannot edit `db/database.sql`, cannot read `.env`, cannot push to `main` or `development`, and the type check runs after every file it edits. `CLAUDE.md` points it to this spec | The assistant changing the base schema, leaking secrets or skipping the pull request |

Layer 3 is a convenience, not a security boundary: a command can be written to get around a pattern. Layer 2 is what enforces. The database constraints of section 5 are a fourth layer that needs no tooling: they hold even if a test is missing.

## 7. Tests

Each test has an id, so an ADR can link to it. "Seed" means user 1 of my `database.sql`.

### Unit: account state and money

| Id | Test | Source |
| --- | --- | --- |
| U1 | Worked example: BUY 10 at 100, BUY 10 at 120, SELL 5 gives quantity 15, cost 1,650.00 | ADR 0007 |
| U2 | Rounding example: the three sales remove 10.00, 10.01 and 10.00 | ADR 0007 |
| U3 | Oversold: BUY 20, SELL 30 gives quantity -10, cost 0; BUY 20 at 1,500 then gives quantity 10, cost 15,000.00 | ADR 0007 |
| U4 | Seed: cash 753,000.00, reserved 125,500.00, available 627,500.00 | ADR 0002 |
| U5 | `cost x sold` above the safe-integer limit is still exact | ADR 0006 |
| U6 | Cap: 9,999,999,999 cents accepted, one cent more refused, an absurd product refused | ADR 0006 |
| U7 | Two-decimal check and cents conversion (`0.1 + 0.2`, `1.005`, `99999999.99`) | ADR 0006 |

### Functional: `POST /orders`

| Id | Test | Source |
| --- | --- | --- |
| O1 | MARKET BUY by `size` is `FILLED` at the latest `close`; balance and position change | FR-O3, FR-O10 |
| O2 | MARKET BUY by `amount` stores `floor(amount / price)` shares | FR-O5 |
| O3 | `amount` below one share: 422, nothing stored | Q6 |
| O4 | LIMIT is stored `NEW` and reduces `availableBalance`, not `cashBalance` | FR-O4, ADR 0002 |
| O5 | BUY above available cash is stored `REJECTED`, `INSUFFICIENT_FUNDS`, 201 | FR-O7 |
| O6 | SELL above shares held, and SELL of shares reserved by an open LIMIT SELL, are `REJECTED`, `INSUFFICIENT_SHARES` | FR-O7, ADR 0002 |
| O7 | No market price: `size` gives a stored `REJECTED` with null price; `amount` gives 422 `NO_PRICE_FOR_AMOUNT` | ADR 0005 |
| O8 | Above the cap: 422, nothing stored. Exactly at the cap: accepted | ADR 0006 |
| O9 | Validation: LIMIT without price, MARKET with price, both or neither of `size`/`amount`, three decimals, unknown field | FR-O4 |
| O10 | Unknown user, unknown instrument: 404. Cash instrument: 400 | ADR 0005 |
| O11 | **Concurrency**: 10 simultaneous orders against a balance that fits 3 give exactly 3 `FILLED` and 7 `REJECTED` | ADR 0003 |

### Functional: idempotency

| Id | Test | Source |
| --- | --- | --- |
| I1 | Same key, same body: 200, same order id, one row | ADR 0004 |
| I2 | Same key, different body: 422, one row | ADR 0004 |
| I3 | A rejected order replays as the same rejection, even after a deposit | ADR 0004 |
| I4 | A request that failed with 4xx stored no key: the fixed request with the same key succeeds | ADR 0004 |
| I5 | Same key from two users gives two orders | ADR 0004 |
| I6 | Two simultaneous requests with the same key give one row | ADR 0003, 0004 |
| I7 | `amount` order replayed after the price changed returns the original order | ADR 0004 |
| I8 | An invalid key (empty, 51 characters, not printable ASCII) is 400, nothing stored. A key of 50 characters is accepted | ADR 0004 |

### Functional: the rest

| Id | Test | Source |
| --- | --- | --- |
| C1 | Cancel a `NEW` order: 200, `CANCELLED`, reserved cash released | FR-O8 |
| C2 | Cancel a `FILLED`, `REJECTED` or `CANCELLED` order: 409. Another user's order: 404 | FR-O8 |
| T1 | `CASH_IN` raises the balance by `amount`; `CASH_OUT` lowers it | FR-O9 |
| T2 | `CASH_OUT` above available cash is stored `REJECTED` | Q12 |
| P1 | Seed portfolio equals the example in 4.1, field by field: total 904,784.00, two positions, instrument 31 not listed | FR-P1 to FR-P5 |
| P2 | Position without a market price: valued at cost, returns `null`, `priceAvailable: false` | ADR 0007 |
| P3 | Unknown user 404, bad id 400 | |
| S1 | Finds by ticker and by name, ignoring case | FR-S1, FR-S2 |
| S2 | Ranking: exact ticker before prefix before name | Q7 |
| S3 | Cash is not returned; `%` and `_` are literal; `q` is required; page size is capped | Q7 |
| H1 | Health is 200 with the database up | ADR 0008 |
| D1 | The base file and the migration apply to an empty database, the migration can run twice, and the constraints refuse an invalid order | NFR-5 |
| E1 | Every error has the one shape, an unexpected error never shows internals, and every response has `X-Request-Id` (an incoming one is reused) | ADR 0005, 0008 |
| E2 | A request that waits longer than the lock timeout is answered `503 BUSY` | ADR 0003, 0008 |

## 8. Order of work

One vertical slice at a time. Each ends with a commit that leaves the suite green.

| Slice | Delivers | Tests |
| --- | --- | --- |
| 0 | Project, Docker Compose, base SQL and migration, app skeleton, error shape, request id, health, test harness, and the three guard-rail layers of section 6 | H1, D1, E1 |
| 1 | `money.ts` and the pure replay | U1 to U7 |
| 2 | Portfolio | P1 to P3 |
| 3 | Asset search | S1 to S3 |
| 4 | `POST /orders`: MARKET by size, then amount, then LIMIT and reservations, then rejections, then the cap | O1 to O10 |
| 5 | The lock, proven by the concurrency test. Written to fail first without the lock. Timeouts answered as `503 BUSY` | O11, E2 |
| 6 | Idempotency | I1 to I8 |
| 7 | Cancel, list, transfers | C1, C2, T1, T2 |
| 8 | Request collection with examples, "Running it" in the README, links from the ADRs to the tests | NFR-6 |
| 9 | Code review of my own work, `docs/06-code-review.md` | |

## 9. Decided in this spec

These are details the ADRs did not settle. They are small enough not to need a record, and are listed so they are visible instead of buried in code.

| Decision | Chosen |
| --- | --- |
| Cancelling an order that is not `NEW` | `409 ORDER_NOT_CANCELLABLE` |
| Cancelling another user's order | `404`, the same as an order that does not exist, so ids do not leak |
| Timeouts | `lock_timeout` 2s, `statement_timeout` 5s, answered as `503 BUSY` |
| Unknown route, malformed JSON | `404 NOT_FOUND`; `400 VALIDATION_ERROR` |
| Health with the database down | `503 DATABASE_UNAVAILABLE` |
| Unknown fields in a body | Refused |
| Invalid `Idempotency-Key` (empty, above 50 characters, or a character outside printable ASCII, `0x20` to `0x7E`) | `400 VALIDATION_ERROR`, the same as an invalid body. It is not ignored: a client that sent a key believes it is protected |
| Paging | `limit` 1 to 100, default 20. `offset` up to 2,147,483,647, the same bound as an id. A `limit` above 100 is a `400`, not silently lowered |
| Unknown query fields | Refused, the same as in a body |
| Search order after ticker | By id, so that paging is stable if two instruments ever share a ticker |
| Portfolio ordering | By market value, descending |
| Rounding of percentages | Half away from zero, so a gain and a loss of the same size show the same number. For cost, which is never negative, this is the same as half up |
| Portfolio `currency` | The constant `ARS`. The system has one currency: one cash instrument, every price in pesos |
| Ticker lookup | Case-insensitive, exact. The lowest id if two instruments ever share a ticker |
| Largest `size` | 2,147,483,647, what the `INT` column holds. Above it a given `size` is a `400`; a `size` computed from `amount` is `422 ORDER_VALUE_TOO_LARGE`, because it depends on the price and the client's remedy is the same: split the order |
| `price` of zero | Refused with `400`. An `amount` of zero is not: it buys less than one share, so it is the `422` of step 8 |
| Market `close` of zero or below | Not a price for an order: the outcome of step 7. It cannot fill an order and cannot divide an `amount` |
| `SELL` by `amount` | Allowed, same `floor(amount / price)` rule as `BUY` |

## 10. Not in this spec

Everything in [01 Requirements, section 3](01-requirements.md#3-out-of-scope) and in [02 Design, section 6](02-design.md#6-deliberately-not-built-and-when-it-would-be): authentication, rate limiting, LIMIT execution, materialised balances, metrics, replicas, queues.
