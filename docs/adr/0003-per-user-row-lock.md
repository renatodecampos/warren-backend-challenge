# 0003. Concurrency is controlled with one row lock per user

Status: Accepted
Requirements: FR-O7, FR-O10. Design: [02 Design, 4.2](../02-design.md#42-how-to-stop-two-orders-spending-the-same-money). Open questions: Q9, Q13.

## Context

Accepting an order is a check followed by a write: read the user's available cash or shares, then insert the order. Two simultaneous requests from the same user can both pass the check and together spend more than the user has. The brief does not mention concurrency, but a rule that says "reject when there is not enough balance" is only true if the check and the insert cannot interleave.

Balances are derived, not stored ([0001](0001-orders-table-as-ledger.md)), so there is no balance row whose constraint could catch the overspend.

## Assumptions

- The API runs as several instances behind a load balancer, so the guard must live in the database and not in process memory.
- Order submission favours consistency over availability: when in doubt it waits or refuses. Accepting an order and reconciling later is not acceptable for money.
- Contention is per user and low. One user rarely sends many orders at the same instant.

## Decision

Every operation that can change a user's cash or shares (an order or a transfer) starts its transaction by locking that user's row:

```sql
SELECT id FROM users WHERE id = $1 FOR UPDATE
```

- The transaction runs at `READ COMMITTED`. A second request for the same user waits on the row, and once it gets the lock its next statements see what the first one committed. Check and insert become one atomic step per user.
- Different users never block each other.
- The same read returns 404 for an unknown user, so the lock costs no extra query.
- The idempotency check ([0004](0004-idempotency-key.md)) happens after the lock, so two requests with the same key cannot both pass it.
- Reads do not take the lock. The portfolio runs in a `REPEATABLE READ READ ONLY` transaction to get one consistent snapshot across its queries.
- Cancelling an order is one conditional `UPDATE ... WHERE status = 'NEW'`, without the lock. It can only release a reservation, so the worst outcome of a race is that a concurrent order sees slightly less available than it could have.
- There is a single lock per operation, so there is no lock ordering to get wrong and no deadlock between two users.

## Evidence

In a first prototype (kept outside this repository) a test fired 10 simultaneous orders at a balance that fits 3 of them, and expected exactly 3 filled and 7 rejected. With the lock removed it let 6 to 9 orders through; with the lock it passed every time. The same test will be written for this version before the implementation, and this record will link to it.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| `SERIALIZABLE` isolation with retries | Correct without explicit locks, but every conflict becomes a failed transaction that must be retried, which costs more exactly when one user is contending with themselves |
| Advisory lock on the user id | Same behaviour without touching the `users` row. The row lock is easier to read and to explain, and the row has to be read anyway to answer 404 |
| Balance row with `CHECK (balance >= 0)` and an atomic `UPDATE` | The strongest guarantee and the shortest lock. It requires materialised balances, which [0001](0001-orders-table-as-ledger.md) defers |
| In-process mutex per user | Breaks as soon as there is a second instance |
| Optimistic check: insert, then verify the balance and roll back | Two transactions can each verify against a snapshot that excludes the other, so both commit |

## Consequences

- No overdraft from concurrent requests, on any number of instances.
- Orders of one user are processed one at a time. The lock is held for the whole replay of that user's history, so its duration grows with the history.
- Any future writer that changes a user's cash or shares must take the same lock. A LIMIT execution job is the obvious example.
- A long transaction holding the lock blocks that user's other orders. Statement and lock timeouts are part of the production path ([0008](0008-nfr-assumptions-and-production-path.md)).

## Revisit when

- Lock wait time for a user becomes visible in latency.
- Balances are materialised: the lock can then shrink to a single atomic update guarded by a constraint.
