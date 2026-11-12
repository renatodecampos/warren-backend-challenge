import { createHash } from 'node:crypto';
import type { ClientBase, Pool } from 'pg';
import { availableCashCents, availableShares, loadAccountState } from './accountState';
import { transaction } from './db';
import { AppError } from './errors';
import { exceedsOrderValueCap, fromCents, MAX_ORDER_SIZE, sharesForAmount, toCents } from './money';

/** Orders and transfers (spec, sections 4.3 to 4.6). What is stored and what is refused: ADR 0005. */

/** The validated body of `POST /orders`: money in pesos, exactly as the client sent it. */
export interface OrderRequest {
  userId: number;
  instrumentId?: number | undefined;
  ticker?: string | undefined;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  size?: number | undefined;
  amount?: number | undefined;
  price?: number | undefined;
}

/** The validated body of `POST /transfers`: whole pesos. */
export interface TransferRequest {
  userId: number;
  side: 'CASH_IN' | 'CASH_OUT';
  amount: number;
}

export type OrderStatus = 'NEW' | 'FILLED' | 'REJECTED' | 'CANCELLED';

type RejectionReason = 'INSUFFICIENT_FUNDS' | 'INSUFFICIENT_SHARES' | 'NO_MARKET_PRICE';

export interface Order {
  id: number;
  userId: number;
  instrumentId: number;
  ticker: string;
  side: string;
  type: string;
  size: number;
  price: number | null;
  status: OrderStatus;
  rejectionReason: RejectionReason | null;
  datetime: string;
}

/** What is written to the `orders` row besides the instrument, the size and the outcome. */
interface OrderHeader {
  userId: number;
  side: string;
  type: string;
}

/** An order and whether it was already stored by an earlier request with the same key. */
export interface Submission {
  order: Order;
  replayed: boolean;
}

/** What a request stores to be recognised when it is sent again (ADR 0004). */
interface Idempotency {
  key: string;
  requestHash: string;
}

const CASH_TYPE = 'MONEDA';

