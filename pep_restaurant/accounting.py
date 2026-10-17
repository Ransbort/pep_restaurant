"""Post restaurant sales to ERPNext as Sales Invoices.

Optional: does nothing unless ERPNext is installed on the site AND the
restaurant's Restaurant Accounting Settings are enabled. The app's own records
(Restaurant Order, Restaurant Cashier Transaction, Restaurant Cashier Session) stay the source of
truth; ERPNext gets a faithful summary for the books.

Two posting modes:
  Per shift  one Sales Invoice when a cashier closes a shift, covering
             every bill paid in it (like ERPNext's POS Closing Entry).
             Bills paid without a shift (Administrator, or a restaurant
             that doesn't require shifts) are posted once their day is over.
  Per bill   one Sales Invoice for every paid bill.

Each invoice is a paid POS-style Sales Invoice (is_pos = 1) whose payment
rows are the tenders actually taken, so ERPNext books the sale, the tax and
the cash/card receipt in one document. NC (complimentary) bills, cancelled
bills and bills paid before the settings' start date are never posted.

Money is reproduced exactly: line revenue, service charge and each tax
line are taken from the till's own figures (taxes as "Actual" charges), so the
invoice's grand total equals what the till collected, to the cent, whether
menu prices include tax or not.

Posting never blocks service. It runs in the background after the payment
or shift close commits (the job's own transaction commits at the end); a
failure rolls back only the invoice attempt, is recorded on the bill/shift
(erp_status "Failed" with the reason) and is retried by the daily sweep or
the Post now button in Settings.
"""

import json

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, get_datetime, getdate, nowdate

from pep_restaurant.authz import require_roles

SETTINGS = "Restaurant Accounting Settings"


def erpnext_installed() -> bool:
	return "erpnext" in frappe.get_installed_apps()


def settings_for(restaurant: str):
	"""Enabled settings for a restaurant, or None."""
	if not erpnext_installed() or not frappe.db.exists(SETTINGS, restaurant):
		return None
	s = frappe.get_cached_doc(SETTINGS, restaurant)
	return s if s.enabled else None


# ------------------------------------------------------------- triggers


def on_bill_paid(order: str, restaurant: str):
	"""Called by pos.pay_order. Per-bill mode posts this bill in the
	background; per-shift mode just marks it Pending for the shift close."""
	s = settings_for(restaurant)
	if not s or not _in_scope(s, frappe.db.get_value("Restaurant Order", order, "paid_at")):
		return
	frappe.db.set_value("Restaurant Order", order, {"erp_status": "Pending", "erp_error": None}, update_modified=False)
	if s.posting_mode == "Per bill":
		frappe.enqueue("pep_restaurant.accounting.post_bill", order=order, queue="short",
		               enqueue_after_commit=True, job_id=f"pep-post-{order}", deduplicate=True)


def on_shift_closed(session: str, restaurant: str):
	s = settings_for(restaurant)
	if not s or s.posting_mode != "Per shift":
		return
	frappe.db.set_value("Restaurant Cashier Session", session, {"erp_status": "Pending", "erp_error": None},
	                    update_modified=False)
	frappe.enqueue("pep_restaurant.accounting.post_shift", session=session, queue="short",
	               enqueue_after_commit=True, job_id=f"pep-post-{session}", deduplicate=True)


def _in_scope(s, paid_at) -> bool:
	return bool(paid_at) and (not s.start_from or getdate(paid_at) >= getdate(s.start_from))


# ------------------------------------------------------------- posting


def post_bill(order: str) -> str | None:
	doc = frappe.get_doc("Restaurant Order", order)
	s = settings_for(doc.restaurant)
	if not s:
		return None
	if not _postable(doc, s):
		frappe.db.set_value("Restaurant Order", order, "erp_status", "Skipped", update_modified=False)
		return None
	if doc.erp_status == "Posted" and doc.erp_invoice:
		return doc.erp_invoice
	return _post(s, [doc], posting_date=getdate(doc.paid_at),
	             remarks=f"Restaurant bill {doc.name} ({_label(doc)})")


