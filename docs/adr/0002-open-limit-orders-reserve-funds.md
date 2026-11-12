# 0002. Open LIMIT orders reserve cash or shares

Status: Accepted
Requirements: FR-P1, FR-P2, FR-O4, FR-O7, FR-O8. Design: [02 Design, 4.3](../02-design.md#43-reserving-funds-for-open-limit-orders). Open questions: Q1, Q5.

## Context

A LIMIT order is stored as `NEW` and may execute later. The brief says the portfolio must show the balance "available for trading", and that an order without enough pesos (BUY) or enough shares (SELL) must be rejected. It does not say whether an open LIMIT order counts against what is available.

This is a business rule, not a technical one, and it is the assumption I would most like to confirm with the product owner.

## Assumption

An open LIMIT order blocks what it may need until it is executed or cancelled.

## Decision

- A `NEW` BUY reserves `size x limit price` of cash.
- A `NEW` SELL reserves its shares.
- Cash balance counts `FILLED` orders only ([0001](0001-orders-table-as-ledger.md)).
- **Available balance** = cash balance minus reserved cash. New BUY orders and withdrawals are checked against it. New SELL orders are checked against shares held minus reserved shares.
- **Total account value** = cash balance plus the market value of holdings. Reserved cash is still the user's money, so it is not subtracted here.
- Reservations are never stored. They are computed from the user's `NEW` orders, so cancelling an order releases its reservation immediately and there is nothing to clean up.

The limit price is used because it is the worst case for a BUY: it is the only amount that guarantees the order can be honoured if it executes.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| No reservation; check funds only when the order executes | A user could open LIMIT orders worth many times their cash. Whichever executes first wins and the rest fail late, far from the moment the user made the decision |
| Reserve at the current market price instead of the limit price | A BUY can execute at its limit, which may be higher than today's price, so the order could not be honoured |
| Store reservations in their own table | Needed once partial fills exist. Today a reservation is fully described by the open order, and a second record would need to be kept in sync |

## Consequences

- The account cannot be overdrawn by a later execution.
- Money can stay locked in orders that never execute. The user sees it as the difference between cash balance and available balance, and can cancel to release it.
- Executing LIMIT orders is out of scope (the brief says there is no need to simulate the market), so nothing moves an order from `NEW` to `FILLED` yet. When something does, it must take the same per-user lock as order submission ([0003](0003-per-user-row-lock.md)).
- A `NEW` order is part of the read that every submission does, so the `(userId, status)` index matters for both statuses.

## Revisit when

- The product owner says open orders should not block funds, or should block only part of them.
- Partial fills, order expiry (day or good-till-cancelled orders) or fees are introduced. Each of them changes how much a single order reserves.
