# Architecture Decision Records

The brief leaves several things open. Instead of guessing silently, each record states the **assumption** I worked with, the **decision**, the **alternatives** I discarded and the **trigger** that would make me revisit it. Context and options for all of them are in [02 Design](../02-design.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-orders-table-as-ledger.md) | The `orders` table is the ledger; balances are derived by replay | Accepted |
| [0002](0002-open-limit-orders-reserve-funds.md) | Open LIMIT orders reserve cash or shares | Accepted |
| 0003 | Concurrency is controlled with one row lock per user | Planned |
| 0004 | Retries are safe with an idempotency key | Planned |
| 0005 | Orders refused by the market are stored as `REJECTED` and return 201 | Planned |
| 0006 | Money is handled as integer cents, with a cap on order value | Planned |
| 0007 | How returns are defined (total and daily) | Planned |
| 0008 | Non-functional assumptions and the path to production | Planned |

## Format

Every record has the same sections: Context, Assumption, Decision, Alternatives considered, Consequences, Revisit when. The header links to the requirements and the design section it comes from.
