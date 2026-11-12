# 0009. Stack: TypeScript, Express, SQL through `pg`, tests against a real PostgreSQL

Status: Accepted
Requirements: NFR-1, NFR-2. Design: [02 Design, 4.7](../02-design.md#47-where-to-compute-sql-or-application).

## Context

The brief fixes Node.js and leaves the rest open: "Use a framework of your choice", "Choose a data access strategy or library. You may use an ORM or execute queries directly", and it asks for a functional test of order submission.

The service is small: three capabilities, one database. What is hard in it is not routing or wiring. It is one transaction that takes a lock, reads a user's history, decides and writes ([0003](0003-per-user-row-lock.md)). The stack should make that transaction easy to read and easy to test, and add as little as possible around it.

## Assumptions

- The people reading this code have little time. Every layer between the HTTP request and the SQL is something they must understand before they can judge the decisions.
- There is no existing team standard to follow. In a real team the standard wins over my preference (see "Revisit when").

## Decision

| Concern | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, strict mode, Node 20+ | Types on the order and money paths catch mistakes that tests would need many cases to find |
| HTTP | Express | The most widely known Node framework: no reviewer has to learn it. Throughput is limited by the database transaction, not by the router |
| Validation | `zod` at the edge | One schema gives the runtime check and the static type, and one error shape ([0005](0005-rejected-orders-are-stored.md)) |
| Data access | SQL written by hand, through `pg` | The design depends on `SELECT ... FOR UPDATE`, an explicit transaction, isolation levels and `pg_trgm` ranking. All of them are plain SQL and awkward through an ORM |
| Schema changes | Numbered `.sql` migration files | One migration today. A migration tool would be more machinery than the change it manages |
| Tests | `vitest` and `supertest`, against a real PostgreSQL | The behaviour that matters lives in the database: the lock, the constraints, the unique index. A mocked database would test none of it |
| Local environment | Docker Compose with PostgreSQL 16 | One command to get the same database the tests use |
| Checks | `npm run check`: strict type check, type-aware ESLint, the whole suite. The same command runs in CI | The code is written with an AI assistant, so "done" has to be something a machine can refuse ([03 Spec, section 6](../03-spec.md#guard-rails)) |

Layout: routes (HTTP and validation), services (one per capability, own the transaction), and a pure module for the replay and the money arithmetic, which has no I/O and is tested without a database.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| NestJS | Gives structure that pays off with many modules and many engineers. For three endpoints it adds decorators, modules and dependency injection between the reader and the transaction |
| Fastify | Faster, and schema-first. The speed does not matter while the database is the limit, and fewer people read it fluently |
| An ORM (Prisma, TypeORM) | The row lock, the isolation level and the search ranking would be raw SQL anyway, so there would be two ways of talking to the database. An ORM also makes it less obvious which statements run inside the lock |
| A query builder (Knex) | Removes little here: the queries are few and fixed |
| Unit tests with a mocked repository | Fast, and blind to the concurrency bug this design exists to prevent ([0003](0003-per-user-row-lock.md)) |
| Testcontainers | Starts the database from the test itself. Docker Compose does the same job with one less dependency, and is also what a developer uses to run the API |

## Consequences

- Few dependencies: `express`, `pg` and `zod` at runtime. Less to audit and to keep up to date.
- The SQL is visible. A reviewer can read the exact statements that run inside the lock.
- Nothing maps rows to objects for me. Each query has a small hand-written mapping, and `pg` returns `NUMERIC` and `BIGINT` as strings, so the conversion to integer cents ([0006](0006-integer-cents-and-order-value-cap.md)) is explicit and happens in one place.
- No compile-time check that a query matches the schema. The functional tests against the real database are what catch a wrong column.
- Tests need Docker, or a PostgreSQL to point at. They are slower than mocked unit tests, which is acceptable at this size.
- Express gives no structure by itself. The layout above is a convention that the code has to keep.

## Tests

The ids are those of the [spec, section 7](../03-spec.md#7-tests); each test is grouped under its id.

| Test | What it pins |
| --- | --- |
| [D1](../../tests/health.test.ts) | The base file and the numbered migration apply to an empty PostgreSQL |
| [O11](../../tests/orders.test.ts) | What a mocked database could not test: the lock, on a real PostgreSQL |

## Revisit when

- The service joins a team that already has a standard (framework, ORM, migration tool). Consistency across services is worth more than any of the reasons above.
- The number of modules or engineers grows enough that conventions stop being enough, which is where NestJS earns its cost.
- The schema changes often. A migration tool and generated query types would then pay for themselves.
