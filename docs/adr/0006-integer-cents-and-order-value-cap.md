# 0006. Money is handled as integer cents, with a cap on order value

Status: Accepted
Requirements: FR-O5, FR-O7, FR-P6. Design: [02 Design, 4.6](../02-design.md#46-money-representation). Open question: Q12.

## Context

Prices are `NUMERIC(10,2)` in the database. JavaScript numbers are binary floating point: `0.1 + 0.2` is not `0.3`. Summing hundreds of orders in floats produces balances that are off by a cent, and a balance check that is wrong by a cent either rejects a valid order or accepts an invalid one.

Integers fix this, but only up to a point. JavaScript numbers are exact for integers up to `Number.MAX_SAFE_INTEGER`, about 9 x 10^15. In cents that is 90 trillion pesos, which sounds safe until the inputs are looked at: `size` can be as large as the 32-bit `INT` column (about 2.1 x 10^9) and a price can reach 99,999,999.99, so one order's `size x price` can reach about 2 x 10^19 cents. Each input is valid; their product is not exact.

## Assumptions

- One currency (pesos) with two decimal places.
- Shares are whole numbers, as the brief requires (`orders.size` is an `INT`).
- Transfers are whole pesos, because they are stored as `size` with price 1 (Q12).

## Decision

**Integer cents everywhere in the code.**

- The database converts on the way out: `(price * 100)::bigint`.
- All arithmetic uses integer cents: balances, reservations, positions, cost.
- Floats exist only at the edge: parsing the request (after checking for at most two decimals) and formatting the response.
- Buying by `amount` uses `floor(amount / price)`, so the user never spends more than they asked to ([FR-O5](../01-requirements.md#orders)).
- Where a division or percentage is unavoidable (average cost after a partial sale, returns), it is rounded once, at that step, to the nearest cent.

**A cap on the value of one order.** `size x price` may not exceed 99,999,999.99 pesos (9,999,999,999 cents), the same ceiling that `amount` and `price` already have because of the column type. Above it the API answers `422 ORDER_VALUE_TOO_LARGE` and stores nothing ([0005](0005-rejected-orders-are-stored.md)).

- The cap is checked **before** any other arithmetic with the product. Above 9 x 10^15 the multiplication itself is inexact, but such a value is far above the cap, so the comparison is still right.
- With the cap, a single order is at most 10^10 cents, so an account would need about 900,000 maximum-value orders before a running sum approaches the safe-integer limit.
- For a MARKET order the price is only known after reading the latest `close`, so the cap is checked in the service, not in the request schema.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A decimal library (`decimal.js`, `big.js`) | The right choice with several currencies or more than two decimals. One more dependency and slower arithmetic for a single two-decimal currency |
| `BigInt` everywhere | Removes the size limit, and the cap would not be needed. It does not serialise to JSON and makes every arithmetic expression noisier |
| All the arithmetic in SQL with `NUMERIC` | Exact, but average cost depends on replaying orders in sequence, which is done in code ([0001](0001-orders-table-as-ledger.md)) |
| Floats, rounding at the end | Simplest, and wrong by a cent after enough additions |
| No cap; rely on "insufficient funds" to reject absurd orders | Usually true, but the check itself would be done with inexact arithmetic exactly when the numbers are absurd |

## Consequences

- Sums, comparisons and balance checks are exact.
- Rounding happens in a few known places, not everywhere.
- The cap is a technical limit tied to the `NUMERIC(10,2)` column, not a business rule. A real per-order limit is a product and risk decision, and it would replace this constant.
- Two orders of 99,999,999.99 pesos are fine; one of 100 million is not. A client that needs larger orders must split them, which is a contract change to be aware of.
- The cap needs a test on each side: exactly at the limit is accepted, one cent above is refused, and an absurd `size x price` is refused without being stored.

## Revisit when

- A second currency, fractional shares, or instruments quoted with more than two decimals are introduced. Any of them calls for a decimal type with an explicit scale per instrument.
- Product defines a real per-order limit.
