# Pep Restaurant

A standalone restaurant POS for Frappe: table map, captain ordering, KOT and
kitchen display, guest QR ordering, split bills and payments, cash shifts,
recipes, and ingredient stock that moves when the kitchen cooks.

It started as a port of the F&B module in [Kamra PMS](../kamra-pms), with
every hotel dependency (Property, Room, Reservation, Folio) removed. It
installs on its own and can share a site with Kamra, because every doctype
carries a `Pep` prefix.

## Install

```bash
cd frappe-bench
bench get-app /path/to/pep_restaurant      # or: bench get-app <git url>
bench --site <site> install-app pep_restaurant
bench --site <site> execute pep_restaurant.demo.seed   # optional demo data
```

Open **/restaurant** on the site. The built SPA is committed under
`pep_restaurant/public/frontend`, so you don't need a node build to run it.

Works with Frappe v15 and v16 (tested on version-16, Python 3.14).

## Who does what

| Role | Can |
| --- | --- |
| Restaurant Captain | Floor: open bills, add rounds, send KOTs, split, move, merge, void with a reason, NC, reservations, kitchen screen |
| Restaurant Cashier | Everything a captain can, plus take payment, run cash shifts, see reports and stock |
| Kitchen Staff | Kitchen display, 86 dishes, see recipes and stock |
| Restaurant Manager | Everything: setup, menu, recipes, goods-in, stock takes, write-offs, QR sheets |

Each whitelisted endpoint enforces these roles with `@require_roles`. To
limit someone to one restaurant, add a User Permission on **Pep Restaurant**.
Set `"pep_strict_scope": 1` in site config if you want staff with no such
permission to see nothing at all.

## Screens (`/restaurant/...`)

- **till**: the floor. Tables show their live state (free, ordering, in
  kitchen, food ready, guest QR order, reserved, clearing). Also the menu,
  and a bill panel with course firing, discount, split, merge, move, NC,
  cancel, bill print, and single or split payment with change.
- **kitchen**: a dark kitchen display. Filter by station; tickets age from
  when each line was fired. It has Start, line-by-line Ready, Undo, and a
  loud cancelled line that stays until the chef taps Seen. A chime sounds on
  new tickets.
- **dishes**: menu admin, 86 or un-86 a dish, photo upload, CSV import.
- **recipes**: per-dish ingredients with food cost %, plus the ingredient list.
- **stock**: on-hand by outlet, goods-in, stock take (counts, not deltas),
  write-offs, ledger per ingredient, par levels, the dishes hit by out-of-stock
  items, and a wastage report.
- **cash**: open a shift with a float, paid-outs, safe drops, and a blind
  close with variance.
- **reports**: sales, tenders, hourly sales, best sellers, kitchen speed,
  NC, discounts, voids and cancellations.
- **qr**: printable table QR sheet. The codes are drawn in the browser.
- **settings**: appearance per device (Light, Dark or Match device), whether
  the kitchen screen stays dark, and the restaurant's accent colour (ten
  presets or any hex) with a live preview. The accent is saved on the
  restaurant, so every till and the guest QR menu use it. Status colours
  (in kitchen, ready, late, errors) keep their meaning whatever the accent.
- **setup**: restaurants (currency, tax label/split, tax-inclusive prices,
  PIN and shift rules) and outlets (tax %, service charge, auto KOT, QR
  ordering, tables).
- **menu/:outlet?table=T4**: the public guest menu.

## Kitchen stations

A station is a spot in the kitchen where a cook works one kind of food. Each
dish is cooked at one station, and each kitchen screen can show just one
station, so the grill cook only sees grill work.

- Edit the list per restaurant in **Setup → Edit → Kitchen stations**, one per
  line (defaults: Kitchen, Tandoor, Grill, Fryer, Bar, Cold). Rename or add
  freely (Pizza Oven, Wok, Pastry). A station that still has dishes can't be
  removed until they move.
- Assign each dish in **Menu → dish → Station**, or with the `prep_station`
  column in a CSV import.
- Put a tablet at each station, open `/restaurant/kitchen`, and tap that
  station's chip. The choice is remembered on that device. The pass or
  expediter screen stays on **All**.
- The KOT slip prints every line with its station in brackets.

## Menu import

**Menu → Import CSV** offers a template download (with example rows that use
your own stations) and a download of the current menu, so you can edit it in
Excel or Google Sheets and re-import it. Files saved by Excel (UTF-8 with BOM,
or semicolon-separated) are accepted. Rows that fail are reported by line
number; the rest still import.

