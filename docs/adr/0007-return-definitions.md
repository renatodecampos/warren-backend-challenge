# 0007. How returns are defined: total return at average cost, daily return per position

Status: Accepted
Requirements: FR-P1, FR-P3, FR-P5. Design: [02 Design, section 2](../02-design.md#2-open-questions-and-the-assumption-i-work-with). Open questions: Q3, Q4, Q8.

## Context

The brief asks for a **total return (%)** per position in the portfolio. Separately, its functional notes say to use `close` and `previousClose` "to calculate the daily return". It defines neither formula. Two methods give different numbers once a position has been partly sold, and the brief mentions both returns without saying where each goes.

## Assumption

The reader wants numbers that can be checked by hand from the order history. Tax reporting is out of scope.

## Decision

Both returns are returned, per position. The portfolio also returns the total account value ([0002](0002-open-limit-orders-reserve-funds.md)).

**Position value.** `quantity x close`, where `close` is the latest non-null `close` in `marketdata` for that instrument.

**Cost, at average cost.** Replaying the user's `FILLED` orders in order ([0001](0001-orders-table-as-ledger.md)):

- A BUY adds `size x price` to the cost and `size` to the quantity.
- A SELL removes cost in proportion to the shares sold: `cost x sold / quantity` before the sale, rounded to the nearest cent ([0006](0006-integer-cents-and-order-value-cap.md)).

**Total return (%).** `(position value - cost) / cost`, shown as a percentage with two decimals.

**Daily return (%).** `(close - previousClose) / previousClose`, from the same `marketdata` row as the position value, shown with two decimals.

Worked example, which is also a test:

| Step | Quantity | Cost |
| --- | --- | --- |
| BUY 10 at 100.00 | 10 | 1,000.00 |
| BUY 10 at 120.00 | 20 | 2,200.00 (average 110.00) |
| SELL 5 | 15 | 2,200.00 - 550.00 = 1,650.00 |

With `close = 130.00` and `previousClose = 125.00`: position value 1,950.00, total return (1,950 - 1,650) / 1,650 = **18.18%**, daily return (130 - 125) / 125 = **4.00%**.

**Edge cases**

| Case | Behaviour |
| --- | --- |
| Instrument with no market price | Valued at cost, with `priceAvailable: false`, so the account total does not silently drop |
| `previousClose` null or zero | Daily return is `null`; no division by zero |
| Cost is zero | Total return is `null` |
| Quantity is zero or negative | The position is not listed |
| Reserved shares in open SELL orders | They are still held, so they stay in quantity and value ([0002](0002-open-limit-orders-reserve-funds.md)) |

There is no daily return for the whole account. It would be distorted by deposits, withdrawals and orders executed during the day, and fixing that needs a time-weighted return, which the brief does not ask for.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| FIFO cost basis | Needs lots tracked per purchase. It matters for tax reporting, which is out of scope, and it is harder to check by hand |
| Total return against the last price paid | Ignores earlier purchases, so a position bought in steps gets a misleading number |
| Daily return for the whole account | Needs a time-weighted method the brief does not mention |
| Only one of the two returns | The brief lists total return in the portfolio and daily return in its notes. Returning both avoids guessing which one the consumer wants |

## Consequences

- Every number can be reproduced from the order history and one `marketdata` row.
- Average cost needs the order of buys and sells, so it is computed in code during the replay, not in plain SQL.
- Rounding to the cent on each sale means the cost of a position can differ by a cent from a calculation done once at the end. The worked example is chosen to avoid ambiguity, and tests pin the exact values.
- `marketdata` holds only the last two days, so `previousClose` always comes from the same row as `close`; there is no history to compute longer returns.

## Revisit when

- A tax or accounting report requires FIFO.
- A consumer needs a return for the whole account, which would call for a time-weighted method.