def post_shift(session: str) -> str | None:
	sess = frappe.get_doc("Restaurant Cashier Session", session)
	s = settings_for(sess.restaurant)
	if not s:
		return None
	if sess.erp_status == "Posted" and sess.erp_invoice:
		return sess.erp_invoice
	orders = [frappe.get_doc("Restaurant Order", n) for n in frappe.get_all(
		"Restaurant Order", filters={"session": session, "paid": 1}, pluck="name", order_by="paid_at asc")]
	orders = [o for o in orders if _postable(o, s) and o.erp_status != "Posted"]
	if not orders:
		frappe.db.set_value("Restaurant Cashier Session", session, {"erp_status": "Skipped", "erp_error": None},
		                    update_modified=False)
		return None
	when = getdate(sess.closed_at or sess.opened_at)
	return _post(s, orders, posting_date=when, session=sess,
	             remarks=f"Restaurant shift {sess.name} - {sess.user} - {len(orders)} bill(s)")


def post_day(restaurant: str, day) -> str | None:
	"""Bills paid without a shift, one invoice per day (per-shift mode)."""
	s = settings_for(restaurant)
	if not s:
		return None
	day = getdate(day)
	names = frappe.get_all("Restaurant Order", filters={
		"restaurant": restaurant, "paid": 1, "session": ("is", "not set"),
		"paid_at": ("between", [f"{day} 00:00:00", f"{day} 23:59:59"]),
		"erp_status": ("!=", "Posted")}, pluck="name", order_by="paid_at asc")
	orders = [o for o in (frappe.get_doc("Restaurant Order", n) for n in names) if _postable(o, s)]
	if not orders:
		return None
	return _post(s, orders, posting_date=day, remarks=f"Restaurant sales without a shift, {day}")


def _postable(o, s) -> bool:
	return bool(o.paid and o.status == "Closed" and not o.nc and flt(o.grand_total) > 0
	            and _in_scope(s, o.paid_at))


def _label(o) -> str:
	return f"Table {o.table_no}" if o.table_no else o.order_type


def _post(s, orders, posting_date, remarks: str, session=None) -> str | None:
	"""Build, insert and submit one Sales Invoice for these bills, then stamp
	them. Any failure is recorded on the bills (and shift) and swallowed -
	the background job must not crash-loop, and the till never waits on it."""
	names = [o.name for o in orders]
	# roll back only this attempt (a half-made invoice, auto-created items) -
	# never the caller's transaction
	frappe.db.savepoint("pep_post")
	try:
		si = build_invoice(s, orders, posting_date, remarks)
		si.insert(ignore_permissions=True)
		si.submit()
	except Exception as e:
		frappe.db.rollback(save_point="pep_post")
		msg = _clean(e)
		for n in names:
			frappe.db.set_value("Restaurant Order", n, {"erp_status": "Failed", "erp_error": msg}, update_modified=False)
		if session:
			frappe.db.set_value("Restaurant Cashier Session", session.name, {"erp_status": "Failed", "erp_error": msg},
			                    update_modified=False)
		frappe.log_error(title=f"Restaurant: posting {names[0]}{' +' if len(names) > 1 else ''} failed")
		return None
	for n in names:
		frappe.db.set_value("Restaurant Order", n, {"erp_status": "Posted", "erp_invoice": si.name, "erp_error": None},
		                    update_modified=False)
	if session:
		frappe.db.set_value("Restaurant Cashier Session", session.name,
		                    {"erp_status": "Posted", "erp_invoice": si.name, "erp_error": None},
		                    update_modified=False)
	return si.name


def _clean(e: Exception) -> str:
	import re

	msg = re.sub(r"<[^>]+>", "", str(e)).strip() or e.__class__.__name__
	return msg[:500]


# --------------------------------------------------------- the invoice


