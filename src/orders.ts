import type { ClientBase, Pool } from 'pg';
import { availableCashCents, availableShares, loadAccountState } from './accountState';
import { transaction } from './db';
import { AppError } from './errors';
import { exceedsOrderValueCap, fromCents, MAX_ORDER_SIZE, sharesForAmount, toCents } from './money';

/** Order submission (spec, section 4.3). What is stored and what is refused: ADR 0005. */

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
  status: 'NEW' | 'FILLED' | 'REJECTED';
  rejectionReason: RejectionReason | null;
  datetime: string;
}

const CASH_TYPE = 'MONEDA';

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
  request: OrderRequest,
  instrument: InstrumentRow,
  size: number,
  priceCents: number | null,
  status: Order['status'],
  rejectionReason: RejectionReason | null,
): Promise<Order> {
  // The column has no zone, so UTC is written and read explicitly. The clock is read at the insert,
  // not at BEGIN, so the orders of one user are dated in the order they were decided.
  const inserted = await client.query<{ id: number; datetime: Date }>(
    `INSERT INTO orders (instrumentid, userid, side, size, price, type, status, rejection_reason, datetime)
     VALUES ($1, $2, $3, $4, $5::numeric / 100, $6, $7, $8, clock_timestamp() AT TIME ZONE 'UTC')
     RETURNING id, datetime AT TIME ZONE 'UTC' AS datetime`,
    [instrument.id, request.userId, request.side, size, priceCents, request.type, status, rejectionReason],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('The order insert returned no row');

  return {
    id: row.id,
    userId: request.userId,
    instrumentId: instrument.id,
    ticker: instrument.ticker,
    side: request.side,
    type: request.type,
    size,
    price: priceCents === null ? null : fromCents(priceCents),
    status,
    rejectionReason,
    datetime: row.datetime.toISOString(),
  };
}

export async function submitOrder(pool: Pool, request: OrderRequest): Promise<Order> {
  return transaction(pool, async (client) => {
    // The per-user lock: ADR 0003.
    const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [request.userId]);
    if (user.rowCount === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', `User ${request.userId} does not exist`);
    }

    const instrument = await findInstrument(client, request);

    const priceCents =
      request.price !== undefined ? toCents(request.price) : await marketPriceCents(client, instrument.id);
    if (priceCents === null) {
      if (request.size === undefined) {
        throw new AppError(422, 'NO_PRICE_FOR_AMOUNT', `${instrument.ticker} has no market price to convert the amount`);
      }
      return insertOrder(client, request, instrument, request.size, null, 'REJECTED', 'NO_MARKET_PRICE');
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
    return insertOrder(client, request, instrument, size, priceCents, status, rejectionReason);
  });
}
