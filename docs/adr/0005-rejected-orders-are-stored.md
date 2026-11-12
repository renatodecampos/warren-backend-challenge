# 0005. Orders refused by the market are stored as `REJECTED` and return 201

Status: Accepted
Requirements: FR-O6, FR-O7. Design: [02 Design, 4.4](../02-design.md#44-rejected-orders-stored-and-what-to-return). Open questions: Q2, Q6, Q8, Q12.

## Context

The brief says an order the user cannot afford, or a sale of shares the user does not hold, "must be rejected and stored with a REJECTED status". It does not say what the HTTP response should be, nor what to do with requests that are wrong for other reasons.

There are two different kinds of "no":

- The request is not a valid order: a LIMIT without price, an unknown user or ticker, an amount that cannot buy one share.
- The request is a valid order and the market does not accept it: not enough cash, not enough shares, no price to execute at.

## Assumption

Clients are first-party applications that read the response body. They do not rely on the status code alone to know whether an order was executed.

## Decision

| Situation | Stored? | HTTP | Code |
| --- | --- | --- | --- |
| Valid order the market refuses | Yes, as `REJECTED` with `rejection_reason` | 201 | `INSUFFICIENT_FUNDS`, `INSUFFICIENT_SHARES`, `NO_MARKET_PRICE` (in the order) |
| Malformed request | No | 400 | `VALIDATION_ERROR` |
| Cash instrument used as an asset | No | 400 | `INVALID_INSTRUMENT` |
| Unknown user or instrument | No | 404 | `USER_NOT_FOUND`, `INSTRUMENT_NOT_FOUND` |
| `amount` buys less than one share | No | 422 | `AMOUNT_BELOW_ONE_SHARE` |
| `amount` given but there is no price to convert it | No | 422 | `NO_PRICE_FOR_AMOUNT` |
| Order value above the cap ([0006](0006-integer-cents-and-order-value-cap.md)) | No | 422 | `ORDER_VALUE_TOO_LARGE` |
| Same idempotency key, different request ([0004](0004-idempotency-key.md)) | No | 422 | `IDEMPOTENCY_KEY_REUSED` |

The status code answers "was the resource created?". The `status` field of the order answers "what happened to it?". A rejected order has an id, appears in the order list and can be audited, so it was created.

- A MARKET order given as `size` for an instrument with no market price is stored `REJECTED` (`NO_MARKET_PRICE`). With `amount` there is no `size` to store, so it is a 422 with its own code, `NO_PRICE_FOR_AMOUNT`. The cause is the same and the contract is not, so the two never share a code: `NO_MARKET_PRICE` only ever appears as the `rejection_reason` of a stored order.
- That stored order has no price, so `orders.price` stays nullable. It is the only case where `price` is null; every other stored order has one.
- A `CASH_OUT` above the available balance follows the same rule as a trade: stored `REJECTED`, `INSUFFICIENT_FUNDS`, 201.
- Repeating a rejected request with the same idempotency key returns the stored rejection with `200` ([0004](0004-idempotency-key.md)).
- The first 422 cases are not stored because the `size` column cannot be filled: there is no valid order to record. The cap and the key conflict are limits of the API, not answers from the market, so they are treated like validation errors.

Error responses have one shape, `{ "error": { "code", "message" } }`, so a client can switch on `code` without reading text.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Store the order and return 422 with the order in the body | Makes failure obvious from the status code, and is the safer contract if third parties ever use the API. Rejected for now because the response would be an error for a resource that now exists, and "created, but with an error status" is harder to explain than "created, check `status`" |
| Return 200 instead of 201 | Hides that a row was created |
| Do not store rejected orders | Contradicts the brief, and loses the record of what the user tried to do |
| Store the 422 cases too, with a null `size` | Would need a nullable `size` and would mix API-level errors into the ledger |

## Consequences

- One response shape for every accepted submission: the client always switches on `status`.
- The order history is complete, including failed attempts, which helps support and fraud analysis.
- A client that only checks for a 2xx will read a rejected order as a success. This is the main cost of the decision, so it has to be stated in the API documentation and in the examples, next to the response.
- Rejected orders accumulate. They are excluded from the balance replay by status ([0001](0001-orders-table-as-ledger.md)), so they do not slow it down.
- Every case in the table needs a test, including the boundary between "stored" and "not stored".

## Tests

The ids are those of the [spec, section 7](../03-spec.md#7-tests); each test is grouped under its id.

| Test | What it pins |
| --- | --- |
| [O5](../../tests/orders.test.ts), [O6](../../tests/orders.test.ts), [O7](../../tests/orders.test.ts) | The three rejections are stored and answered `201`, each with its `rejectionReason` |
| [T2](../../tests/transfers.test.ts) | A `CASH_OUT` above the available balance follows the same rule |
| [O3](../../tests/orders.test.ts), [O7](../../tests/orders.test.ts), [O8](../../tests/orders.test.ts) | The 422 cases store nothing, including `amount` without a market price |
| [O9](../../tests/orders.test.ts), [O10](../../tests/orders.test.ts) | A malformed request, an unknown user or instrument and the cash instrument store nothing |
| [I3](../../tests/idempotency.test.ts) | A rejected request replays as the stored rejection |
| [E1](../../tests/errors.test.ts) | Every error has the one shape |

## Revisit when

- The API is opened to third parties, where "2xx means it worked" is a common expectation. The first alternative, with the stored order in the body, would then be the safer contract.