def _split(total: float, weights: list[float]) -> list[float]:
	"""Split a 2-decimal amount by weights so the parts add up exactly."""
	total = flt(total, 2)
	w = sum(weights)
	if not weights:
		return []
	if not w:
		return [total] + [0.0] * (len(weights) - 1)
	parts = [flt(total * x / w, 2) for x in weights]
	parts[parts.index(max(parts))] = flt(parts[parts.index(max(parts))] + total - sum(parts), 2)
	return parts


def order_breakdown(o) -> dict:
	"""What one bill is worth to the books, from the till's own figures:
	revenue per line (after discount, before tax), service charge before
	tax, and tax per tax line. revenue + service + tax == grand_total."""
	from pep_restaurant.restaurant.doctype.restaurant.restaurant import parse_tax_split

	grand, tax = flt(o.grand_total, 2), flt(o.tax_amount, 2)
	net, sc = flt(o.order_total), flt(o.service_charge)
	ex_tax = flt(grand - tax, 2)  # what's left once tax is out: food + service
	service = flt(ex_tax * sc / (net + sc), 2) if (net + sc) and sc else 0.0
	food = flt(ex_tax - service, 2)
	live = [it for it in o.items if not it.voided and flt(it.amount)]
	lines = list(zip(live, _split(food, [flt(it.amount) for it in live]), strict=True))
	rest = frappe.get_cached_doc("Restaurant", o.restaurant)
	split = parse_tax_split(rest.tax_split) or [(rest.tax_label or "Tax", 1.0)]
	taxes = dict(zip([lbl for lbl, _s in split], _split(tax, [sh for _l, sh in split]), strict=True))
	tenders = json.loads(o.payments_json or "[]") or [{"mode": o.payment_mode, "amount": grand}]
	return {"lines": lines, "service": service, "taxes": taxes, "tenders": tenders, "grand": grand}


def _dish_item(s, menu_item: str) -> str:
	"""The non-stock ERPNext Item for a dish, created on first sale."""
	code = f"PEP-{menu_item}"
	if frappe.db.exists("Item", code):
		return code
	mi = frappe.db.get_value("Restaurant Menu Item", menu_item, ["item_name", "description"], as_dict=True) or {}
	group = s.item_group or "Restaurant"
	if not frappe.db.exists("Item Group", group):
		root = frappe.db.get_value("Item Group", {"is_group": 1, "parent_item_group": ("in", ["", None])}, "name") \
			or "All Item Groups"
		frappe.get_doc({"doctype": "Item Group", "item_group_name": group, "parent_item_group": root,
		                "is_group": 0}).insert(ignore_permissions=True)
	frappe.get_doc({
		"doctype": "Item", "item_code": code, "item_name": (mi.get("item_name") or menu_item)[:140],
		"item_group": group, "stock_uom": "Nos", "is_stock_item": 0, "include_item_in_manufacturing": 0,
		"description": mi.get("description") or mi.get("item_name") or menu_item,
	}).insert(ignore_permissions=True)
	return code


