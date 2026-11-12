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

**A cap on the value of one order.** `size x price` may not exceed 99,999,999.99 pesos (9,999,999,999 cents). Above it the API answers `422 ORDER_VALUE_TOO_LARGE` and stores nothing ([0005](0005-rejected-orders-are-stored.md)).

- The number is a placeholder that I chose, not something the schema imposes: `size x price` is not stored in any column. What the arithmetic needs is only that a cap exists, low enough to leave room for sums. I picked the largest price the `NUMERIC(10,2)` column can hold, so one share at any storable price is always accepted.
- It applies to every row written to `orders`, transfers included (`size x 1`). One rule for the whole ledger is what makes the sum argument below hold.
- The cap is checked **before** any other arithmetic with the product. Above 9 x 10^15 the multiplication itself is inexact, but such a value is far above the cap, so the comparison is still right.
- With the cap, a single order is at most 10^10 cents, so an account would need about 900,000 maximum-value orders before a running sum approaches the safe-integer limit.
- The cap bounds `size x price` of one order and the sums built from it. It does **not** bound two other products, so these are computed in `BigInt`:
  - `cost x sold` in the average-cost step of a partial sale ([0007](0007-return-definitions.md)). A position that cost 50 million pesos (5 x 10^9 cents) with 2,000,000 shares sold gives 10^16, above the limit, with every input valid. The result of the division is never larger than `cost`, so it goes back to a number safely. Passing the limit does not make every result wrong: the float error only shows when the exact value sits next to half a cent. Test [U5](../../tests/money.test.ts) pins one such case, a position that cost 544,905,518.45 pesos where floats remove one cent too many.
  - `quantity x close` for the value of a position. The quantity is a sum over several orders and `close` can be far above the prices paid. The result is converted back with a `Number.isSafeInteger` check, and the request fails loudly instead of returning a wrong value.
- For a MARKET order the price is only known after reading the latest `close`, so the cap is checked in the service, not in the request schema.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A decimal library (`decimal.js`, `big.js`) | The right choice with several currencies or more than two decimals. One more dependency and slower arithmetic for a single two-decimal currency |
| `BigInt` everywhere | Removes the size limit, and the cap would not be needed. It does not serialise to JSON and makes every arithmetic expression noisier. Used only for the two products the cap does not bound |
| All the arithmetic in SQL with `NUMERIC` | Exact, but average cost depends on replaying orders in sequence, which is done in code ([0001](0001-orders-table-as-ledger.md)) |
| Floats, rounding at the end | Simplest, and wrong by a cent after enough additions |
| No cap; rely on "insufficient funds" to reject absurd orders | Usually true, but the check itself would be done with inexact arithmetic exactly when the numbers are absurd |

## Consequences

- Sums, comparisons and balance checks are exact. The two products outside the cap are exact because they use `BigInt`, and each needs a test with values above the safe-integer limit.
- Rounding happens in a few known places, not everywhere.
- The cap is a technical placeholder, not a business rule. A real per-order limit is a product and risk decision, and it would replace this constant. Raising it is cheap: each factor of 10 divides the headroom for sums by 10 (90,000 maximum-value orders at 10^11 cents).
- The value is not large for a broker, and inflation makes it smaller in real terms every year. A deposit or an order of 100 million pesos is refused. Two of 99,999,999.99 are fine, so a client that needs more must split, which is a contract detail to state in the API documentation.
- The cap needs a test on each side: exactly at the limit is accepted, one cent above is refused, and an absurd `size x price` is refused without being stored.

## Tests

The ids are those of the [spec, section 7](../03-spec.md#7-tests); each test name starts with its id.

| Test | What it pins |
| --- | --- |
| [U7](../../tests/money.test.ts) | The two-decimal check and the conversion to cents, without float drift |
| [U6](../../tests/money.test.ts), [O8](../../tests/orders.test.ts) | The cap on each side: at the limit accepted, one cent above refused, an absurd product refused and not stored |
| [U5](../../tests/money.test.ts) | `cost x sold` and `quantity x close` above the safe-integer limit are exact, or fail loudly |
| [O2](../../tests/orders.test.ts) | Buying by `amount` stores `floor(amount / price)` shares |

## Revisit when

- A second currency, fractional shares, or instruments quoted with more than two decimals are introduced. Any of them calls for a decimal type with an explicit scale per instrument.
- Product defines a real per-order limit.
