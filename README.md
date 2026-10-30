# Emperia month-end close agent

Balance sheet reconciliations for **Emperia Ltd** (GBP) and **Emperia VR Inc** (USD), straight from Xero. Built by RORA. Scope and design: [docs/SCOPING.md](docs/SCOPING.md).

This project serves Emperia only. It has its own Xero app, token file and registers, and refuses to run if any other organisation is on the Xero connection.

## Status: phase 1 (read and reconcile)

Read-only. Nothing is posted to Xero. Proposed journals are listed in the pack for review.

| Rule | Accounts | Supporting balance |
| --- | --- | --- |
| Bank | Every Xero bank account | Statement balance you enter, plus a list of unreconciled transactions |
| Aged ledgers | Accounts Receivable, Accounts Payable | Rebuilt as at month end from invoices, bills, credit notes and payments |
| Registers | Prepayments, accruals, deposits, DLA, CT, deferred and accrued income | The agent's own schedule, computed for the month (see `registers/`) |
| Intercompany | Ltd ↔ Inc | Inc's USD balance × month-end rate vs Ltd's GBP balance; FX journal proposed |
| Review | Everything else | Listed with balance, movement and what to check |

## Dashboard

```
npm start           # http://localhost:3000
```

Run the close for a month, enter bank statement balances and the month-end rate, open any account to see its register or aged list, explain differences, tick reviewed balances, approve or reject proposed journals, sign off each entity, and download the Excel pack. Every action is recorded in the activity log. Roles: admin, approver, preparer (the analyst), viewer. Deploying: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Commands

```
npm start           # the dashboard
npm run connect     # one-off: connect Xero (docs/SETUP.md)
npm run doctor      # check the connection and account names
npm run close -- --period 2026-10 [--usd-gbp 0.77] [--entity ltd|inc]
npm test            # engine tests, including a replay of September 2026
node scripts/demo-september.js   # sample packs from the Sep 2026 workbooks, no Xero needed
```

## Folders

- `registers/<entity>/` — opening schedules at 30 Sep 2026, seeded from the analyst's September workbooks. Copied into `data/registers/` on first run; from then on the `data/` copy is the live one (`_explanations.json` there holds confirmed explanations).
- `inputs/` — month-end FX rate and bank statement balances.
- `out/<period>/` — reconciliation packs (not committed).
- `data/` — the Xero token (never committed).
- `docs/` — scoping doc and the September workbooks for reference.

## Register items

| Field | Meaning |
| --- | --- |
| `method` | `static` (stays until changed), `straight_line` (by `monthlyRelease` from `start`, rest in the `end` month), `on_end_date` (all in the month of `end`) |
| `openingBalance` | Balance at the register's opening date (seeded items) |
| `bookedPeriod`, `amount` | For items added later: the month booked and the full amount |
| `closedPeriod` | Month the item drops out (accrual reversed, deposit refunded) |
| `expenseAccount` / `revenueAccount` | Where releases go in the proposed journal |