def build_invoice(s, orders, posting_date, remarks: str):
	"""An unsaved, paid Sales Invoice summarising these bills."""
	validate_settings(s)
	company_currency = frappe.get_cached_value("Company", s.company, "default_currency")
	currency = frappe.db.get_value("Restaurant", s.restaurant, "currency")
	if currency != company_currency:
		frappe.throw(_("The restaurant bills in {0} but {1}'s currency is {2}.").format(
			currency, s.company, company_currency))

	per_dish = s.item_mode == "One item per dish"
	lines: dict[str, dict] = {}
	service = 0.0
	taxes: dict[str, float] = {}
	tenders: dict[str, float] = {}
	grand = 0.0
	for o in orders:
		b = order_breakdown(o)
		grand += b["grand"]
		service += b["service"]
		for lbl, amt in b["taxes"].items():
			taxes[lbl] = taxes.get(lbl, 0.0) + amt
		for t in b["tenders"]:
			tenders[t["mode"]] = tenders.get(t["mode"], 0.0) + flt(t["amount"])
		for it, amt in b["lines"]:
			key = it.menu_item if per_dish else "_all"
			row = lines.setdefault(key, {"qty": 0.0, "amount": 0.0, "name": it.item_name})
			row["qty"] += flt(it.qty)
			row["amount"] += amt

	si = frappe.new_doc("Sales Invoice")
	si.flags.ignore_pos_profile = True  # payments below are the real tenders
	si.update({
		"company": s.company, "customer": s.customer, "currency": company_currency, "conversion_rate": 1,
		"posting_date": posting_date, "set_posting_time": 1, "due_date": posting_date, "is_pos": 1,
		"update_stock": 0, "disable_rounded_total": 1, "remarks": remarks[:1000], "ignore_pricing_rule": 1,
	})
	if si.meta.has_field("selling_price_list"):
		si.selling_price_list = None
	for key, row in lines.items():
		amount = flt(row["amount"], 2)
		qty = flt(row["qty"])
		item_code = _dish_item(s, key) if per_dish else s.sales_item
		desc = row["name"] if per_dish else f"Food & beverage sales ({len(orders)} bill(s))"
		line = {"item_code": item_code, "income_account": s.income_account, "cost_center": s.cost_center,
		        "conversion_factor": 1, "uom": "Nos"}
		if not per_dish or not qty or qty != int(qty):
			parts = [(1, amount)]
		else:
			rate = flt(amount / qty, 2)
			if flt(rate * qty, 2) == amount:
				parts = [(qty, rate)]
			else:
				# a price that doesn't come out to whole cents (tax-inclusive
				# menus): n-1 at the rounded price, 1 carrying the remainder, so
				# the quantity stays true and the total stays exact
				parts = [(qty - 1, rate), (1, flt(amount - rate * (qty - 1), 2))]
		for q, r in parts:
			si.append("items", {**line, "description": desc, "qty": q, "rate": r, "price_list_rate": r})
	if flt(service, 2):
		si.append("taxes", {
			"charge_type": "Actual", "account_head": s.service_charge_account or s.income_account,
			"description": "Service charge", "tax_amount": flt(service, 2), "cost_center": s.cost_center,
		})
	tax_map = {r.tax_label.strip().lower(): r.account for r in s.tax_accounts}
	for lbl, amt in taxes.items():
		if not flt(amt, 2):
			continue
		account = tax_map.get(lbl.strip().lower()) or s.default_tax_account
		if not account:
			frappe.throw(_("No ERPNext account is set for the tax line {0}.").format(lbl))
		si.append("taxes", {"charge_type": "Actual", "account_head": account, "description": lbl,
		                    "tax_amount": flt(amt, 2), "cost_center": s.cost_center})
	mop_map = {r.pep_mode: r.mode_of_payment for r in s.payment_modes}
	for mode, amt in tenders.items():
		mop = mop_map.get(mode)
		if not mop:
			frappe.throw(_("Map the payment mode {0} to an ERPNext Mode of Payment in Settings.").format(mode))
		account = mop_account(mop, s.company)
		if not account:
			frappe.throw(_("Mode of Payment {0} has no account for {1}.").format(mop, s.company))
		si.append("payments", {"mode_of_payment": mop, "account": account, "amount": flt(amt, 2),
		                       "base_amount": flt(amt, 2)})
	si.flags.pep_expected_total = flt(grand, 2)
	si.run_method("set_missing_values")
	si.calculate_taxes_and_totals()
	if abs(flt(si.grand_total, 2) - flt(grand, 2)) > 0.005:
		frappe.throw(_("Invoice total {0} doesn't match the bills' total {1}.").format(si.grand_total, flt(grand, 2)))
	return si


# ------------------------------------------------------------- settings


