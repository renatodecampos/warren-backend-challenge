# CLAUDE.md

Instructions for an AI assistant working in this repository. Short on purpose: the documents below are the source, this file only says how to work with them.

## Sources

| Question | Read |
| --- | --- |
| What to build, exactly | [`docs/03-spec.md`](docs/03-spec.md) |
| Why a decision was taken | [`docs/adr/`](docs/adr/README.md) |
| What the brief asks | [`docs/01-requirements.md`](docs/01-requirements.md) |

## Rules

1. **Spec first.** If the code needs a behaviour the spec does not describe, stop and say so. It is written in the spec before it is coded.
2. **Test first.** Each slice (spec, section 8) starts with its failing tests (spec, section 7). Keep the test ids (`O11`, `I3`) in the test names.
3. **Nothing extra.** No endpoint, field, dependency or abstraction the spec does not ask for.
4. **One source per fact.** If the spec and an ADR disagree, fix the document, then the code. Do not copy reasons into code comments; link the ADR.
5. **Done** means `npm run check` is green. Report failures as they are; never weaken or skip a test to get there.

## Hard limits

- `db/database.sql` is the base schema and seed. Never edit it; schema changes are migrations in `db/migrations/`.
- Never push to `main` or `development`. Work on `feature/slice-N-name`, branched from `development`, and open a pull request to `development`.
- Never read `.env`.
- Money is integer cents; `cost x sold` and `quantity x close` are `BigInt` ([ADR 0006](docs/adr/0006-integer-cents-and-order-value-cap.md)). No floats in arithmetic.
- Every write that changes a user's cash or shares takes the per-user lock first ([ADR 0003](docs/adr/0003-per-user-row-lock.md)).

The first three are also enforced by `.claude/settings.json`, and all of it by CI.

## Commands

```bash
npm run check        # type check + lint + tests: the definition of done
npm test             # tests only; creates and drops its own database
npm run typecheck
npm run lint
npm run db:up        # PostgreSQL 16 with the base file and the migration
npm run dev          # http://localhost:3000
```

Tests need a PostgreSQL to connect to (`npm run db:up`, or `TEST_ADMIN_URL`).

## Conventions

- TypeScript strict. SQL by hand through `pg`, parameters always bound, never concatenated.
- Routes do HTTP and validation only. Services own the transaction. The replay and the money arithmetic are pure.
- Errors the client should see are `AppError(status, code, message)`. Codes are listed in the spec, section 2.
- Code, comments and documents in English.
