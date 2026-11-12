# 06. Code review of my own work

Slice 9 ([spec, section 8](03-spec.md#8-order-of-work)) is the review I would give this code if someone else had written it. It is not a summary of the spec and it is not a list of things that went well. It records how I reviewed, what holds, what I would change, and what I deliberately accept.

Reviewed on 2026-11-12: `development` at `88a6e50` (slices 0 to 8). I started at `1ff423a` and reviewed slice 8 from its PR; it merged during the review. `npm run check` is green: strict type check, type-aware lint, 11 test files, 205 tests.

## 1. How I reviewed

1. I read the brief, the requirements, the design and the ADRs before the code. The spec was the contract; the ADRs were the reasons to check the code against.
2. I traced every endpoint in both directions: contract to route to service to SQL, then SQL and response back to the contract. I did the same for the pure replay and the money helpers.
3. I mapped every test id in the spec, section 7, to a test. All 41 ids present at that point are there. I read the tests for what they actually assert, not for their names.
4. I ran the commands a reviewer would run: `npm run check`, then targeted `supertest` probes against the test database for the edges the suite does not cover.
5. I read the history of each slice to check test-first order. Slices 1 to 7 have a `test:` commit before the `feat:` commit. Slice 0, the skeleton and its harness, is one commit; it is the one slice where the test-first artefact is not separable.

What this review is not: a load test, a security audit of the gateway, a second pair of eyes, or a production deployment. The assumptions behind the load and availability claims are in [ADR 0008](adr/0008-nfr-assumptions-and-production-path.md); I did not replace them with measurements.

**Severity.** High: a normal client gets a wrong money outcome or loses data. Medium: a stated contract is not met, or a failure mode can take the service down. Low: an edge case, documentation drift, or a test gap. The severities are mine, not the spec's.

## 2. Verdict

**Approved for the challenge. Before production: close CR-1, CR-2 and CR-7, and add the logging test.**

I found no defect in the paths that decide money: the integer-cent arithmetic, the BigInt products, the replay, the per-user lock, the idempotency check and the rejected-order rule all hold under the cases I could construct. The findings are at the edges of the contract, in one operational failure mode, and in the documentation.

## 3. What holds

| Claim | Where it is proven |
| --- | --- |
| Balances and positions are only derived from `FILLED` orders, in `datetime` then `id` order, with the average-cost rules of ADR 0007 | `src/accountState.ts`; U1 to U4, P1 |
| The products the order-value cap does not bound are exact: `cost x sold`, `quantity x close`, and the percentage division | `src/money.ts`; U5, U6, U7 |
| A BUY checks available cash and a SELL checks available shares in the same transaction that inserts the order | `src/orders.ts:222-276`; O5, O6, O11 |
| Two simultaneous requests from one user cannot both pass the balance check | `src/orders.ts:109-114`; O11 gives exactly 3 `FILLED` and 7 `REJECTED` out of 10 against a balance that fits 3; E2 answers `503 BUSY` on the lock timeout |
| The idempotency check runs after the user lock and before anything else is evaluated; a retry returns the stored order and a key reused for another body is `422` | `src/orders.ts:222-232, 284-292`; I1 to I8 |
| A rejected order is stored, keeps its key, and replays as the same rejection | `src/orders.ts:242-253, 264-274`; O5 to O7, T2, I3 |
| Every error has one shape, unexpected errors do not show internals, and every response carries `X-Request-Id` | `src/app.ts:55-79`; E1 |
| Only the error codes and statuses of the spec are emitted; no internal error text reaches the client | `src/app.ts:55-79`; E1; review of every `AppError` |
| Every SQL value is bound; no user value is concatenated into a statement, and the search pattern escapes `%` and `_` | review of every query in `src/`; S3 |
| The database migration is idempotent and the schema enforces the stated constraints, independent of the service | `db/migrations/001_constraints_indexes.sql`; D1 (which exercises two of them) |
| Search is case-insensitive, escapes `%`, `_` and the escape character, excludes cash, and ranks exact ticker, ticker prefix, name prefix, rest | `src/instruments.ts`; S1 to S3 |
| The portfolio is one repeatable-read snapshot with no lock, values an unpriced position at cost, and matches the hand-computed seed example | `src/portfolio.ts`; P1 to P3 |

The tests run against a real PostgreSQL, not a mock. That is the right choice for this design: the lock, the unique index and the constraints are the guarantees, and a mocked database would test none of them ([ADR 0009](adr/0009-stack-and-data-access.md)).

### Slice 8, documentation

Slice 8 is documentation only, so it has no test id. I reviewed its diff: `requests.http` is a walk-through with the expected outcome above each request; the examples I spot-checked match the seed (`gas` returns six instruments, `banco&limit=2&offset=1` returns BHIP and BMA, and the walkthrough ends at cash 790,414.65, PAMP 31, METR 504). The README commands match `package.json`. It merged as `88a6e50`; the README status line now reads slices 0 to 8.

## 4. Findings

### CR-1. Unknown query fields are refused only where a query schema exists

**Severity: Medium.** The spec states the rule globally: section 2, "Unknown fields | Refused with `400 VALIDATION_ERROR`", and section 9, "Unknown query fields | Refused, the same as in a body". Only `searchQuery` and `ordersQuery` are strict objects ([src/routes.ts:26-35](../src/routes.ts)). The other routes never read `req.query`, so a query field is silently ignored.

Verified against the test database:

```
GET /users/1/portfolio?foo=bar          -> 200
GET /health?foo=bar                    -> 200
POST /orders?foo=bar                   -> 201, order created
POST /orders/1/cancel?foo=bar          -> 409 (the order is not NEW, but not a 400)
POST /transfers?foo=bar                -> 201, deposit created
```

This is either a contract bug or an over-broad line in the spec. I would decide in the spec first, then either parse `req.query` with `z.strictObject({})` on every route that has no query contract, or narrow the rule to the two endpoints that accept paging and search. A typo in a query parameter changing nothing is worse than a `400`; my preference is to enforce it everywhere.

### CR-2. Malformed path and body encodings are answered `500`, not `400`

**Severity: Low.** The error handler recognises body-parser errors only when they carry a `type` field ([src/app.ts:41-45](../src/app.ts)). The router's `URIError` and the zlib error from a bad `Content-Encoding` both carry `status: 400` but no `type`, so they fall through to `INTERNAL_ERROR` ([src/app.ts:55-79](../src/app.ts)). The responses are safe, with no stack or internals, but the status is wrong for a malformed request.

```
GET /users/%E0%A4%A/portfolio                    -> 500 INTERNAL_ERROR
POST /orders (Content-Encoding: gzip, bad body)  -> 500 INTERNAL_ERROR
expected                                         -> 400 VALIDATION_ERROR
```

The spec's error table puts a path or body that does not match the schema in `400 VALIDATION_ERROR`. I would classify client errors by their 4xx status, or add explicit `URIError` and encoding-error branches, and cover both under E1. This is a client bug, not a server bug.

### CR-3. ADR 0006 says prices are converted in SQL; the code converts in JavaScript

**Severity: Low (documentation).** [ADR 0006](adr/0006-integer-cents-and-order-value-cap.md) says "The database converts on the way out: `(price * 100)::bigint`". The code does not cast in SQL; it reads `NUMERIC` as a string and converts with `toCents(Number(...))` ([src/orders.ts:101](../src/orders.ts), [src/accountState.ts:143](../src/accountState.ts), [src/portfolio.ts:85-87](../src/portfolio.ts)). [ADR 0009](adr/0009-stack-and-data-access.md) says the conversion is explicit and happens "in one place", which is true of `toCents`.

For `NUMERIC(10,2)` the behaviour is equivalent; U5 to U7 pin the conversion. The problem is that the record is no longer true, and rule 4 of the spec says one source per fact. I would either change ADR 0006 to describe the actual edge conversion or move the cast into the queries. I would not leave both statements in place.

### CR-4. `X-Request-Id` reuse is stricter than the spec says

**Severity: Low.** The spec says an incoming `X-Request-Id` is reused, otherwise one is generated ([spec, section 2](03-spec.md#2-conventions)). The code reuses it only when it matches `^[\w.-]{8,100}$` ([src/app.ts:8,21](../src/app.ts)); E1 even asserts that an unsafe value is replaced ([tests/errors.test.ts:89](../tests/errors.test.ts)).

Verified:

```
X-Request-Id: abc          -> generated UUID (not reused)
X-Request-Id: client-abc   -> reused
X-Request-Id: <101 chars>  -> generated UUID
```

The code is safer: the id is echoed in a header and written to logs, so an arbitrary value must not be trusted. The spec is incomplete, not the code. I would write the validation rule into section 2 and decide whether a short id such as `abc` should be accepted; if a client uses short trace ids, the current behaviour is surprising. The test should keep the replacement case.

### CR-5. The request log's `path` can contain the query string

**Severity: Low.** The spec lists `path` as one of the five log fields ([spec, section 2](03-spec.md#2-conventions)). The code logs `req.originalUrl` under that name ([src/app.ts:28](../src/app.ts)), so a request to `/users/1/portfolio?foo=bar` logs the query as part of `path`. That is useful for debugging but it is not the field the spec describes, and it makes the log line harder to aggregate by route. I would log `req.path` and add a separate field if the query is wanted, or rename the field to `url` and document it.

### CR-6. The logging contract is not tested

**Severity: Low (test gap).** The `log` function returns early when `NODE_ENV=test` ([src/app.ts:10-11](../src/app.ts)), and the suite runs with that environment. No test asserts the five fields, the one-line-per-request rule, or that the request id in the line matches `X-Request-Id`. This is the largest untested part of the spec, and it is also where CR-5 lives.

I would extract a small sink or make the logger injectable for a test, then assert one success line and one error line. The production logger does not need a new abstraction; the test only needs a seam. This is a follow-up, not a reason to change the log format.

### CR-7. A dead idle database connection can terminate the process

**Severity: Medium (operations).** `createPool` never registers a `pool.on('error')` listener ([src/db.ts:7-15](../src/db.ts)). `pg-pool` emits `error` when an idle client fails and removes that client; an EventEmitter `error` with no listener throws. A database restart or a network drop while connections are idle can therefore end the process, instead of leaving the service up and answering `503` until the database returns.

ADR 0008 calls the database the single point of failure and says the service is stateless and replicated. That is exactly the failure mode the pool must survive. I would add a listener that logs the error and lets the pool discard the client. If it needs a test, the smallest honest one is a pool-level emit; the full database-restart test belongs in the production path, not in this suite.

### CR-8. An oversized body is reported as "not valid JSON"

**Severity: Low.** `express.json` has a 10 kB limit ([src/app.ts:85](../src/app.ts)), and every 4xx body-parser error is mapped to `VALIDATION_ERROR` with the message "The request body is not valid JSON" ([src/app.ts:41-45, 65-67](../src/app.ts)). A 20 kB valid JSON body gets that message; the body was valid, it was too large. The spec does not define a body-size limit, so the status code is defensible, but the message is wrong and the limit is undocumented. I would distinguish `entity.too.large` from `entity.parse.failed`, and state the limit in the spec if it stays.

### CR-9. The test suite shares one database across parallel files, and D1 re-applies DDL

**Severity: Low (test risk).** `vitest.config.mts` does not disable file parallelism; `tests/global-setup.ts` creates one database for all files; `tests/health.test.ts:18-29` re-runs the migration while other files are using the database. It passes today (around 2.7 s), but the `ALTER TABLE` statements take heavy locks, and a slower CI or a longer transaction could hit the 5 s statement timeout. I would give D1 its own database or run that file sequentially. This is a flake risk, not a product defect, but it is the kind of test problem that shows up only on the day a PR is urgent.

### CR-10. Housekeeping: the Vitest cache is not ignored

**Severity: Low.** `git status` reports `?? .vitest/`; `.gitignore` does not list it. Add `.vitest/` to the ignore file. It is not part of the challenge, but an untracked cache in every working tree is noise.

### CR-11. A NUL byte in `q` or `ticker` is answered `500`

**Severity: Low.** `q` accepts any string of 1 to 100 characters and `ticker` any string of 1 to 10 ([src/routes.ts:27,47](../src/routes.ts)). PostgreSQL rejects a NUL in text with SQLSTATE `22021`, so the query or the ticker lookup reaches the database and throws:

```
GET /instruments?q=%00                                      -> 500 INTERNAL_ERROR
POST /orders {"ticker":"\u0000", ...}                       -> 500 INTERNAL_ERROR
expected                                                    -> 400 VALIDATION_ERROR, or a defined no-match; never 500
```

The spec does not say whether a NUL is a valid string. Either decision is defensible, but the database error is not an answer. The schema should refuse a NUL in a user-facing string, or the handler should map `22021` to `400 VALIDATION_ERROR` as a safety net. I would do both: a NUL is never a meaningful search term or ticker, and a database encoding error caused by a client should not be a 500.

## 5. Test review

All 41 ids present at that point are there. The suite is strongest where the design is riskiest:

- The concurrency test (O11) is a real race, not a mock; the idempotency tests (I1 to I8) cover replay, reuse, per-user scoping and two simultaneous requests; the seed portfolio (P1) is a hand-computed example, field by field.
- The money tests pin the two cases floats get wrong (U5, U7), and O8 pins both sides of the value cap.
- The database test (D1) proves the base file and migration apply and the migration can run twice.

The gaps I would close, in order:

| Gap | Why it matters | Test I would add |
| --- | --- | --- |
| Logging | The spec promises structured logs; none are asserted (CR-6) | E1: one success and one error line with the five fields and the request id |
| Malformed path, encodings and NUL | Wrong status for a bad client request (CR-2, CR-11) | E1: `%ZZ` path, bad gzip body, NUL in `q` and `ticker` |
| Unknown query fields | The contract is inconsistent across endpoints (CR-1) | 4.1, 4.3, 4.4, 4.6: one request each |
| The real statement timeout | E2's second case builds a private `Client` with a 100 ms timeout; `createPool`'s 5 s timeout is never exercised, so deleting it keeps the suite green | E2: a slow query through the pool |
| Concurrent transfers | O11 and I6 cover orders only; removing `lockUser` from `submitTransfer` keeps the suite green | T1/T2: two `CASH_OUT`s that fit once give one `FILLED` and one `REJECTED` |
| Portfolio snapshot isolation | No test reads the portfolio while a writer changes cash, so the `REPEATABLE READ READ ONLY` claim is not observed | 4.1: a concurrent writer, one snapshot |
| Cancelling a `NEW` SELL releases its shares | C1 only checks reserved cash; the shares rule is in ADR 0002 | C1: available shares go back up |
| A rejected transfer replays as a rejection | T1 only replays a `FILLED` `CASH_IN`; ADR 0004 applies to transfers too | T2: same key, same rejected `CASH_OUT` |
| A rejected order with a null price comes back through `toOrder` | O7 checks the insert; the list and the replay of a `NO_MARKET_PRICE` order are not asserted | O7 or L1: list it, expect `price: null` |
| The idempotency namespace is shared by orders and transfers | No test sends one key to both endpoints; the unique index is per user, not per endpoint | I2 or T1: same key on `POST /orders` and `POST /transfers`, expect `422` |
| Average-cost rounding and a zero-cost position | P1 and P2 use exact averages; the rounding rule and `totalReturnPercent: null` are not pinned | U1 or P2: a 3-share position at 3.33 average; cost zero |
| The duplicate-ticker tie-breakers | Section 9 says ticker lookup takes the lowest id and search orders ties by id; no test creates two instruments with one ticker | S2 or O1: two rows with one ticker, assert both rules |
| The rest of the DB constraints | D1 checks `side` and `size`; `type`, `status` and the idempotency unique index are not asserted | D1: one invalid `type`, one invalid `status`, one duplicate key |
| The default order-list page | Search has a default-20 test; the list does not | L1: 21 orders, no `limit`, expect 20 |

I would not chase 100% coverage. These are the gaps where a failure would change a client-visible outcome or hide a broken guarantee.

## 6. Process review

- **Test first.** The history shows a `test:` commit before the `feat:` commit for every slice from 1 to 7. Slice 0 is the skeleton and its own harness, where the tests and the infrastructure arrive together; I would not force a red-green split there.
- **One slice, one branch, one pull request.** The branches in the repository follow the spec's order, and the pull requests stay small enough to review. That is what makes this review possible.
- **Guard-rails.** `npm run check`, CI against a real PostgreSQL, the no-direct-push rule on both shared branches and `.claude/settings.json` are the parts of the process that do not depend on my discipline. They are described in [spec, section 6](03-spec.md#guard-rails).
- **The slice 8 status line.** Slice 8 merged during the review; the README status line now reads slices 0 to 8. Slice 8 is documentation only, so the code review is unaffected.
- **This review is documentation only.** The spec gives slice 9 no tests, and a review that edits the code while reviewing it cannot be reviewed as a review. The findings above have proposed changes and proposed tests; they belong in a follow-up pull request, not in this one.

## 7. What I deliberately accept

These are not findings. They are decisions I would defend in a review:

- **Rejected orders return `201`** ([ADR 0005](adr/0005-rejected-orders-are-stored.md)). A client must read `status`. The alternative, a `422` with the order in the body, is safer for third parties, but the brief describes storing the order and the response tells the whole story.
- **Open LIMIT orders reserve cash and shares** ([ADR 0002](adr/0002-open-limit-orders-reserve-funds.md)). The brief does not state it; it is the assumption I would confirm first with product.
- **Balances are replayed, not stored** ([ADR 0001](adr/0001-orders-table-as-ledger.md)). It is the right trade at the assumed history size, and it is the first thing that breaks under growth.
- **The idempotency key is optional** ([ADR 0004](adr/0004-idempotency-key.md)). It exists so the API can be tried by hand; in production it would be mandatory.
- **No authentication, no rate limiting** (brief, [ADR 0008](adr/0008-nfr-assumptions-and-production-path.md)). `userId` in the body lets any caller trade for any user. That is the first production blocker, not a code review finding.
- **The order-value cap is a technical placeholder**, not a business rule ([ADR 0006](adr/0006-integer-cents-and-order-value-cap.md)). It bounds the arithmetic; product would set the real number.
- **LIMIT orders never execute.** The brief says there is no need to simulate the market; a later execution job would have to take the same per-user lock.

## 8. Follow-ups

In the order I would do them:

1. Decide CR-1 in the spec and enforce it, or narrow the rule; add the endpoint tests.
2. Classify malformed path and body encodings as validation errors, and reject a NUL in `q` and `ticker` (CR-2, CR-11); add the E1 cases.
3. Register the pool error listener and add the logging test (CR-6, CR-7).
4. Fix the documentation drift: ADR 0006, the `X-Request-Id` rule, and the body-size limit (CR-3, CR-4, CR-5, CR-8).
5. Close the test gaps that protect a guarantee: the real statement timeout, concurrent transfers, portfolio snapshot isolation, reserved shares on cancel, rejected transfer replay, null-price output, duplicate-ticker tie-breakers, average-cost rounding and DB constraints.
6. Move D1 to its own database or serialize it (CR-9); add `.vitest/` to `.gitignore` (CR-10).

The core is small and I can explain every query and every arithmetic step. The findings are edges, not cracks. I would merge slices 0 to 8; I would not call the service production-ready until CR-1, CR-2 and CR-7 are closed and the logging contract has a test.

## 9. Follow-up

After the review, PR #11 applied the approved fixes: CR-2 (malformed path and body encodings now answer `400`), CR-6 (the log lines have tests), CR-7 (the pool has an error listener) and CR-11 (a NUL in `q` or `ticker` is refused with `400`). A later follow-up applied CR-1: every route now refuses an unknown query field, covered by test E3. A final pass closed the documentation drift (CR-3, CR-4, CR-5, CR-8), made a zero `close` mean no price in the portfolio as it already did for orders (P4), and added the tests listed in section 5: the pool statement timeout (E2), concurrent withdrawals and a rejected transfer replay (T2), the shared key namespace (T1), a cancelled `NEW` SELL releasing its shares (C1), a null price through the list and the replay (O7), average-cost rounding (P5), duplicate-ticker tie-breakers (S4, O1), the remaining constraints (D1) and the default list page (L1). The findings above are kept as the snapshot before those changes. CR-9, the shared test database, stays open as a test-infrastructure risk; every other finding is closed.
