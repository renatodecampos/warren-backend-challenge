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
- A SELL of part of the position removes cost in proportion to the shares sold: `cost x sold / quantity` before the sale, rounded to the nearest cent. The product is computed in `BigInt`, because the order value cap does not bound it ([0006](0006-integer-cents-and-order-value-cap.md)).
- A SELL of the whole position or more sets the cost to zero. The quantity is still reduced by `size`, so it can reach zero or go below it.
- While the quantity is zero or negative the cost stays zero. A BUY made from a negative quantity adds cost only for the shares that bring the quantity above zero, at that BUY's price.

The last two rules exist because the seed data has a sale larger than the holding (Q11). Applying the proportional formula there would remove more cost than exists, leave a negative cost, and corrupt the average of every later purchase.

**Total return (%).** `(position value - cost) / cost`, shown as a percentage with two decimals. It is the unrealised return of the shares still held. The gain or loss on shares already sold went to the cash balance and is not in this number.

**Daily return (%).** `(close - previousClose) / previousClose`, from the same `marketdata` row as the position value, shown with two decimals.

Each example below is a test with these exact values: [U1](../../tests/accountState.test.ts), [U2](../../tests/accountState.test.ts), [U3](../../tests/accountState.test.ts).

Worked example:

| Step | Quantity | Cost |
| --- | --- | --- |
| BUY 10 at 100.00 | 10 | 1,000.00 |
| BUY 10 at 120.00 | 20 | 2,200.00 (average 110.00) |
| SELL 5 | 15 | 2,200.00 - 550.00 = 1,650.00 |

With `close = 130.00` and `previousClose = 125.00`: position value 1,950.00, total return (1,950 - 1,650) / 1,650 = **18.18%**, daily return (130 - 125) / 125 = **4.00%**.

Rounding example. "Nearest cent" means half a cent rounds up. The cost removed by a sale is subtracted from the running cost, and the last sale removes whatever is left, so no cent is lost along the way.

| Step | Quantity | Cost |
| --- | --- | --- |
| BUY 2 at 10.00 | 2 | 20.00 |
| BUY 1 at 10.01 | 3 | 30.01 |
| SELL 1 | 2 | 30.01 - 10.00 = 20.01 (30.01 x 1 / 3 = 10.0033, rounds to 10.00) |
| SELL 1 | 1 | 20.01 - 10.01 = 10.00 (20.01 x 1 / 2 = 10.005, rounds to 10.01) |
| SELL 1 | 0 | 0.00 (whole position) |

The three sales remove 10.00 + 10.01 + 10.00 = 30.01, the full cost.

Oversold example, from my rebuilt seed data (user 1, instrument 31). The last row is not in the seed; it shows what a later purchase would do.

| Step | Quantity | Cost |
| --- | --- | --- |
| BUY 20 at 1,540.00 | 20 | 30,800.00 |
| SELL 30 at 1,530.00 | -10 | 0.00 (not 30,800.00 - 46,200.00) |
| BUY 20 at 1,500.00 | 10 | 10 x 1,500.00 = 15,000.00 |

After the second step the position is not listed, and the 45,900.00 from the sale stays in the cash balance.

**Edge cases**

| Case | Behaviour |
| --- | --- |
| Instrument with no market price | Valued at cost, with `priceAvailable: false`, so the account total does not silently drop. Total return and daily return are `null`, not 0%: there is no price to measure against |
| `previousClose` null or zero | Daily return is `null`; no division by zero |
| Cost is zero | Total return is `null` |
| Quantity is zero or negative | The position is not listed, and its cost is zero |
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
- Rounding to the cent on each sale means the cost of a position can differ by a cent from a calculation done once at the end. The rounding example fixes the rule, and tests pin the exact values.
- A position that was partly sold at a profit shows only the return of what is left. A user who wants "how much did I make on this asset" needs realised gains as well, which this version does not report.
- `marketdata` holds only the last two days, so `previousClose` always comes from the same row as `close`; there is no history to compute longer returns.

## Tests

The ids are those of the [spec, section 7](../03-spec.md#7-tests); each test name starts with its id.

| Test | What it pins |
| --- | --- |
| [U1](../../tests/accountState.test.ts) | The worked example |
| [U2](../../tests/accountState.test.ts) | The rounding example |
| [U3](../../tests/accountState.test.ts) | The oversold example, including the later purchase |
| [P1](../../tests/portfolio.test.ts) | Both returns and the average cost, on the seed portfolio |
| [P2](../../tests/portfolio.test.ts) | No market price: valued at cost, both returns `null`, `priceAvailable: false` |

## Revisit when

- A tax or accounting report requires FIFO.
- A consumer needs a return for the whole account, which would call for a time-weighted method.