/** SHA-256, in hex, of the validated body as JSON with its keys sorted and absent fields omitted. */
function hashRequest(request: OrderRequest | TransferRequest): string {
  const canonical = JSON.stringify(request, Object.keys(request).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

interface StoredOrderRow {
  id: number;
  userid: number;
  instrumentid: number;
  ticker: string;
  side: string;
  type: string;
  size: number;
  price: string | null;
  status: OrderStatus;
  rejection_reason: RejectionReason | null;
  datetime: Date;
}

/** The columns of a stored order, for a query that names `orders` as `o` and `instruments` as `i`. */
const ORDER_COLUMNS = `o.id, o.userid, o.instrumentid, i.ticker, o.side, o.type, o.size, o.price, o.status,
                       o.rejection_reason, o.datetime AT TIME ZONE 'UTC' AS datetime`;

function toOrder(row: StoredOrderRow): Order {
  return {
    id: row.id,
    userId: row.userid,
    instrumentId: row.instrumentid,
    ticker: row.ticker,
    side: row.side,
    type: row.type,
    size: row.size,
    price: row.price === null ? null : fromCents(toCents(Number(row.price))),
    status: row.status,
    rejectionReason: row.rejection_reason,
    datetime: row.datetime.toISOString(),
  };
}

/** The per-user lock: ADR 0003. */
async function lockUser(client: ClientBase, userId: number): Promise<void> {
  const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (user.rowCount === 0) {
    throw new AppError(404, 'USER_NOT_FOUND', `User ${userId} does not exist`);
  }
}

/** The order this user already stored with this key, or `null`. Refuses a key reused for another request. */
async function findReplay(client: ClientBase, userId: number, idempotency: Idempotency): Promise<Order | null> {
  const found = await client.query<StoredOrderRow & { request_hash: string | null }>(
    `SELECT ${ORDER_COLUMNS}, o.request_hash
       FROM orders o
       JOIN instruments i ON i.id = o.instrumentid
      WHERE o.userid = $1 AND o.idempotency_key = $2`,
    [userId, idempotency.key],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.request_hash !== idempotency.requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different request');
  }
  return toOrder(row);
}

interface InstrumentRow {
  id: number;
  ticker: string;
  type: string;
}

async function findInstrument(client: ClientBase, request: OrderRequest): Promise<InstrumentRow> {
  const found =
    request.instrumentId !== undefined
      ? await client.query<InstrumentRow>('SELECT id, ticker, type FROM instruments WHERE id = $1', [
          request.instrumentId,
        ])
      : await client.query<InstrumentRow>(
          'SELECT id, ticker, type FROM instruments WHERE lower(ticker) = lower($1) ORDER BY id LIMIT 1',
          [request.ticker],
        );
  const instrument = found.rows[0];
  if (!instrument) {
    throw new AppError(404, 'INSTRUMENT_NOT_FOUND', 'The instrument does not exist');
  }
  if (instrument.type === CASH_TYPE) {
    throw new AppError(400, 'INVALID_INSTRUMENT', 'The cash instrument cannot be bought or sold; use a transfer');
  }
  return instrument;
}

/** The latest non-null close, in cents. `null` when there is none or it is not above zero. */
async function marketPriceCents(client: ClientBase, instrumentId: number): Promise<number | null> {
  const latest = await client.query<{ close: string }>(
    `SELECT close FROM marketdata
      WHERE instrumentid = $1 AND close IS NOT NULL
      ORDER BY date DESC, id DESC
      LIMIT 1`,
    [instrumentId],
  );
  const row = latest.rows[0];
  if (!row) return null;
  const closeCents = toCents(Number(row.close));
  return closeCents > 0 ? closeCents : null;
}

async function insertOrder(
  client: ClientBase,
  header: OrderHeader,
  instrument: InstrumentRow,
  size: number,
  priceCents: number | null,
  status: OrderStatus,
  rejectionReason: RejectionReason | null,
  idempotency: Idempotency | null,
): Promise<Order> {
  // The column has no zone, so UTC is written and read explicitly. The clock is read at the insert,
  // not at BEGIN, so the orders of one user are dated in the order they were decided.
  const inserted = await client.query<{ id: number; datetime: Date }>(
    `INSERT INTO orders (instrumentid, userid, side, size, price, type, status, rejection_reason,
                         idempotency_key, request_hash, datetime)
     VALUES ($1, $2, $3, $4, $5::numeric / 100, $6, $7, $8, $9, $10, clock_timestamp() AT TIME ZONE 'UTC')
     RETURNING id, datetime AT TIME ZONE 'UTC' AS datetime`,
    [
      instrument.id,
      header.userId,
      header.side,
      size,
      priceCents,
      header.type,
      status,
      rejectionReason,
      idempotency?.key ?? null,
      idempotency?.requestHash ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('The order insert returned no row');

  return {
    id: row.id,
    userId: header.userId,
    instrumentId: instrument.id,
    ticker: instrument.ticker,
    side: header.side,
    type: header.type,
    size,
    price: priceCents === null ? null : fromCents(priceCents),
    status,
    rejectionReason,
    datetime: row.datetime.toISOString(),
  };
}

export async function submitOrder(pool: Pool, request: OrderRequest, idempotencyKey?: string): Promise<Submission> {
  const idempotency = idempotencyKey === undefined ? null : { key: idempotencyKey, requestHash: hashRequest(request) };

  return transaction(pool, async (client) => {
    await lockUser(client, request.userId);

    // Inside the lock and before anything is evaluated: ADR 0004.
    if (idempotency) {
      const stored = await findReplay(client, request.userId, idempotency);
      if (stored) return { order: stored, replayed: true };
    }

    const instrument = await findInstrument(client, request);

    const priceCents =
      request.price !== undefined ? toCents(request.price) : await marketPriceCents(client, instrument.id);
    if (priceCents === null) {
      if (request.size === undefined) {
        throw new AppError(422, 'NO_PRICE_FOR_AMOUNT', `${instrument.ticker} has no market price to convert the amount`);
      }
      const rejected = await insertOrder(
        client,
        request,
        instrument,
        request.size,
        null,
        'REJECTED',
        'NO_MARKET_PRICE',
        idempotency,
      );
      return { order: rejected, replayed: false };
    }

    const size = request.size ?? sharesForAmount(toCents(request.amount ?? 0), priceCents);
    if (size === 0) {
      throw new AppError(422, 'AMOUNT_BELOW_ONE_SHARE', `The amount buys less than one share of ${instrument.ticker}`);
    }
    if (exceedsOrderValueCap(size, priceCents) || size > MAX_ORDER_SIZE) {
      throw new AppError(422, 'ORDER_VALUE_TOO_LARGE', 'The order is above the largest value one order can have');
    }
    const valueCents = size * priceCents;

    const state = await loadAccountState(client, request.userId);
    let rejectionReason: RejectionReason | null = null;
    if (request.side === 'BUY' && valueCents > availableCashCents(state)) {
      rejectionReason = 'INSUFFICIENT_FUNDS';
    } else if (request.side === 'SELL' && size > availableShares(state, instrument.id)) {
      rejectionReason = 'INSUFFICIENT_SHARES';
    }

    const status = rejectionReason ? 'REJECTED' : request.type === 'MARKET' ? 'FILLED' : 'NEW';
    const order = await insertOrder(client, request, instrument, size, priceCents, status, rejectionReason, idempotency);
    return { order, replayed: false };
  });
}

/** Deposits and withdrawals: orders on the cash instrument at a price of 1 (spec, section 4.6; ADR 0001). */
export async function submitTransfer(
  pool: Pool,
  request: TransferRequest,
  idempotencyKey?: string,
): Promise<Submission> {
  const idempotency = idempotencyKey === undefined ? null : { key: idempotencyKey, requestHash: hashRequest(request) };

  return transaction(pool, async (client) => {
    await lockUser(client, request.userId);

    if (idempotency) {
      const stored = await findReplay(client, request.userId, idempotency);
      if (stored) return { order: stored, replayed: true };
    }

    const found = await client.query<InstrumentRow>(
      'SELECT id, ticker, type FROM instruments WHERE type = $1 ORDER BY id LIMIT 1',
      [CASH_TYPE],
    );
    const cash = found.rows[0];
    if (!cash) throw new Error('There is no cash instrument');

    const state = await loadAccountState(client, request.userId);
    const rejectionReason =
      request.side === 'CASH_OUT' && toCents(request.amount) > availableCashCents(state) ? 'INSUFFICIENT_FUNDS' : null;

    const order = await insertOrder(
      client,
      { userId: request.userId, side: request.side, type: 'MARKET' },
      cash,
      request.amount,
      toCents(1),
      rejectionReason ? 'REJECTED' : 'FILLED',
      rejectionReason,
      idempotency,
    );
    return { order, replayed: false };
  });
}

/** One conditional statement, without the user lock: it can only release a reservation (ADR 0003). */
export async function cancelOrder(pool: Pool, orderId: number, userId: number): Promise<Order> {
  const cancelled = await pool.query<StoredOrderRow>(
    `UPDATE orders o SET status = 'CANCELLED'
       FROM instruments i
      WHERE i.id = o.instrumentid AND o.id = $1 AND o.userid = $2 AND o.status = 'NEW'
      RETURNING ${ORDER_COLUMNS}`,
    [orderId, userId],
  );
  const row = cancelled.rows[0];
  if (row) return toOrder(row);

  const existing = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND userid = $2', [orderId, userId]);
  if (existing.rowCount === 0) {
    throw new AppError(404, 'ORDER_NOT_FOUND', `Order ${orderId} does not exist`);
  }
  throw new AppError(409, 'ORDER_NOT_CANCELLABLE', 'Only an order that is NEW can be cancelled');
}

/** A user's orders, newest first (spec, section 4.5). */
export async function listOrders(
  pool: Pool,
  userId: number,
  status: OrderStatus | undefined,
  limit: number,
  offset: number,
): Promise<Order[]> {
  const found = await pool.query<StoredOrderRow>(
    `SELECT ${ORDER_COLUMNS}
       FROM orders o
       JOIN instruments i ON i.id = o.instrumentid
      WHERE o.userid = $1 AND ($2::text IS NULL OR o.status = $2)
      ORDER BY o.datetime DESC, o.id DESC
      LIMIT $3 OFFSET $4`,
    [userId, status ?? null, limit, offset],
  );
  return found.rows.map(toOrder);
}
