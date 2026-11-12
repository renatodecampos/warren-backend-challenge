# 02. Design

Input: [01 Requirements](01-requirements.md). Output: the decisions that [the ADRs](adr/README.md) record one by one, and the code.

This document has four parts: the picture, the open questions with the assumption I work with, the options I weighed, and what I deliberately leave for later.

## 1. The picture

Whiteboard v1: [`whiteboard/wb-v1.png`](whiteboard/wb-v1.png). It keeps my first sketch ([`wb-v0.png`](whiteboard/wb-v0.png), also at the top of v1) so the evolution is visible, and adds the open questions, the non-functional assumptions, a layer view and the `POST /orders` sequence as designed here. In the v1 sequence, yellow marks the idempotency check and red marks the order value cap, the two steps v0 did not have.

### Context

```
Client -> LB -> market-api (stateless, N instances) -> PostgreSQL
```

One stateless service and one database. Correctness lives in the database (transactions, a row lock, constraints), not in process memory, so adding instances does not change behaviour.

### Data model

The brief describes four tables. The original `database.sql` did not come with the brief, so I rebuilt the schema from that description. Differences from the brief are listed in section 5.

```
users(id, email, accountNumber)
instruments(id, ticker, name, type)            type = 'MONEDA' for the cash instrument (ARS)
orders(id, instrumentId, userId, side, size, price, type, status, datetime)
marketdata(id, instrumentId, high, low, open, close, previousClose, date)
```

`orders` is the ledger: it holds trades, deposits and withdrawals. Nothing else stores a balance.

### `POST /orders` flow

```
validate body                        -> 400 if invalid
BEGIN
  lock the user row (FOR UPDATE)     -> serialises this user's orders
  idempotency check                  -> same key: return the stored order, no new row
  resolve the instrument             -> 404 if unknown; cash is not tradable
  price: LIMIT = given; MARKET = latest close
  size: given, or floor(amount / price)
  order value above the cap          -> 422, nothing stored
  replay FILLED orders, add NEW reservations
  enough cash / shares?              -> FILLED / NEW, or REJECTED with a reason
  INSERT the order
COMMIT
201 with the order
```

## 2. Open questions and the assumption I work with

