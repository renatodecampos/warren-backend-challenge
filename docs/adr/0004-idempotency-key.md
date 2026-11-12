# 0004. Retries are safe with an idempotency key

Status: Accepted
Requirements: FR-O1, FR-O9. Design: [02 Design, 4.5](../02-design.md#45-retries). Open question: Q10.

## Context

A client sends `POST /orders` and the connection times out. It cannot know whether the order was created, so it retries. Without protection the second request creates a second order, and with a MARKET order that moves real money twice. The brief does not mention retries, but this is a correctness gap, not a scaling one.

## Assumptions

- Clients can generate a unique key per intended order (a UUID is enough).
- Existing simple clients must keep working, so the key cannot be mandatory in this version.

## Decision

`POST /orders` and `POST /transfers` accept an `Idempotency-Key` header (1 to 50 printable characters). The key is unique **per user**: the same string from two users is two different keys.

The check runs inside the per-user lock ([0003](0003-per-user-row-lock.md)), before anything else is evaluated:

| Situation | Result |
| --- | --- |
| No key sent | Normal flow. No protection against retries |
| New key | Normal flow. The key and a fingerprint of the request are stored with the order |
| Same key, same request | `200` with the stored order. No new row, nothing re-evaluated |
| Same key, different request | `422 IDEMPOTENCY_KEY_REUSED`. The client is using one key for two intents |

Details that decide the behaviour:

- **The fingerprint covers the request, not the stored order.** A request with `amount` becomes a `size` that depends on the price at that moment, and a MARKET price can change between a request and its retry. Comparing stored fields would call a legitimate retry "different". So `orders` stores `request_hash`, a SHA-256 of the canonical request body (sorted keys, normalised numbers).
- **A rejected order keeps its key.** Repeating the request returns the same `REJECTED` order instead of trying again. A user who deposits money and wants to retry must send a new key. This is the intended meaning of idempotency: the same key is the same intent, with the same outcome.
- **Requests that store nothing do not store a key.** Validation errors (400), unknown user or instrument (404) and the 422 limits create no order, so the same key can be sent again once the request is fixed.
- **The key lives as long as the order.** There is no expiry, because `orders` is the ledger and the order is never deleted.
- A unique index on `(userId, idempotency_key)` is the backstop. The lock already makes a duplicate impossible, so the index only protects against a future writer that forgets the lock.

In production the header becomes mandatory (`400 IDEMPOTENCY_KEY_REQUIRED`). It is optional here only so that simple clients and examples keep working.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Natural key: same user, asset, side and size within N seconds | Guesses intent. It blocks legitimate repeated orders and still lets a retry through after N seconds |
| Client-generated order id as the resource (`PUT /orders/{uuid}`) | Idempotent by construction, but it changes the API shape the brief describes and still needs the same-id-different-body rule |
| Unique index only, answering `409` on a duplicate | The client learns that a duplicate exists, but not what happened to the original order, so it cannot recover |
| Store the response and replay the bytes | Exact replay, but a second copy of data that the order already holds |
| Do nothing | A duplicate order moves real money |

## Consequences

- A retry after a timeout cannot create a second order, on any number of instances.
- The client always learns the outcome of the original request, including a rejection.
- `orders` gets two columns and one unique index. They are null for clients that send no key, so they cost nothing for them.
- Without a key there is still no protection. Until the key is mandatory this is a documented gap, not a solved problem.
- The canonical form of the request has to be defined once and tested, or equal requests will hash differently.

## Revisit when

- A client needs to retry a rejected order with the same key. That would call for a time-limited key or an explicit "retry" operation.
- The table grows enough that keeping every key forever matters. Moving old keys out of the unique index then needs a retention rule.