def mop_account(mode_of_payment: str, company: str) -> str | None:
	"""The account a Mode of Payment pays into for this company, or None.
	(ERPNext's get_bank_cash_account throws instead of returning nothing.)"""
	return frappe.db.get_value("Mode of Payment Account", {"parent": mode_of_payment, "company": company},
	                           "default_account")


def _need(value, label):
	if not value:
		frappe.throw(_("Set the {0} in Settings → Accounting.").format(label))


def _check_account(account, company, label, root_types=None):
	if not account:
		return
	a = frappe.db.get_value("Account", account, ["company", "is_group", "root_type", "disabled"], as_dict=True)
	if not a:
		frappe.throw(_("{0}: account {1} doesn't exist.").format(label, account))
	if a.company != company:
		frappe.throw(_("{0}: {1} belongs to {2}, not {3}.").format(label, account, a.company, company))
	if a.is_group or a.disabled:
		frappe.throw(_("{0}: {1} is a group or disabled account - pick a ledger.").format(label, account))
	if root_types and a.root_type not in root_types:
		frappe.throw(_("{0}: {1} is a {2} account; expected {3}.").format(label, account, a.root_type,
		                                                                  " or ".join(root_types)))


def validate_settings(s):
	if not erpnext_installed():
		frappe.throw(_("ERPNext isn't installed on this site."))
	_need(s.company, "company")
	if not frappe.db.exists("Company", s.company):
		frappe.throw(_("Company {0} doesn't exist.").format(s.company))
	_need(s.customer, "walk-in customer")
	if not frappe.db.exists("Customer", s.customer):
		frappe.throw(_("Customer {0} doesn't exist.").format(s.customer))
	_need(s.income_account, "income account")
	_check_account(s.income_account, s.company, "Income account", ["Income"])
	_check_account(s.service_charge_account, s.company, "Service charge account", ["Income", "Liability"])
	_check_account(s.default_tax_account, s.company, "Tax account", ["Liability", "Expense", "Asset"])
	for r in s.tax_accounts:
		_check_account(r.account, s.company, f"Tax account for {r.tax_label}", ["Liability", "Expense", "Asset"])
	_need(s.cost_center, "cost center")
	cc = frappe.db.get_value("Cost Center", s.cost_center, ["company", "is_group"], as_dict=True)
	if not cc or cc.company != s.company or cc.is_group:
		frappe.throw(_("Cost center {0} must be a non-group cost center of {1}.").format(s.cost_center, s.company))
	if s.item_mode == "Single item":
		_need(s.sales_item, "item for single-item mode")
		if frappe.db.get_value("Item", s.sales_item, "is_stock_item") != 0:
			frappe.throw(_("{0} must be an existing non-stock Item.").format(s.sales_item))
	for r in s.payment_modes:
		if not frappe.db.exists("Mode of Payment", r.mode_of_payment):
			frappe.throw(_("Mode of Payment {0} doesn't exist.").format(r.mode_of_payment))
		if not mop_account(r.mode_of_payment, s.company):
			frappe.throw(_("Mode of Payment {0} has no default account for {1}. Set one on the Mode of Payment.")
			             .format(r.mode_of_payment, s.company))


# --------------------------------------------------------- sweep / UI


def sweep():
	"""Daily (and on demand): post anything still pending or failed."""
	if not erpnext_installed():
		return {}
	out = {}
	for name in frappe.get_all(SETTINGS, filters={"enabled": 1}, pluck="name"):
		out[name] = post_pending(name, include_today=False)
	return out


