"""Cash shifts: open with a float, every tender lands in the open shift,
paid-outs and drops come out of the drawer, close with a blind count.

Ported in spirit from kamra.cashier (sessions + a unified cash trail),
scoped to a restaurant instead of a hotel property."""

import frappe
from frappe import _
from frappe.utils import cint, flt, now

from pep_restaurant.authz import MONEY_ROLES, is_admin, require_cashier_pin, require_roles


def _open_session_name(restaurant: str, user: str | None = None) -> str | None:
	return frappe.db.get_value(
		"Pep Cashier Session", {"restaurant": restaurant, "user": user or frappe.session.user, "status": "Open"},
		"name",
	)


def session_for_payment(restaurant: str) -> str | None:
	"""The caller's open shift, or None when the restaurant doesn't require
	one. Refuses a payment with no shift when it does - cash that never
	entered a drawer can't be reconciled."""
	sess = _open_session_name(restaurant)
	if sess:
		return sess
	required = cint(frappe.db.get_value("Pep Restaurant", restaurant, "require_open_session"))
	if required and frappe.session.user != "Administrator":
		frappe.throw(_("NO_SHIFT: open your cash shift before taking payment."))
	return None


def _recompute(session: str) -> dict:
	tx = frappe.get_all("Pep Cashier Transaction", filters={"session": session},
	                    fields=["kind", "mode", "amount"])
	totals = {"system_cash": 0.0, "system_card": 0.0, "system_upi": 0.0, "system_other": 0.0,
	          "paid_outs": 0.0, "drops": 0.0, "refunds": 0.0}
	for t in tx:
		amt = flt(t.amount)
		if t.kind == "Payment":
			key = {"Cash": "system_cash", "Card": "system_card", "UPI": "system_upi"}.get(t.mode, "system_other")
			totals[key] += amt
		elif t.kind == "Refund":
			totals["refunds"] += amt
			if t.mode == "Cash":
				totals["system_cash"] -= amt
		elif t.kind == "Paid Out":
			totals["paid_outs"] += amt
		elif t.kind == "Drop":
			totals["drops"] += amt
	opening = flt(frappe.db.get_value("Pep Cashier Session", session, "opening_float"))
	totals["expected_cash"] = flt(opening + totals["system_cash"] - totals["paid_outs"] - totals["drops"], 2)
	frappe.db.set_value("Pep Cashier Session", session, {k: flt(v, 2) for k, v in totals.items()},
	                    update_modified=False)
	return totals


def record_txn(restaurant: str, kind: str, mode: str, amount: float, order: str | None = None,
               reference: str | None = None, session: str | None = None, notes: str | None = None):
	"""The one writer of the cash trail (ignore_permissions on purpose: the
	gate is the calling endpoint's role check)."""
	session = session or _open_session_name(restaurant)
	frappe.get_doc({
		"doctype": "Pep Cashier Transaction", "session": session, "restaurant": restaurant, "kind": kind,
		"mode": mode, "amount": flt(amount, 2), "order": order, "reference": reference,
		"posted_by": frappe.session.user, "posted_at": now(), "notes": notes,
	}).insert(ignore_permissions=True)
	if session:
		_recompute(session)


def _as_dict(name: str) -> dict:
	doc = frappe.get_doc("Pep Cashier Session", name).as_dict()
	doc["transactions"] = frappe.get_all(
		"Pep Cashier Transaction", filters={"session": name},
		fields=["name", "kind", "mode", "amount", "order", "reference", "posted_at", "notes"],
		order_by="posted_at desc",
	)
	return doc


@frappe.whitelist()
@require_roles(*MONEY_ROLES)
def current_session(restaurant: str):
	name = _open_session_name(restaurant)
	return _as_dict(name) if name else None


