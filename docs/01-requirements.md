# 01. Requirements

Source: the original brief, kept verbatim in [`00-challenge-brief.md`](00-challenge-brief.md). This document restates it as testable requirements, separates what the brief says from what it leaves open, and lists what is deliberately out of scope.

Reading order: this document, then [02 Design](02-design.md) (whiteboard, open questions, options), then the [ADRs](adr/README.md), then the [spec](03-spec.md), then the code and tests.

## 1. What is being built

A small trading API with three capabilities:

1. **Portfolio**: what a user owns and what it is worth.
2. **Asset search**: find instruments by ticker or name.
3. **Order submission**: buy or sell, MARKET or LIMIT, stored in `orders` with the right status.

Cash is modelled as an instrument (`ARS`, type `MONEDA`), and deposits and withdrawals as orders (`CASH_IN`, `CASH_OUT`).

## 2. Functional requirements

Each requirement has an id, so tests, ADRs and the code review can point back to it. "Brief" quotes or paraphrases the original text.

### Portfolio

| Id | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-P1 | Return the **total value** of the user's account | Equals cash plus the market value of all positions |
| FR-P2 | Return the **available balance** in pesos for trading | Cash balance (`FILLED` orders, FR-O9) minus the cash reserved by open LIMIT BUY orders ([ADR 0002](adr/0002-open-limit-orders-reserve-funds.md)). The cash balance and the reserved amount are returned next to it |
| FR-P3 | Return the list of assets owned: **number of shares**, **total monetary value ($)** and **total return (%)** | Values match a hand-computed example from the seed data |
| FR-P4 | Holdings and the cash balance are computed from the `orders` table using `size` and only `FILLED` orders | No balance is stored anywhere. `NEW` orders never move cash or shares; they only reduce what is available (FR-P2) |
| FR-P5 | Return the **daily return** from `close` and `previousClose` | `(close - previousClose) / previousClose` |
| FR-P6 | All prices are in pesos | No currency conversion exists |

### Asset search

| Id | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-S1 | Return instruments **similar to the query** | A partial ticker or name finds the instrument |
| FR-S2 | Support search by **ticker and/or name** | Querying by either field works |

### Orders

| Id | Requirement | Acceptance criterion |
| --- | --- | --- |
| FR-O1 | Submit a **BUY** or **SELL** (`side`) for an asset | Both are accepted and stored |
| FR-O2 | Support **MARKET** and **LIMIT** types | Both are accepted and stored |
| FR-O3 | MARKET orders need **no price**; they execute immediately at the latest `close` and are stored `FILLED` | Stored price equals the latest `close`; status `FILLED` |
| FR-O4 | LIMIT orders **require a price** and are stored `NEW` | LIMIT without price is refused; with price is `NEW` |
| FR-O5 | The user gives **either the exact number of shares or a total amount in pesos**. With an amount, compute the **maximum whole number of shares**; no fractional shares | `floor(amount / price)` shares are stored |
| FR-O6 | Statuses are `NEW`, `FILLED`, `REJECTED`, `CANCELLED` | No other value can be stored |
| FR-O7 | An order the market cannot accept is stored `REJECTED`: BUY without enough pesos, SELL without enough shares | Rejected order exists in `orders` with that status |
| FR-O8 | Only `NEW` orders can be cancelled | Cancelling any other status is refused |
| FR-O9 | Deposits and withdrawals are orders with side `CASH_IN` and `CASH_OUT` on the cash instrument | Balance changes by their `size` |
| FR-O10 | When an order is executed, the user's **positions are updated** | The portfolio reflects a `FILLED` order immediately |

### Non-functional and technical

| Id | Requirement |
| --- | --- |
| NFR-1 | Node.js, with a framework and data access strategy of my choice |
| NFR-2 | A **functional test for order submission** |
| NFR-3 | No user authentication |
| NFR-4 | Document assumptions and design decisions |
| NFR-5 | Any change to the provided database must be **justified in the documentation** |
| NFR-6 | Nice to have: a Postman, Insomnia or REST Client collection with examples |

## 3. Out of scope

Stated by the brief:

- Simulating the market ("There is NO need to simulate the market"). Nothing moves a LIMIT order from `NEW` to `FILLED`.
- User authentication.

Chosen by me, to keep the case focused:

- Fees, taxes and partial fills.
- Fractional shares and more than one currency.
- Real-time prices; the latest `close` is the only price used.
- A UI.

## 4. Where the brief is silent or ambiguous

These are the points where two reasonable engineers would build different things. I do not guess silently: each one is carried into [02 Design](02-design.md) as an open question with the assumption I work with, and the important ones become ADRs.

| Id | What the brief leaves open | Why it matters |
| --- | --- | --- |
| Q1 | Does an open LIMIT order **reserve** cash or shares? | Without it a user can place orders worth many times their balance |
| Q2 | What does the API return when the market **rejects** an order (HTTP status)? | Decides how a client tells success from failure |
| Q3 | How is **total return (%)** defined: against cost, and with which cost basis (average, FIFO)? | Different methods give different numbers after a partial sale |
| Q4 | The portfolio lists **total return**, but the functional notes ask for **daily return** too. Which goes where? | A field could be missing from the response |
| Q5 | What is the **total account value**: cash plus holdings, and does reserved cash count? | Changes the headline number |
| Q6 | What if `amount` buys **less than one share**? | There is no valid `size` to store |
| Q7 | Is **search** substring, prefix or fuzzy, and how are results ranked? | "Similar" is not defined |
| Q8 | What if an instrument has **no market price**? | A MARKET order cannot execute; a position cannot be valued |
| Q9 | **Concurrent orders** from the same user: what prevents overspending? | The brief does not mention it, and the check is a read followed by a write |
| Q10 | **Retries**: what if the client sends the same order twice? | A timeout followed by a retry can create two orders |
| Q11 | The seed data contains a user who **sold more than they bought**. Reject, fix or tolerate? | Positions can be negative |
| Q12 | Can `CASH_OUT` exceed the available balance, and are transfers whole pesos only? | `size` is an integer |
| Q13 | Expected **volume**, availability and security needs | Decides whether balances are computed or stored |

## 5. Deliverables

| Deliverable | Where |
| --- | --- |
| Requirements (this document) | `docs/01-requirements.md` |
| Design: whiteboard, open questions, options and trade-offs | `docs/02-design.md` |
| Decision records | `docs/adr/` |
| Spec: endpoint contracts, rules, tests and order of work | `docs/03-spec.md` |
| API, migrations and tests | `src/`, `db/`, `tests/` |
| Request collection and examples | `requests.http` (REST Client), `postman_collection.json` (Postman), and "Calling it" in the `README.md` |
| Code review of my own work | `docs/06-code-review.md` |