def post_pending(restaurant: str, include_today: bool = True) -> dict:
	s = settings_for(restaurant)
	if not s:
		return {"posted": [], "failed": 0}
	posted, failed = [], 0
	base = {"restaurant": restaurant, "paid": 1, "status": "Closed", "nc": 0,
	        "erp_status": ("in", ["", None, "Pending", "Failed"])}
	if s.start_from:
		base["paid_at"] = (">=", f"{s.start_from} 00:00:00")
	if s.posting_mode == "Per bill":
		for n in frappe.get_all("Restaurant Order", filters=base, pluck="name", order_by="paid_at asc", limit=500):
			r = post_bill(n)
			posted.append(r) if r else None
			failed += 0 if r else 1
	else:
		for sess in frappe.get_all("Restaurant Cashier Session", filters={
			"restaurant": restaurant, "status": "Closed", "erp_status": ("in", ["", None, "Pending", "Failed"]),
		}, pluck="name", order_by="closed_at asc", limit=200):
			if not frappe.db.count("Restaurant Order", {**base, "session": sess}):
				continue
			r = post_shift(sess)
			posted.append(r) if r else None
			failed += 0 if r else 1
		days = {getdate(p) for p in frappe.get_all(
			"Restaurant Order", filters={**base, "session": ("is", "not set")}, pluck="paid_at", limit=5000) if p}
		for day in sorted(days):
			if day >= getdate(nowdate()) and not include_today:
				continue
			r = post_day(restaurant, day)
			posted.append(r) if r else None
	return {"posted": posted, "failed": failed}


@frappe.whitelist()
@require_roles()
def status(restaurant: str):
	"""For Settings → Accounting: is ERPNext here, what's pending, what failed."""
	from pep_restaurant.restaurant.doctype.restaurant.restaurant import parse_tax_split

	rest = frappe.get_cached_doc("Restaurant", restaurant)
	out = {"erpnext": erpnext_installed(), "settings": None, "pending": 0, "failed": [], "recent": [],
	       "tax_labels": [lbl for lbl, _s in parse_tax_split(rest.tax_split)] or [rest.tax_label or "Tax"],
	       "currency": rest.currency}
	if not out["erpnext"]:
		return out
	if frappe.db.exists(SETTINGS, restaurant):
		out["settings"] = frappe.get_doc(SETTINGS, restaurant).as_dict()
	out["pending"] = frappe.db.count("Restaurant Order", {"restaurant": restaurant, "erp_status": "Pending"})
	out["failed"] = frappe.get_all(
		"Restaurant Order", filters={"restaurant": restaurant, "erp_status": "Failed"},
		fields=["name", "paid_at", "grand_total", "erp_error", "session"], order_by="paid_at desc", limit=20)
	out["failed_shifts"] = frappe.get_all(
		"Restaurant Cashier Session", filters={"restaurant": restaurant, "erp_status": "Failed"},
		fields=["name", "closed_at", "erp_error"], order_by="closed_at desc", limit=10)
	inv = frappe.get_all("Restaurant Order", filters={"restaurant": restaurant, "erp_status": "Posted"},
	                     fields=["erp_invoice", "paid_at", "grand_total"], order_by="paid_at desc", limit=200)
	recent: dict[str, dict] = {}
	for r in inv:
		x = recent.setdefault(r.erp_invoice, {"invoice": r.erp_invoice, "bills": 0, "total": 0.0, "paid_at": r.paid_at})
		x["bills"] += 1
		x["total"] = flt(x["total"] + flt(r.grand_total), 2)
	out["recent"] = list(recent.values())[:10]
	return out


@frappe.whitelist()
@require_roles()
def options(company: str | None = None):
	"""Dropdown choices for the Settings form, from ERPNext itself."""
	if not erpnext_installed():
		return {"erpnext": False}
	out = {"erpnext": True,
	       "companies": frappe.get_all("Company", fields=["name", "default_currency"], order_by="name")}
	company = company or (out["companies"][0].name if out["companies"] else None)
	if not company:
		return out
	out.update({
		"company": company,
		"defaults": frappe.get_cached_value("Company", company, ["default_income_account", "cost_center",
		                                                       "default_currency"], as_dict=True),
	})
	return out


