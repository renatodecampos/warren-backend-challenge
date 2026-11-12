# 0001. The `orders` table is the ledger; balances are derived by replay

Status: Accepted
Requirements: FR-P1, FR-P2, FR-P3, FR-P4, FR-O9, FR-O10. Design: [02 Design, 4.1](../02-design.md#41-how-to-know-a-users-balance-and-positions). Open question: Q13 (volume).

## Context

The portfolio needs available cash, positions and returns, and every order submission needs the same numbers to decide whether the order can be accepted. So this choice sits on the write path as well as the read path.

The brief points at one answer: "To calculate holdings and the available balance in pesos, use all relevant transactions in the `orders` table, based on the `size` column." It also models cash as an instrument (`ARS`, type `MONEDA`) and deposits and withdrawals as orders (`CASH_IN`, `CASH_OUT`). The schema has no balance or position table.

## Assumption

Volume is low: a user has at most a few thousand orders, so reading that user's `FILLED` orders through an index is cheap. This is an assumption, not a measurement.

## Decision

Cash and positions are never stored. They are rebuilt on demand by replaying the user's `FILLED` orders in chronological order (`datetime`, then `id` to break ties):

| Side | Effect |
| --- | --- |
| `CASH_IN` | cash increases by `size x price` (price is 1 for `ARS`) |
| `CASH_OUT` | cash decreases by `size x price` |
| `BUY` | cash decreases; shares and cost increase |
| `SELL` | cash increases; shares decrease; cost is removed in proportion to the shares sold (average cost) |

`size` is always positive in the table; `side` gives the direction. Deposits, withdrawals and trades are one stream of events per user, so there is one place to read and one place to audit.

Only `FILLED` orders count towards cash and positions (FR-P4). `NEW` orders do not move cash; how they affect what is available is a separate decision (ADR 0002, planned).

## Alternatives considered

| Alternative | Why not now |
| --- | --- |
| `balances` and `positions` tables updated in the same transaction as the order | Constant-time reads, and a `CHECK (balance >= 0)` gives a second safety net. It also creates a second source of truth that can drift from the history and needs a reconciliation job. Not justified at the assumed volume, and the brief points the other way |
| Periodic snapshots plus replay of the orders after the snapshot | Bounds the replay cost while keeping the ledger authoritative. More moving parts than this case needs |
| Aggregate in SQL (`SUM ... GROUP BY`) instead of replaying in code | Works for cash and quantity. Average cost depends on the order of buys and sells, which is awkward in plain SQL |

## Consequences

- One source of truth. A balance cannot disagree with the history, and the history is the audit trail.
- The cost of every order submission and every portfolio read grows with the number of orders of that user.
- The replay runs inside the per-user lock that protects order submission, so a long history also lengthens the time the lock is held. This is the first thing that breaks under growth.
- Bad history is visible instead of hidden. If an order stream ever shows a user holding fewer than zero shares, the replay keeps the cash effect and the portfolio simply does not list a non-positive position. The write path is what must prevent it.
- The `(userId, status)` index keeps the read to one user's rows; rejected and cancelled orders do not enter the replay.

## Revisit when

- A user's order count makes the replay noticeable in order submission latency, or lock wait time shows up in metrics.
- A second writer appears, for example a job that executes LIMIT orders, which increases contention on the same lock.

The next step would be the first alternative: materialised balances and positions written in the same transaction, `orders` kept as the audit trail, and a check that compares both.
