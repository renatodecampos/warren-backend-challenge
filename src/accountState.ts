import type { ClientBase } from 'pg';
import { multiplyExact, proportionRounded, toCents } from './money';

/**
 * The state of one account, rebuilt from its orders (spec, section 3; ADR 0001, 0002, 0007).
 * `replay` is pure: no I/O. The portfolio and every write share it. `loadAccountState`, at the
 * end, is the only I/O here: the two queries that feed it.
 */

export interface FilledOrder {
  instrumentId: number;
  side: 'BUY' | 'SELL' | 'CASH_IN' | 'CASH_OUT';
  size: number;
  priceCents: number;
}

export interface OpenOrder {
  instrumentId: number;
  side: 'BUY' | 'SELL';
  size: number;
  priceCents: number;
}

export interface Position {
  instrumentId: number;
  /** Net of FILLED sizes. Negative only when the history sold more than it bought. */
  quantity: number;
  /** Average-cost basis of the shares held. Zero while `quantity` is zero or negative. */
  costCents: number;
  /** Shares claimed by open LIMIT SELL orders. */
  reservedQuantity: number;
}

export interface AccountState {
  cashCents: number;
  /** Cash claimed by open LIMIT BUY orders, at their limit price. */
  reservedCashCents: number;
  positions: Map<number, Position>;
}

/**
 * @param filled the user's FILLED orders, ordered by `datetime`, then `id`
 * @param open   the user's NEW orders, in any order
 */
export function replay(filled: readonly FilledOrder[], open: readonly OpenOrder[]): AccountState {
  const state: AccountState = { cashCents: 0, reservedCashCents: 0, positions: new Map() };

  const positionOf = (instrumentId: number): Position => {
    let position = state.positions.get(instrumentId);
    if (!position) {
      position = { instrumentId, quantity: 0, costCents: 0, reservedQuantity: 0 };
      state.positions.set(instrumentId, position);
    }
    return position;
  };

  for (const order of filled) {
    const valueCents = multiplyExact(order.size, order.priceCents);

    switch (order.side) {
      case 'CASH_IN':
        state.cashCents += valueCents;
        break;

      case 'CASH_OUT':
        state.cashCents -= valueCents;
        break;

      case 'BUY': {
        const position = positionOf(order.instrumentId);
        const quantityAfter = position.quantity + order.size;
        // From a negative quantity, only the shares that end above zero are held, so only they carry cost.
        const sharesWithCost = position.quantity >= 0 ? order.size : Math.max(0, quantityAfter);
        state.cashCents -= valueCents;
        position.costCents += multiplyExact(sharesWithCost, order.priceCents);
        position.quantity = quantityAfter;
        break;
      }

      case 'SELL': {
        const position = positionOf(order.instrumentId);
        const sellsPartOfHolding = order.size < position.quantity;
        state.cashCents += valueCents;
        position.costCents = sellsPartOfHolding
          ? position.costCents - proportionRounded(position.costCents, order.size, position.quantity)
          : 0;
        position.quantity -= order.size;
        break;
      }
    }
  }

  for (const order of open) {
    if (order.side === 'BUY') {
      state.reservedCashCents += multiplyExact(order.size, order.priceCents);
    } else {
      positionOf(order.instrumentId).reservedQuantity += order.size;
    }
  }

  return state;
}

/** What a new BUY or a withdrawal is checked against. */
export function availableCashCents(state: AccountState): number {
  return state.cashCents - state.reservedCashCents;
}

/** What a new SELL is checked against. */
export function availableShares(state: AccountState, instrumentId: number): number {
  const position = state.positions.get(instrumentId);
  return position ? position.quantity - position.reservedQuantity : 0;
}

interface OrderRow {
  instrumentid: number;
  side: string;
  size: number;
  price: string;
}

/**
 * Reads the two inputs of `replay` for one user. The caller chooses the transaction: a read
 * snapshot for the portfolio, the per-user lock for a write (ADR 0003).
 */
export async function loadAccountState(client: ClientBase, userId: number): Promise<AccountState> {
  const filled = await client.query<OrderRow>(
    `SELECT instrumentid, side, size, price FROM orders
      WHERE userid = $1 AND status = 'FILLED'
      ORDER BY datetime, id`,
    [userId],
  );
  const open = await client.query<OrderRow>(
    `SELECT instrumentid, side, size, price FROM orders
      WHERE userid = $1 AND status = 'NEW'`,
    [userId],
  );

  const toOrder = <Side extends string>(row: OrderRow) => ({
    instrumentId: row.instrumentid,
    side: row.side as Side,
    size: row.size,
    priceCents: toCents(Number(row.price)),
  });

  return replay(
    filled.rows.map((row) => toOrder<FilledOrder['side']>(row)),
    open.rows.map((row) => toOrder<OpenOrder['side']>(row)),
  );
}