# What each picker may offer, and how it's labelled. Kinds of account keep a
# picker from offering, say, a bank account as the income account.
_LINKS = {
	# Currency is a Frappe core list, so this one works without ERPNext
	"currency": ("Currency", {}, ["currency_name"], "currency_name"),
	"customer": ("Customer", {"disabled": 0}, ["customer_name"], "customer_name"),
	"item": ("Item", {"disabled": 0, "is_stock_item": 0, "is_sales_item": 1}, ["item_name"], "item_name"),
	"cost_center": ("Cost Center", {"is_group": 0}, ["cost_center_name"], None),
	"mode_of_payment": ("Mode of Payment", {"enabled": 1}, [], None),
	"income_account": ("Account", {"is_group": 0, "disabled": 0, "root_type": "Income"}, ["account_number"], None),
	"service_account": ("Account", {"is_group": 0, "disabled": 0, "root_type": ("in", ["Income", "Liability"])},
	                    ["account_number"], None),
	"tax_account": ("Account", {"is_group": 0, "disabled": 0, "root_type": ("in", ["Liability", "Expense", "Asset"])},
	                ["account_number"], None),
}


@frappe.whitelist()
@require_roles()
def search_link(kind: str, txt: str = "", company: str | None = None, limit: int = 20):
	"""Type-ahead for the Settings pickers: matches the ID or the display
	name, prefix matches first, limited to valid choices for that field
	(company-scoped where it applies). Returns [{value, label}]."""
	if kind not in _LINKS:
		frappe.throw(_("Unknown picker {0}.").format(kind))
	if kind != "currency" and not erpnext_installed():
		return []
	doctype, base, extra, label_field = _LINKS[kind]
	filters = dict(base)
	if doctype in ("Account", "Cost Center"):
		if not company:
			return []
		filters["company"] = company
	txt = (txt or "").strip()
	limit = max(1, min(cint(limit) or 20, 50))
	fields = ["name", *([label_field] if label_field else [])]
	if not txt:
		order = "enabled desc, name asc" if doctype == "Currency" else "modified desc"
		rows = frappe.get_all(doctype, filters=filters, fields=fields, order_by=order, limit=limit)
	else:
		like = f"%{txt}%"
		or_filters = {"name": ("like", like), **{f: ("like", like) for f in extra}}
		rows = frappe.get_all(doctype, filters=filters, or_filters=or_filters, fields=fields, limit=limit * 3)
		t = txt.lower()

		def rank(r):
			hay = [str(r.name).lower(), str(r.get(label_field) or "").lower()]
			return (0 if any(h == t for h in hay) else 1 if any(h.startswith(t) for h in hay) else 2, str(r.name).lower())

		rows = sorted(rows, key=rank)[:limit]
	out = []
	for r in rows:
		label = r.get(label_field) if label_field else None
		out.append({"value": r.name, "label": label if label and label != r.name else None})
	return out


@frappe.whitelist(methods=["POST"])
@require_roles()
def save_settings(restaurant: str, values):
	"""Create or update the restaurant's accounting settings."""
	if not erpnext_installed():
		frappe.throw(_("ERPNext isn't installed on this site."))
	v = frappe.parse_json(values) if isinstance(values, str) else values
	doc = frappe.get_doc(SETTINGS, restaurant) if frappe.db.exists(SETTINGS, restaurant) \
		else frappe.new_doc(SETTINGS)
	doc.restaurant = restaurant
	for k in ("enabled", "posting_mode", "start_from", "company", "customer", "cost_center", "item_mode",
	          "sales_item", "item_group", "income_account", "service_charge_account", "default_tax_account"):
		if k in v:
			doc.set(k, v[k] if k != "enabled" else cint(v[k]))
	if "tax_accounts" in v:
		doc.set("tax_accounts", [{"tax_label": r["tax_label"], "account": r["account"]}
		                         for r in v["tax_accounts"] if r.get("tax_label") and r.get("account")])
	if "payment_modes" in v:
		doc.set("payment_modes", [{"pep_mode": r["pep_mode"], "mode_of_payment": r["mode_of_payment"]}
		                          for r in v["payment_modes"] if r.get("pep_mode") and r.get("mode_of_payment")])
	doc.save()
	frappe.clear_document_cache(SETTINGS, restaurant)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles()
