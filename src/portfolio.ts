import type { Pool } from 'pg';
import { loadAccountState } from './accountState';
import { readSnapshot } from './db';
import { AppError } from './errors';
import { fromCents, multiplyExact, proportionRounded, toCents } from './money';

/** The portfolio of one user (spec, section 4.1; returns defined in ADR 0007). */

export interface PortfolioPosition {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  averageCost: number;
  marketPrice: number | null;
  marketValue: number;
  totalReturnPercent: number | null;
  dailyReturnPercent: number | null;
  priceAvailable: boolean;
}

export interface Portfolio {
  userId: number;
  accountNumber: string;
  currency: string;
  totalAccountValue: number;
  cashBalance: number;
  reservedCash: number;
  availableBalance: number;
  positions: PortfolioPosition[];
}

const CURRENCY = 'ARS';

/**
 * `(value - base) / base x 100` with two decimals, computed in integers. `null` when there is no
 * base to measure against.
 */
function percentChange(value: number, base: number): number | null {
  if (base <= 0) return null;
  const difference = value - base;
  const hundredths = proportionRounded(Math.abs(difference), 10_000, base);
  return (difference < 0 ? -hundredths : hundredths) / 100;
}

interface InstrumentRow {
  id: number;
  ticker: string;
  name: string;
  close: string | null;
  previousclose: string | null;
}

export async function getPortfolio(pool: Pool, userId: number): Promise<Portfolio> {
  return readSnapshot(pool, async (client) => {
    const user = await client.query<{ accountnumber: string }>('SELECT accountnumber FROM users WHERE id = $1', [
      userId,
    ]);
    const account = user.rows[0];
    if (!account) throw new AppError(404, 'USER_NOT_FOUND', `User ${userId} does not exist`);

    const state = await loadAccountState(client, userId);
    const held = [...state.positions.values()].filter((position) => position.quantity > 0);

    // The latest row with a close, per instrument held. No row: the instrument has no market price.
    const instruments = await client.query<InstrumentRow>(
      `SELECT i.id, i.ticker, i.name, m.close, m.previousclose
         FROM instruments i
         LEFT JOIN LATERAL (
           SELECT close, previousclose FROM marketdata
            WHERE instrumentid = i.id AND close IS NOT NULL
            ORDER BY date DESC, id DESC
            LIMIT 1
         ) m ON true
        WHERE i.id = ANY($1::int[])`,
      [held.map((position) => position.instrumentId)],
    );
    const instrumentById = new Map(instruments.rows.map((row) => [row.id, row]));

    let positionsValueCents = 0;
    const valued = held.map((position) => {
      const instrument = instrumentById.get(position.instrumentId);
      if (!instrument) throw new Error(`Instrument ${position.instrumentId} of a position was not found`);

      // A close of zero or below is no price, the same as a missing row (spec, section 4.1).
      const rawCloseCents = instrument.close === null ? null : toCents(Number(instrument.close));
      const closeCents = rawCloseCents !== null && rawCloseCents > 0 ? rawCloseCents : null;
      const previousCloseCents =
        instrument.previousclose === null ? null : toCents(Number(instrument.previousclose));
      const marketValueCents =
        closeCents === null ? position.costCents : multiplyExact(position.quantity, closeCents);
      positionsValueCents += marketValueCents;

      const row: PortfolioPosition = {
        instrumentId: position.instrumentId,
        ticker: instrument.ticker,
        name: instrument.name,
        quantity: position.quantity,
        averageCost: fromCents(proportionRounded(position.costCents, 1, position.quantity)),
        marketPrice: closeCents === null ? null : fromCents(closeCents),
        marketValue: fromCents(marketValueCents),
        totalReturnPercent: closeCents === null ? null : percentChange(marketValueCents, position.costCents),
        dailyReturnPercent:
          closeCents === null || previousCloseCents === null ? null : percentChange(closeCents, previousCloseCents),
        priceAvailable: closeCents !== null,
      };
      return { row, marketValueCents };
    });
    valued.sort((a, b) => b.marketValueCents - a.marketValueCents);

    return {
      userId,
      accountNumber: account.accountnumber,
      currency: CURRENCY,
      totalAccountValue: fromCents(state.cashCents + positionsValueCents),
      cashBalance: fromCents(state.cashCents),
      reservedCash: fromCents(state.reservedCashCents),
      availableBalance: fromCents(state.cashCents - state.reservedCashCents),
      positions: valued.map((entry) => entry.row),
    };
  });
}
