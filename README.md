# warren-backend-challenge

A small trading API: **portfolio**, **asset search** and **order submission** (MARKET and LIMIT), on Node.js, TypeScript, Express and PostgreSQL.

**Status: slice 0 done, of slices 0 to 9.** The requirements, the design, the decision records and the spec are complete. The code is written from the spec, test first, one slice at a time ([spec, section 8](docs/03-spec.md#8-order-of-work)). In place so far: the project skeleton, the database with its migration, the health endpoint, the error contract and the guard-rails. The three endpoints of the brief come in the next slices.

## The three decisions that matter

The brief leaves several things open. Most of my answers are unsurprising. These three are the ones where another reasonable engineer would have built something different, so they are where I would start a review.

| Decision | What I chose | What it costs |
| --- | --- | --- |
| [Open LIMIT orders reserve funds](docs/adr/0002-open-limit-orders-reserve-funds.md) | A `NEW` BUY blocks `size x limit price`, a `NEW` SELL blocks its shares. The account can never be overdrawn by a later execution | It is a business rule the brief does not state. Available balance is lower than the cash balance, so the portfolio returns both |
| [One row lock per user](docs/adr/0003-per-user-row-lock.md) | The balance check and the insert are one atomic step, on any number of instances | One user's orders run one at a time, and the lock lasts as long as the replay of that user's history |
| [Rejected orders are stored and return 201](docs/adr/0005-rejected-orders-are-stored.md) | The order was created, so the status code says so, and the client reads `status` | A client that only checks for 2xx reads a rejection as a success |

## The three things I would ask first

None of these blocked the work: each has a written assumption and a trigger to revisit it. They are the answers that would change the most.

1. **Can I have the original `database.sql`?** It did not come with the brief, so I rebuilt the schema and a seed from the description. Column names and types may differ from yours.
2. **Should an open LIMIT order block cash and shares?** I assumed yes ([ADR 0002](docs/adr/0002-open-limit-orders-reserve-funds.md)).
3. **What is the real volume?** Active users, orders per second at market open, and orders per user. I assumed thousands of users and a few thousand orders each, and that is what lets balances be computed instead of stored ([ADR 0001](docs/adr/0001-orders-table-as-ledger.md), [ADR 0008](docs/adr/0008-nfr-assumptions-and-production-path.md)).

## Reading order

| Step | Document | What it gives you |
| --- | --- | --- |
| 1 | [Challenge brief](docs/00-challenge-brief.md) | The original text, verbatim |
| 2 | [Requirements](docs/01-requirements.md) | The brief as testable requirements, and the 13 points it leaves open |
| 3 | [Design](docs/02-design.md) | The picture, the assumption for each open point, the options weighed, the schema changes |
| 4 | [Decision records](docs/adr/README.md) | One record per decision: assumption, alternatives, consequences, when to revisit |
| 5 | [Spec](docs/03-spec.md) | Exactly what is built: endpoint contracts, rules, schema changes, the test list and the order of work |

Short on time: this page, then the three records above.

## Running it

Requirements: Node 20+ and Docker.

```bash
npm install
npm run db:up        # PostgreSQL 16 with db/database.sql and the migration applied
npm run dev          # http://localhost:3000
npm run check        # type check + lint + tests
```

The defaults match `docker-compose.yml`, so nothing else is needed. To change them, set the variables in `.env.example`. The tests create and drop their own database (`warren_challenge_test`) and never touch the development one.

No Docker? Point `DATABASE_URL` and `TEST_ADMIN_URL` to any PostgreSQL 13+ and run `db/database.sql`, then `db/migrations/001_constraints_indexes.sql`, on an empty database.

The stack is described in [ADR 0009](docs/adr/0009-stack-and-data-access.md).

## How it is built

The code is written with an AI coding assistant, from the spec. Three layers keep that honest, described in the [spec, section 6](docs/03-spec.md#guard-rails):

1. `npm run check` is the definition of done: strict types, type-aware lint and the whole suite.
2. CI runs the same command on every pull request, and `main` and `development` only take merges with it green.
3. The assistant works under versioned limits ([`.claude/settings.json`](.claude/settings.json), [`CLAUDE.md`](CLAUDE.md)): it cannot edit the base schema, read `.env` or push to a shared branch.

Each slice is a branch from `development` and a pull request that I review.
