# warren-challenge-backend

**Summary:**
Develop an API that provides the following information through endpoints:
- **Portfolio**: The response must return the total value of a user's account, their available balance in pesos for trading, and the list of assets they own (including the number of shares, the position's total monetary value ($), and total return (%)).
- **Asset search**: The response must return a list of assets in the market that are similar to the search query (searches by ticker and/or name must be supported).
- **Submit an order to the market**: This endpoint must allow buy and sell orders to be submitted for an asset. It must support two order types: MARKET and LIMIT. MARKET orders do not require a price because they are executed against market offers. In contrast, limit orders require the price at which the user wants to execute the order. The order must be stored in the `orders` table with the corresponding status and values.

**Optional / Nice to have:**
- Provide a Postman, Insomnia, or REST Client collection for the API, along with examples of how to call it.

# Functional considerations
- Asset prices must be in pesos.
- There is NO need to simulate the market.
- When users submit an order, they must provide the number of shares they want to buy or sell. Allow users to enter either the exact number of shares or a total investment amount in pesos (in the latter case, calculate the maximum number of shares they can submit; fractional shares are not allowed).
- Orders have an attribute called `side`, which indicates whether the order is a buy (`BUY`) or a sell (`SELL`).
- Orders can have different statuses:
    - `NEW` - when a limit order is submitted to the market, it is assigned this status.
    - `FILLED` - when an order is executed. Market orders are executed immediately upon submission.
    - `REJECTED` - when an order is rejected by the market because it does not meet the requirements, for example, when an order is submitted for an amount greater than the available balance.
    - `CANCELLED` - when the order is cancelled by the user.
- When users submit a MARKET order, it is executed immediately and its status is `FILLED`.
- When users submit a LIMIT order, its status must be `NEW`.
- Only orders with a `NEW` status can be cancelled.
- If an order is submitted for an amount greater than the available balance, it must be rejected and stored with a REJECTED status. For buy orders, validate that the user has sufficient funds in pesos; for sell orders, validate that the user has sufficient shares.
- Incoming and outgoing transfers can be modeled as orders. Incoming transfers have a `CASH_IN` side, while outgoing transfers have a `CASH_OUT` side.
- When an order is executed, the user's list of positions must be updated.
- To calculate holdings and the available balance in pesos, use all relevant transactions in the `orders` table, based on the `size` column.
- Cash (ARS) is modeled as an instrument of type 'MONEDA'.
- The `marketdata` table contains instrument prices for the last two days. `close` is each asset's latest price. Use the `close` and `previousClose` columns to calculate the daily return.
- When a `MARKET` order is submitted, use the latest price (`close`).
- To calculate the market value, return, and number of shares for each position, use the orders with a `FILLED` status for each asset.

# Technical considerations
- **For the REST API**
- Develop the application using Node.js.
  - Use a framework of your choice for the REST API, such as Express or NestJS.
  - Choose a data access strategy or library. You may use an ORM or execute queries directly.
  - Use any library or framework you consider appropriate.
- Implement a functional test for the order submission function.
- User authentication does NOT need to be implemented.
- Document any assumptions or design decisions you consider relevant.

# Database
For reference, we have already created a database with the following tables and some data (`database.sql` file):
- **users**: id, email, accountNumber
- **instruments**: id, ticker, name, type
- **orders**: id, instrumentId, userId, side, size, price, type, status, datetime
- **marketdata**: id, instrumentId, high, low, open, close, previousClose, datetime

The provided database is a functional model that works as-is, although it is a basic implementation. Candidates are free to modify, add, or adjust tables as they deem necessary to improve code performance, optimize queries, or for any other relevant technical reason. Any such changes must be properly justified in the documentation.
