# Architecture Decision Records

The brief leaves several things open. Instead of guessing silently, each record states the **assumption** I worked with, the **decision**, the **alternatives** I discarded and the **trigger** that would make me revisit it. Context and options for all of them are in [02 Design](../02-design.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-orders-table-as-ledger.md) | The `orders` table is the ledger; balances are derived by replay | Accepted |
| [0002](0002-open-limit-orders-reserve-funds.md) | Open LIMIT orders reserve cash or shares | Accepted |
| [0003](0003-per-user-row-lock.md) | Concurrency is controlled with one row lock per user | Accepted |
| [0004](0004-idempotency-key.md) | Retries are safe with an idempotency key | Accepted |
| [0005](0005-rejected-orders-are-stored.md) | Orders refused by the market are stored as `REJECTED` and return 201 | Accepted |
| [0006](0006-integer-cents-and-order-value-cap.md) | Money is handled as integer cents, with a cap on order value | Accepted |
| [0007](0007-return-definitions.md) | Returns: total at average cost, daily per position | Accepted |
| [0008](0008-nfr-assumptions-and-production-path.md) | Non-functional assumptions and the path to production | Accepted |
| [0009](0009-stack-and-data-access.md) | Stack: TypeScript, Express, SQL through `pg`, tests against a real PostgreSQL | Accepted |

If you read only three, read [0002](0002-open-limit-orders-reserve-funds.md), [0003](0003-per-user-row-lock.md) and [0005](0005-rejected-orders-are-stored.md). They are the ones where another reasonable engineer would have built something different.

## Format

Every record has the same sections: Context, Assumption, Decision, Alternatives considered, Consequences, Revisit when. The header links to the requirements and the design section it comes from.

These records were written before the code. Where one names a test, the test does not exist yet; the link to the test file is added when the code lands.