These are the ambiguities from [01 Requirements, section 4](01-requirements.md#4-where-the-brief-is-silent-or-ambiguous). I did not wait for answers: each has an assumption, and the ones with real alternatives become ADRs. The last column is what would make me change my mind.

| Id | Question | Assumption | ADR | I would revisit if |
| --- | --- | --- | --- | --- |
| Q1 | Does an open LIMIT order reserve funds? | Yes. A `NEW` BUY reserves `size x limit price`, a `NEW` SELL reserves its shares | planned | Product says open orders must not block funds |
| Q2 | HTTP response when the market rejects an order | 201 with `status: REJECTED` and a reason. The order exists, so a resource was created | planned | The API opens to third parties who expect 2xx to mean success |
| Q3 | Definition of total return | `(market value - cost) / cost`, average cost of the shares still held | planned | Tax reporting requires FIFO |
| Q4 | Total return and daily return | Both are returned: total return per position, daily return from `close` and `previousClose` | no | The consumer only needs one |
| Q5 | Total account value | Cash plus market value of holdings. Reserved cash still belongs to the user, so it is not subtracted | with Q1 | |
| Q6 | `amount` buys less than one share | 422, nothing stored: there is no valid `size` to record | with Q2 | |
| Q7 | What "similar" means in search | Case-insensitive substring on ticker and name, ranked exact ticker, ticker prefix, name prefix, then the rest | no | Typo tolerance is required |
| Q8 | Instrument without a market price | MARKET order is stored `REJECTED` (`NO_MARKET_PRICE`); a position is valued at cost and flagged | no | |
| Q9 | Concurrent orders from one user | One row lock per user around check and insert | planned | Lock wait shows up in latency |
| Q10 | The same order sent twice | An `Idempotency-Key` header, unique per user: a repeat returns the stored order | planned | |
| Q11 | Seed user who sold more than they bought | The write path blocks selling shares the user does not hold. Historical rows are read as they are; non-positive positions are not listed | no | |
| Q12 | `CASH_OUT` limit and decimals | Withdrawal cannot exceed available cash. Whole pesos only, because `size` is an integer | no | Cents are needed in transfers |
| Q13 | Volume, availability, security | See section 3 | planned | Real figures replace these |

## 3. Non-functional assumptions

Not given, not measured. They are the first things I would confirm with product before production.

| Topic | Assumed | What depends on it |
| --- | --- | --- |
| Users | Thousands of active users | One PostgreSQL primary is enough |
| Write load | Tens of orders per second at peak | Synchronous, transactional writes |
| History | Up to a few thousand orders per user | Balances are computed, not stored |
| Consistency | Order submission is strictly consistent: it refuses rather than accepting what it cannot verify | A database lock, not eventual consistency |
| Read freshness | Portfolio and search may be slightly stale | Room for replicas and caching later |
| Availability | API is stateless and replicated; the database is the single point of failure | Managed PostgreSQL with a standby |
| Security | Authentication out of scope (brief). Rate limiting and authentication at a gateway in front of the API | Not built here; documented |

## 4. Options considered and trade-offs

For each choice: what I chose, what I rejected, and what the choice costs.

### 4.1 How to know a user's balance and positions

| Option | Gain | Cost |
| --- | --- | --- |
| **Replay `FILLED` orders on demand (chosen)** | One source of truth. A balance cannot disagree with history. Nothing to reconcile. The brief asks for exactly this | Cost grows with a user's history, and the replay runs inside the lock |
| Materialised balances and positions, updated in the same transaction | Constant-time checks. A `CHECK (balance >= 0)` is a second safety net. Shorter lock | A second source of truth that can drift. Needs reconciliation |
| Snapshots plus replay of recent orders | Bounds the cost, ledger stays authoritative | More moving parts than this case needs |

Chosen because the assumed volume allows it and the brief points that way. First thing to break at scale, and the first step of the production path.

### 4.2 How to stop two orders spending the same money

| Option | Gain | Cost |
| --- | --- | --- |
| **`SELECT ... FOR UPDATE` on the user row (chosen)** | Simple, correct on any number of instances, easy to test. Users do not block each other | Orders of one user run one at a time. Lock lasts as long as the replay |
| `SERIALIZABLE` with retries | No explicit lock | Failed transactions that must be retried, worst exactly when one user contends with themselves |
| Advisory lock on the user id | Same effect without touching the row | Less obvious to read; the row is read anyway to return 404 |
| Balance row with a constraint | Shortest lock, strongest guarantee | Needs materialised balances (4.1) |
| In-process mutex | None | Breaks with a second instance |

### 4.3 Reserving funds for open LIMIT orders

| Option | Gain | Cost |
| --- | --- | --- |
| **Reserve at the limit price (chosen)** | The account can never be overdrawn by a later execution | Money can stay locked in orders that never fill. Cancelling releases it |
| No reservation, check at execution | No locked money | A user can open orders worth many times their cash and the failure shows up late and far from the decision |

### 4.4 Rejected orders: stored, and what to return

| Option | Gain | Cost |
| --- | --- | --- |
| **Store as `REJECTED`, return 201 (chosen)** | Matches the brief. Complete history, one response shape, the client switches on `status` | A client that only checks for 2xx will read a rejection as success |
| Store, but return 422 | Failure is obvious from the status code | An error response for a resource that now exists |
| Do not store | Simple | Contradicts the brief and loses the record |

### 4.5 Retries

| Option | Gain | Cost |
| --- | --- | --- |
| **`Idempotency-Key` header, unique per user (chosen)** | A retry after a timeout cannot create a second order. Fits inside the lock already taken | One column and one unique index. Same key with a different body needs a defined answer (422) |
| Natural key (same user, asset, side, size within N seconds) | No client change | Guesses intent. Blocks legitimate repeated orders |
| Nothing | No work | A duplicate order moves real money. A correctness gap, not a scaling one |

The key is optional in this version so simple clients keep working, and would be mandatory in production.

### 4.6 Money representation

| Option | Gain | Cost |
| --- | --- | --- |
| **Integer cents in code, `NUMERIC` in the database (chosen)** | Exact sums and comparisons. No dependency | Rounding in average cost and percentages. Limited to about 9 x 10^15 cents, so the value of one order is capped |
| Decimal library | Right for several currencies or more than two decimals | Dependency and slower arithmetic for one currency |
| Floats | Simplest | Wrong by a cent after enough additions |

### 4.7 Where to compute: SQL or application

Average cost depends on the order of buys and sells, which is awkward in plain SQL, so positions are computed in code from rows read in order. Search ranking and the latest price are done in SQL, close to the indexes.

## 5. Changes to the schema

The schema was rebuilt from the brief, so these are my additions and differences, each justified as the brief requires (NFR-5).

| Change | Why |
| --- | --- |
| `orders.rejection_reason` | A `REJECTED` order should say why |
| `orders.idempotency_key` with a unique index on `(userId, idempotency_key)` | Retries (4.5). Null for clients that send no key |
| `NOT NULL` on the main `orders` columns | A missing value would corrupt a balance |
| `CHECK` on `side`, `type`, `status` and `size > 0` | Invalid states become impossible even if application code has a bug |
| Index `orders (userId, status)` | Every request reads one user's orders by status |
| Index `marketdata (instrumentId, date DESC)` | Latest price per instrument |
| `pg_trgm` GIN indexes on `instruments.ticker` and `name` | `ILIKE '%term%'` without a full scan |
| `marketdata.date` instead of the brief's `datetime` | It holds a day, and the brief says the table holds the last two days. Decided here; revisit if the brief's name matters to a consumer |

## 6. Deliberately not built, and when it would be

Ordered by what I would do first. Each has a trigger, so nothing is built ahead of need.

| Step | Trigger |
| --- | --- |
| Authentication and authorisation | Before any real client. `userId` in the body lets anyone trade for anyone |
| Idempotency key mandatory | Same moment |
| Rate limiting per user and per IP at the gateway | Before public exposure |
| Metrics, traces and alerts: order latency, rejection rate, lock wait | Before production; the triggers below cannot be observed without them |
| CI running the tests and an OpenAPI contract | Before a second engineer joins |
| LIMIT execution job, taking the same per-user lock | When the product needs LIMIT orders to fill |
| Materialised balances and positions | Replay or lock wait visible in latency |
| Read replica and cache for market data and search | Read load competes with order writes |
| Queue for order intake | Peak writes exceed what the primary handles synchronously. Changes the API contract, so it comes last |

## 7. What comes next

1. Whiteboard v1: this design, with the idempotency check and the production path drawn.
2. ADRs, one per decision marked "planned" in section 2: reservation (Q1, Q5), rejected orders (Q2, Q6), return definition (Q3), per-user lock (Q9), idempotency (Q10), money, and the non-functional assumptions (Q13).
3. Code and tests, one vertical slice at a time, each slice test first.
4. Code review of my own work.
