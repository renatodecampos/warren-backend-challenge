# 0008. Non-functional assumptions and the path to production

Status: Accepted
Requirements: NFR-3, NFR-4. Design: [02 Design, sections 3 and 6](../02-design.md#3-non-functional-assumptions). Open question: Q13.

## Context

The brief describes functionality and says nothing about load, availability, security or operations. Those requirements decide most of the architecture, so I wrote down the values I assumed. None of them was given to me and none was measured. They are the first things I would validate with product and business before a production launch.

## Assumptions

| Topic | Assumed | What depends on it |
| --- | --- | --- |
| Users | Thousands of active users | One PostgreSQL primary is enough |
| Write load | Tens of orders per second at peak (market open) | Synchronous, transactional writes |
| History | Up to a few thousand orders per user | Balances are computed, not stored ([0001](0001-orders-table-as-ledger.md)) |
| Consistency | Order submission is strictly consistent: it refuses rather than accepting an order it cannot verify | A database lock, not eventual consistency ([0003](0003-per-user-row-lock.md)) |
| Read freshness | Portfolio and search may be slightly stale | Leaves room for replicas and caching later |
| Availability | The API is stateless and runs as several instances; the database is the single point of failure | Managed PostgreSQL with a standby |
| Authentication | Out of scope, as the brief allows. `userId` comes from the path or the body | It would come from the token; ownership checks are written as if it did |
| Rate limiting | Done at a gateway in front of the API, not in the service | Not implemented here; documented |
| Market data | The latest `close` is the execution price for MARKET orders | No live feed and no order book |

## Decision

Build the simplest design that is correct under those assumptions: one stateless service and one PostgreSQL database, with correctness enforced in the database (transactions, a row lock, constraints) and not in process memory.

What this version commits to, so that it can be operated and checked:

- Input validation with one error shape ([0005](0005-rejected-orders-are-stored.md)).
- A request id on every response and in structured JSON logs.
- A health endpoint that checks the database, and graceful shutdown.
- Constraints and indexes added by a migration, each justified in [02 Design, section 5](../02-design.md#5-changes-to-the-schema).
- Functional tests against a real PostgreSQL, including a concurrency test and the idempotency cases.
- Statement and lock timeouts on the database connection, so a stuck transaction cannot hold a user's lock indefinitely ([0003](0003-per-user-row-lock.md)).

## Path to production

Ordered by what I would do first. Each step has the trigger that justifies it, so nothing is built ahead of need.

| Step | Trigger | Why |
| --- | --- | --- |
| Authentication and authorisation | Before any real client | `userId` in the body lets anyone trade for anyone |
| Idempotency key mandatory ([0004](0004-idempotency-key.md)) | Same moment | Protection against retries only exists when the client sends a key |
| Rate limiting per user and per IP at the gateway | Before public exposure | Protects the per-user lock and the database from abuse |
| Metrics, traces and alerts: order latency, rejection rate, lock wait | Before production | The triggers below cannot be observed without them |
| CI running the tests, plus an OpenAPI contract | Before a second engineer joins | Keeps the behaviour in these records from regressing |
| LIMIT execution job, taking the same per-user lock | When the product needs LIMIT orders to fill | Without the lock it could overdraw an account |
| Materialised balances and positions | Replay or lock wait visible in latency | Constant-time checks and a short lock |
| Read replica and cache for market data and search | Read load competes with order writes | Reads tolerate staleness; writes do not |
| Queue for order intake | Peak writes exceed what the primary handles synchronously | Trades immediate confirmation for throughput and changes the API contract, so it comes last |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Start with queues, a cache and separate services | Solves problems the assumed load does not have, and adds failure modes (duplicates, ordering, eventual consistency) to a money flow |
| Implement authentication and rate limiting inside this service | The brief excludes authentication, and both are better enforced once at the edge than in every service |
| Leave the assumptions unwritten and ask the interviewers | The case asks for visible reasoning. Written assumptions with a trigger to revisit show where each decision breaks, and do not depend on an answer arriving in time |

## Consequences

- The system is small enough to reason about and to test end to end.
- It is **not production ready**. The first two rows of the table are blockers, not optimisations.
- If the real numbers are an order of magnitude above the assumptions, materialised balances move to the top of the list.
- Every figure in the assumptions table is a guess until someone supplies real data. The questions below are the ones I would ask.

## Questions I would take to product and business

1. How many active users, and how many orders per second at market open?
2. How many orders does a typical user accumulate, and how many does the heaviest one?
3. On failure or overload, should order submission refuse (consistency) or accept and reconcile later (availability)? Is there an uptime or latency target?
4. Are authentication and rate limiting handled by a gateway in front of the API?
5. Is a per-order value limit a business rule? ([0006](0006-integer-cents-and-order-value-cap.md))
6. Should open LIMIT orders block cash and shares? ([0002](0002-open-limit-orders-reserve-funds.md))

## Revisit when

- Real figures for users, peak order rate and history per user are available.
- An availability or latency target is defined for order submission.