## Accounting (ERPNext, optional)

On a site with ERPNext, paid bills can post to your books as Sales Invoices.
Without ERPNext nothing changes: bills, payments and shifts stay in Pep Order,
Pep Cashier Transaction and Pep Cashier Session.

Set it up in **Settings → Accounting (ERPNext)** (managers):

1. Pick the company, then **Fill in suggested settings**. This creates a
   "Walk-in Customer" and a non-stock "Restaurant Sales" item if they're missing,
   and suggests the income account, cost center, a tax account per tax line
   (matched by name: VAT → "VAT - ABC"), and modes of payment that have an
   account for the company.
2. Check every mapping, choose **One invoice per shift** or **One invoice per
   bill**, tick **Post sales to ERPNext**, and save. Saving refuses anything
   that would fail later: wrong company, a non-income account for income, or a
   mode of payment with no account.

What gets posted:

- A paid, POS-style Sales Invoice (`is_pos`) to the walk-in customer. The
  payment rows are the actual tenders (cash, mobile money and so on), so the
  sale, the tax and the money received are booked in one document, with nothing
  left outstanding.
- Food and drink revenue goes to the income account, after discounts and
  excluding tax. You can post it as one "Restaurant Sales" line, or each dish as
  its own non-stock Item (`PEP-MI-…`) so ERPNext sales reports show dishes.
- Service charge goes to its own account. Each tax line (VAT, NHIL, CGST…) is an
  "Actual" charge for the exact amount the till charged, including when menu
  prices include tax. The invoice total equals what the till collected, to the
  cent.
- **Per shift**: posted when the cashier closes the shift. Bills paid without a
  shift are posted per day, once the day is over. **Per bill**: posted right
  after payment.
- Never posted: NC (complimentary) bills, cancelled bills, and bills paid before
  "Post bills paid from".

Posting runs in a background job (the `short` queue), so the till never waits on
ERPNext. A failure is recorded on the bill or shift (Accounting section in
Desk) with the reason, shown under **Didn't post** in Settings, and retried by
the daily job or the **Post waiting bills now** button. Posting the same bill or
shift twice returns the existing invoice and never duplicates it.

## Rules carried over from Kamra

- **Prices come from the menu.** Order lines are always re-priced server-side
  (`pos._load_items`). The browser, including the public QR endpoint, only
  sends a quantity and instructions.
- **QR orders wait for a captain.** A guest order lands as `Placed` and
  can't fire to the kitchen until a captain confirms it.
- **A bill closes only when settled.** It must be paid, NC with whoever
  authorized it, or fully voided (`Pep Order.guard_bill_close`).
- **Voids are struck-through lines with a reason.** Nothing is deleted
  once it has been sent to the kitchen.
- **Stock leaves when the KOT fires.** It is not returned on void, cancel or
  recall. `stock_posted` on each line means a split bill can't deduct twice.
  A short count never blocks service; the balance goes negative and the
  screen asks for a recount. Nothing is ever auto-86'd.
- **Cash belongs to a shift.** Each tender is recorded against the
  cashier's open shift, and closing the shift needs a note when the count
  doesn't match.

## Money

The order controller computes totals in one place:

```
subtotal - discount = net
service charge      = net × outlet service %
tax                 = (net + service) × tax %   (or backed out if prices include tax)
grand total         = net + service + tax
```

Tax and service rates are snapshotted when a bill opens. The bill prints the
tax split the restaurant defines (`CGST:50 / SGST:50`, or a single VAT line).

## Develop

```bash
cd frontend
npm install
PEP_SITE=<site> npm run dev        # Vite on :5174, proxies /api to :8000
npm run build                      # writes pep_restaurant/public/frontend (commit it)
```

Tests:

```bash
bench --site <site> set-config allow_tests true
bench --site <site> run-tests --app pep_restaurant
```

## API

Each module's functions are POST endpoints at
`/api/method/pep_restaurant.<module>.<fn>`:

- `pos`: orders, tables, kitchen, payment, reservations, dashboard
- `menu`: dishes, availability, CSV import
- `inventory`: recipes, ingredients, stock moves and reports
- `cashier`: shifts, paid-outs, drops
- `api`: boot, setup
- `authz`: PINs
- `public_api`: guest QR menu and order

## License

AGPL-3.0. This app is derived from Kamra PMS, which is AGPL-3.0.