@frappe.whitelist(methods=["POST"])
@require_roles(*MONEY_ROLES)
def open_session(restaurant: str, opening_float: float = 0, terminal: str | None = None):
	if _open_session_name(restaurant):
		frappe.throw(_("You already have an open shift."))
	if flt(opening_float) < 0:
		frappe.throw(_("The opening float can't be negative."))
	doc = frappe.get_doc({
		"doctype": "Pep Cashier Session", "restaurant": restaurant, "user": frappe.session.user,
		"status": "Open", "opened_at": now(), "opening_float": flt(opening_float, 2),
		"expected_cash": flt(opening_float, 2), "terminal": (terminal or "").strip()[:60] or None,
	})
	doc.insert(ignore_permissions=True)
	return _as_dict(doc.name)


@frappe.whitelist(methods=["POST"])
@require_roles(*MONEY_ROLES)
def paid_out(restaurant: str, amount: float, reason: str, pin: str | None = None):
	"""Cash out of the drawer for a business expense (ice, a plumber)."""
	return _drawer_out(restaurant, "Paid Out", amount, reason, pin)


@frappe.whitelist(methods=["POST"])
@require_roles(*MONEY_ROLES)
def cash_drop(restaurant: str, amount: float, note: str | None = None, pin: str | None = None):
	"""Excess cash moved from the drawer to the safe mid-shift."""
	return _drawer_out(restaurant, "Drop", amount, note or "Safe drop", pin)


def _drawer_out(restaurant, kind, amount, reason, pin):
	if flt(amount) <= 0:
		frappe.throw(_("Amount must be above zero."))
	if not (reason or "").strip():
		frappe.throw(_("Give a reason."))
	require_cashier_pin(restaurant, pin)
	sess = _open_session_name(restaurant)
	if not sess:
		frappe.throw(_("NO_SHIFT: open your cash shift first."))
	record_txn(restaurant, kind, "Cash", amount, reference=reason.strip()[:140], session=sess)
	return _as_dict(sess)


@frappe.whitelist(methods=["POST"])
@require_roles(*MONEY_ROLES)
def close_session(session: str, counted_cash: float, notes: str | None = None, pin: str | None = None):
	"""Blind close: the cashier counts the drawer, the system shows the
	variance against what it expected. A variance needs a note."""
	doc = frappe.get_doc("Pep Cashier Session", session)
	if doc.status != "Open":
		frappe.throw(_("This shift is already closed."))
	if doc.user != frappe.session.user and not is_admin():
		frappe.throw(_("Only the shift's cashier or a manager can close it."), frappe.PermissionError)
	require_cashier_pin(doc.restaurant, pin)
	totals = _recompute(session)
	variance = flt(flt(counted_cash) - totals["expected_cash"], 2)
	if abs(variance) >= 0.01 and not (notes or "").strip():
		frappe.throw(_("The count is off by {0} - add a note explaining it.").format(variance))
	frappe.db.set_value("Pep Cashier Session", session, {
		"status": "Closed", "counted_cash": flt(counted_cash, 2), "variance": variance, "closed_at": now(),
		"closed_by": frappe.session.user, "close_notes": (notes or "").strip()[:500] or None,
	})
	from pep_restaurant.accounting import on_shift_closed

	on_shift_closed(session, doc.restaurant)
	return _as_dict(session)


@frappe.whitelist()
@require_roles(*MONEY_ROLES)
def list_sessions(restaurant: str, limit: int = 30):
	filters = {"restaurant": restaurant}
	if not is_admin():
		filters["user"] = frappe.session.user
	return frappe.get_all(
		"Pep Cashier Session", filters=filters,
		fields=["name", "user", "status", "opened_at", "closed_at", "opening_float", "system_cash", "system_card",
		        "system_upi", "system_other", "paid_outs", "drops", "expected_cash", "counted_cash", "variance"],
		order_by="opened_at desc", limit=min(cint(limit) or 30, 200),
	)


@frappe.whitelist()
@require_roles(*MONEY_ROLES)
def session_report(session: str):
	doc = frappe.db.get_value("Pep Cashier Session", session, ["user"], as_dict=True)
	if doc and doc.user != frappe.session.user and not is_admin():
		frappe.throw(_("Not your shift."), frappe.PermissionError)
	return _as_dict(session)