def quick_setup(restaurant: str, company: str):
	"""Create the bits a first-time setup needs in ERPNext - a walk-in
	customer and a non-stock 'Restaurant Sales' item - and suggest defaults
	from the company. Nothing is enabled; the manager reviews and saves."""
	if not erpnext_installed():
		frappe.throw(_("ERPNext isn't installed on this site."))
	if not frappe.db.exists("Customer", "Walk-in Customer"):
		frappe.get_doc({"doctype": "Customer", "customer_name": "Walk-in Customer", "customer_type": "Individual",
		                "customer_group": frappe.db.get_single_value("Selling Settings", "customer_group")
		                or frappe.db.get_value("Customer Group", {"is_group": 0}, "name"),
		                "territory": frappe.db.get_single_value("Selling Settings", "territory")
		                or frappe.db.get_value("Territory", {"is_group": 0}, "name")}).insert(ignore_permissions=True)
	if not frappe.db.exists("Item", "Restaurant Sales"):
		group = frappe.db.get_value("Item Group", {"is_group": 0}, "name") or "All Item Groups"
		frappe.get_doc({"doctype": "Item", "item_code": "Restaurant Sales", "item_name": "Restaurant Sales",
		                "item_group": group, "stock_uom": "Nos", "is_stock_item": 0, "is_sales_item": 1,
		                "description": "Food and beverage sales from Restaurant"}).insert(ignore_permissions=True)
	c = frappe.get_cached_value("Company", company, ["default_income_account", "cost_center", "default_cash_account"],
	                            as_dict=True)
	from pep_restaurant.restaurant.doctype.restaurant.restaurant import parse_tax_split

	rest = frappe.get_cached_doc("Restaurant", restaurant)
	labels = [lbl for lbl, _s in parse_tax_split(rest.tax_split)] or [rest.tax_label or "Tax"]
	tax_accts = frappe.get_all("Account", filters={"company": company, "account_type": "Tax", "is_group": 0,
	                                               "disabled": 0}, fields=["name", "account_name"], order_by="name")

	def tax_for(label: str):
		"""The tax account named like the tax line (VAT -> 'VAT - ABC'), if any."""
		lbl = label.strip().lower()
		exact = [a.name for a in tax_accts if a.account_name.strip().lower() == lbl]
		like = [a.name for a in tax_accts if lbl in a.account_name.lower()]
		return (exact or like or [None])[0]

	# only suggest modes of payment that can actually receive money here
	usable = {m for m in frappe.get_all("Mode of Payment", filters={"enabled": 1}, pluck="name")
	          if mop_account(m, company)}
	wallet = next((m for m in usable if "mobile" in m.lower() or "momo" in m.lower()), None)
	card = next((m for m in usable if "card" in m.lower()), None)
	guess = {"Cash": "Cash" if "Cash" in usable else None, "Card": card, "UPI": wallet, "Wallet": wallet}
	generic = tax_for("VAT") or tax_for("Tax") or (tax_accts[0].name if len(tax_accts) == 1 else None)
	return {
		"company": company, "customer": "Walk-in Customer", "item_mode": "Single item",
		"sales_item": "Restaurant Sales", "income_account": c.default_income_account, "cost_center": c.cost_center,
		"default_tax_account": generic, "start_from": nowdate(), "posting_mode": "Per shift",
		"tax_accounts": [{"tax_label": lbl, "account": tax_for(lbl)} for lbl in labels if tax_for(lbl)],
		"payment_modes": [{"pep_mode": k, "mode_of_payment": v} for k, v in guess.items() if v],
	}


@frappe.whitelist(methods=["POST"])
@require_roles()
def retry(restaurant: str):
	"""Settings → Accounting → Post now: everything pending or failed,
	including today's bills paid without a shift."""
	return post_pending(restaurant, include_today=True)
