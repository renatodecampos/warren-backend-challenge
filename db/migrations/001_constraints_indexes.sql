-- 001: integrity constraints, indexes, rejection reason and idempotency columns.
-- db/database.sql is not edited. Every change here is justified in docs/02-design.md, section 5.
-- Safe to run more than once.

-- A REJECTED order says why (INSUFFICIENT_FUNDS, INSUFFICIENT_SHARES, NO_MARKET_PRICE).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(40);

-- Safe retries (ADR 0004). Both stay null for requests sent without a key.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash CHAR(64);

-- A missing value would corrupt a balance.
-- price stays nullable: a MARKET order rejected for NO_MARKET_PRICE has none (ADR 0005).
ALTER TABLE orders
  ALTER COLUMN instrumentid SET NOT NULL,
  ALTER COLUMN userid       SET NOT NULL,
  ALTER COLUMN side         SET NOT NULL,
  ALTER COLUMN size         SET NOT NULL,
  ALTER COLUMN type         SET NOT NULL,
  ALTER COLUMN status       SET NOT NULL,
  ALTER COLUMN datetime     SET NOT NULL;

-- Invalid states become impossible even if application code has a bug.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_side_chk,
  DROP CONSTRAINT IF EXISTS orders_type_chk,
  DROP CONSTRAINT IF EXISTS orders_status_chk,
  DROP CONSTRAINT IF EXISTS orders_size_chk,
  ADD CONSTRAINT orders_side_chk   CHECK (side   IN ('BUY', 'SELL', 'CASH_IN', 'CASH_OUT')),
  ADD CONSTRAINT orders_type_chk   CHECK (type   IN ('MARKET', 'LIMIT')),
  ADD CONSTRAINT orders_status_chk CHECK (status IN ('NEW', 'FILLED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT orders_size_chk   CHECK (size > 0);

-- Backstop for the idempotency check, which already runs inside the per-user lock.
-- Rows without a key are not constrained: NULLs are distinct in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_user_idempotency_key ON orders (userid, idempotency_key);

-- Every request reads one user's orders by status.
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders (userid, status);

-- Latest price per instrument.
CREATE INDEX IF NOT EXISTS idx_marketdata_instrument_date ON marketdata (instrumentid, "date" DESC);

-- Substring search (ILIKE '%term%') on ticker and name without a full scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_instruments_ticker_trgm ON instruments USING gin (ticker gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_instruments_name_trgm   ON instruments USING gin (name   gin_trgm_ops);
