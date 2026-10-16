"""Restaurant POS - digital menu, captain ordering, KOT to the kitchen and
settlement at the till.

Flow: a captain (or a guest via QR) places an order -> a captain confirms a
QR order -> firing the KOT sends lines to the kitchen display (and takes the
recipe off the outlet's stock) -> the kitchen marks lines prepared -> the
bill is settled (paid / NC) and closes.

Ported from kamra.pos with the hotel parts (rooms, folios, stays) removed.
The rules that matter are kept verbatim:

- prices come from the menu, never from the caller (_load_items);
- a void is a struck-through line with a reason, never a deletion;
- a bill closes only when it is paid, NC with an authorizer, or empty;
- a KOT line's clock starts when it is fired, not when the tab opened.
"""

import json

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, flt, get_datetime, getdate, now, now_datetime, today

from pep_restaurant.authz import (
	FLOOR_ROLES,
	KITCHEN_ROLES,
	MONEY_ROLES,
	assert_restaurant_access,
	is_admin,
	require_cashier_pin,
	require_roles,
)

OPEN = ("Placed", "Confirmed", "Preparing")
ORDER_TYPES = ("Dine In", "Takeaway", "Delivery")
PAY_MODES = ("Cash", "Card", "UPI", "Wallet", "Other")
# Menus written before coursing existed have no course; they behave as mains.
DEFAULT_COURSE = "Main"
COURSE_ORDER = ("Starter", "Main", "Dessert", "Drink")


# ------------------------------------------------------------------ menu


@frappe.whitelist()
@require_roles(*FLOOR_ROLES, *KITCHEN_ROLES)
def outlets(restaurant: str):
	return frappe.get_all(
		"Pep Outlet",
		filters={"restaurant": restaurant, "disabled": 0},
		fields=["name", "outlet_name", "outlet_type", "tax_rate", "service_charge_rate", "auto_kot", "qr_ordering"],
		order_by="outlet_name",
	)


def _menu(outlet: str, guest: bool = False) -> list:
	fields = ["name", "item_name", "category", "price", "is_veg", "is_alcohol", "image", "description", "allergens",
	          "sort_order"]
	if not guest:
		fields += ["course", "prep_station"]
	items = frappe.get_all(
		"Pep Menu Item",
		filters={"outlet": outlet, "available": 1},
		fields=fields,
		order_by="category asc, sort_order asc, item_name asc",
	)
	cats: dict[str, list] = {}
	for it in items:
		cats.setdefault(it.category or "Other", []).append(it)
	# categories follow the menu's own sort order (lowest dish first), not A-Z
	order = {c: min(cint(i.get("sort_order")) for i in v) for c, v in cats.items()}
	return [{"category": c, "items": v} for c, v in sorted(cats.items(), key=lambda kv: (order[kv[0]], kv[0]))]


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def pos_menu(outlet: str):
	"""The digital menu for an outlet: available items grouped by category."""
	return {"outlet": outlet, "categories": _menu(outlet)}


def _load_items(outlet: str, rows) -> list:
	"""Normalise incoming lines and price them from the menu - the caller
	(captain or guest) never sets a price, only qty and instructions. Items
	from another outlet, or 86'd items, are dropped."""
	if isinstance(rows, str):
		rows = frappe.parse_json(rows)
	out = []
	for r in rows or []:
		mi = frappe.db.get_value(
			"Pep Menu Item",
			r.get("menu_item"),
			["item_name", "price", "available", "outlet", "course", "prep_station"],
			as_dict=True,
		)
		if not mi or not mi.available or mi.outlet != outlet:
			continue
		qty = flt(r.get("qty") or 1)
		if qty <= 0:
			continue
		out.append({
			"menu_item": r["menu_item"],
			"item_name": mi.item_name,
			"qty": min(qty, 999),
			"rate": flt(mi.price),
			"instructions": (r.get("instructions") or "")[:140] or None,
			"course": mi.course or DEFAULT_COURSE,
			"prep_station": mi.prep_station or "Kitchen",
			"kot_status": "New",
		})
	return out


def _allergy_hits(allergy_note: str | None, allergens: str | None) -> list:
	"""Which of a dish's allergens the guest declared. Loose on purpose: the
	captain types "nut allergy", the menu says "Nuts", the line must still
	light up. A guard, never a guarantee - the note is always shown in full."""
	if not (allergy_note or "").strip() or not (allergens or "").strip():
		return []
	note = allergy_note.lower()
	return [a for a in (x.strip() for x in allergens.split(",")) if a and a.lower().rstrip("s") in note]


def _open_doc(order: str):
	doc = frappe.get_doc("Pep Order", order)
	if doc.status not in OPEN:
		frappe.throw(_("This order is already closed."))
	return doc


# ---------------------------------------------------------------- orders


def create_order_core(
	outlet: str,
	items,
	table_no: str | None = None,
	source: str = "Manual",
	notes: str | None = None,
	order_type: str | None = None,
	guests=None,
	customer_name: str | None = None,
	customer_phone: str | None = None,
	delivery_address: str | None = None,
	allergy_note: str | None = None,
	ignore_permissions: bool = False,
) -> dict:
	o = frappe.db.get_value("Pep Outlet", outlet, ["restaurant", "disabled"], as_dict=True)
	if not o or o.disabled:
		frappe.throw(_("This outlet isn't taking orders."))
	lines = _load_items(outlet, items)
	if not lines:
		frappe.throw(_("Add at least one available item."))
	if order_type not in ORDER_TYPES:
		order_type = "Dine In"
	if order_type == "Delivery" and not (customer_phone or customer_name):
		frappe.throw(_("Delivery needs the customer's name or phone."))
	doc = frappe.get_doc({
		"doctype": "Pep Order",
		"restaurant": o.restaurant,
		"outlet": outlet,
		"status": "Placed",
		"source": source if source in ("Manual", "QR", "Phone", "Online", "API") else "Manual",
		"order_type": order_type,
		"table_no": (table_no or "").strip() or None,
		"guests": cint(guests) or None,
		"customer_name": (customer_name or "").strip()[:100] or None,
		"customer_phone": (customer_phone or "").strip()[:30] or None,
		"delivery_address": (delivery_address or "").strip()[:300] or None,
		"captain": frappe.session.user if source != "QR" else None,
		"notes": (notes or "").strip()[:500] or None,
		"allergy_note": (allergy_note or "").strip()[:140] or None,
		"items": lines,
	})
	doc.insert(ignore_permissions=ignore_permissions)
	return {"ok": True, "order": doc.name, "grand_total": doc.grand_total, "status": doc.status}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def create_order(
	outlet: str,
	items,
	table_no: str | None = None,
	source: str = "Manual",
	notes: str | None = None,
	order_type: str | None = None,
	guests=None,
	customer_name: str | None = None,
	customer_phone: str | None = None,
	delivery_address: str | None = None,
	allergy_note: str | None = None,
):
	"""Captain takes an order: dine-in on a table, takeaway or delivery."""
	if source == "QR":
		source = "Manual"  # only the public endpoint may mark a bill as a guest's
	return create_order_core(
		outlet, items, table_no=table_no, source=source, notes=notes, order_type=order_type,
		guests=guests, customer_name=customer_name, customer_phone=customer_phone,
		delivery_address=delivery_address, allergy_note=allergy_note,
	)


def _label(r) -> str:
	"""A human tag for a bill: where it is, or who it's for."""
	if r.get("table_no"):
		return f"Table {r['table_no']}"
	who = (r.get("customer_name") or "").split(" ")[0]
	if r.get("order_type") in ("Takeaway", "Delivery"):
		return f"{r['order_type']} · {who}" if who else r["order_type"]
	return r.get("name") or ""


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def open_orders(outlet: str):
	"""Every running tab at an outlet, so a captain can juggle several."""
	rows = frappe.get_all(
		"Pep Order",
		filters={"outlet": outlet, "status": ("in", OPEN)},
		fields=["name", "status", "source", "table_no", "order_type", "grand_total", "kot_fired", "kot_no",
		        "guests", "customer_name", "creation", "modified", "nc"],
		order_by="creation asc",
	)
	if rows:
		counts: dict[str, dict] = {}
		for it in frappe.get_all(
			"Pep Order Item",
			filters={"parent": ("in", [r.name for r in rows]), "parenttype": "Pep Order", "voided": 0},
			fields=["parent", "kot_status"],
		):
			c = counts.setdefault(it.parent, {"items": 0, "pending": 0, "new": 0})
			c["items"] += 1
			c["pending"] += 1 if it.kot_status == "Fired" else 0
			c["new"] += 1 if it.kot_status == "New" else 0
		for r in rows:
			r.update(counts.get(r.name) or {"items": 0, "pending": 0, "new": 0})
			r["label"] = _label(r)
	# two parties on one table (or a split bill) share a label - number them
	groups: dict[str, list] = {}
	for r in rows:
		groups.setdefault(r["label"], []).append(r)
	for label, group in groups.items():
		if len(group) > 1:
			for i, r in enumerate(group, 1):
				r["label"] = f"{label} · {i}"
	return rows


def _order_state(o) -> str:
	if o["status"] == "Placed" and o.get("source") == "QR":
		return "new_qr"
	if not o["kot_fired"] or o.get("new"):
		return "running"
	return "fired" if o["pending"] else "ready"


def _cleaning_key(outlet: str, table_no: str) -> str:
	return f"pep_pos_cleaning|{outlet}|{table_no}"


def _flag_cleaning_if_freed(doc):
	"""When the last bill on a dine-in table closes, flag the table for
	cleaning (auto-clears after 30 minutes, or on Mark clean)."""
	if not doc.table_no or doc.order_type != "Dine In":
		return
	still_open = frappe.db.count(
		"Pep Order", {"outlet": doc.outlet, "table_no": doc.table_no, "status": ("in", OPEN)}
	)
	if not still_open:
		frappe.cache.set_value(_cleaning_key(doc.outlet, doc.table_no), "1", expires_in_sec=30 * 60)


def parse_tables(raw: str | None) -> list[tuple[str, int | None, str | None]]:
	"""An outlet's table list: "[Main Hall]" starts an area; "T1:4" = table
	T1 with 4 seats; plain "T1" works too; commas work as separators."""
	tables = []
	area = None
	for line in (raw or "").replace(",", "\n").splitlines():
		line = line.strip()
		if not line:
			continue
		if line.startswith("[") and line.endswith("]"):
			area = line[1:-1].strip() or None
			continue
		name, _sep, seats = line.partition(":")
		tables.append((name.strip(), int(seats) if seats.strip().isdigit() else None, area))
	return tables


def _upcoming_reservations(outlet: str):
	rest = frappe.db.get_value("Pep Outlet", outlet, "restaurant")
	cfg = frappe.db.get_value(
		"Pep Restaurant", rest, ["reservation_before_min", "reservation_after_min"], as_dict=True
	) or {}
	before = cint(cfg.get("reservation_before_min") or 60)
	after = cint(cfg.get("reservation_after_min") or 240)
	n = now_datetime()
	return frappe.get_all(
		"Pep Table Reservation",
		filters={
			"outlet": outlet,
			"status": "Booked",
			"reserved_at": ("between", [add_to_date(n, minutes=-after), add_to_date(n, minutes=before)]),
		},
		fields=["name", "table_no", "guest_name", "phone", "party_size", "reserved_at", "notes"],
		order_by="reserved_at asc",
	)


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def table_map(outlet: str):
	"""The table view a captain starts from: every table with its live state -
	vacant, reserved, cleaning, new_qr (a guest order waiting for a captain),
	running (open bill, nothing in the kitchen), fired (KOT cooking) or ready
	(everything prepared, awaiting service/settle). A table holds any number
	of bills; the tile shows the most urgent state."""
	tables = parse_tables(frappe.db.get_value("Pep Outlet", outlet, "tables"))
	running = open_orders(outlet)
	by_table: dict[str, list] = {}
	for r in running:
		if r.get("table_no"):
			by_table.setdefault(r["table_no"], []).append(r)

	reserved = {}
	for r in _upcoming_reservations(outlet):
		reserved.setdefault(r.table_no, {
			"reservation": r.name,
			"res_guest": r.guest_name,
			"res_party": r.party_size,
			"res_phone": r.phone,
			"res_time": get_datetime(r.reserved_at).strftime("%H:%M"),
		})

	urgency = ("new_qr", "fired", "running", "ready")

	def tile(t, seats, area, temp=False):
		orders = by_table.get(t, [])
		base = {"table": t, "seats": seats, "area": area, "temp": temp, **reserved.get(t, {})}
		if not orders:
			state = (
				"reserved" if t in reserved
				else "cleaning" if frappe.cache.get_value(_cleaning_key(outlet, t))
				else "vacant"
			)
			return {**base, "state": state, "bills": 0, "orders": []}
		states = [_order_state(o) for o in orders]
		state = next(s for s in urgency if s in states)
		return {
			**base,
			"state": state,
			"bills": len(orders),
			"grand_total": sum(flt(o["grand_total"]) for o in orders),
			"guests": sum(cint(o.get("guests")) for o in orders) or None,
			"since": str(min(o["creation"] for o in orders)),
			"orders": [
				{"order": o["name"], "label": o["label"], "grand_total": o["grand_total"], "state": s}
				for o, s in zip(orders, states, strict=True)
			],
		}

	out = [tile(t, seats, a) for t, seats, a in tables]
	configured = {t for t, _s, _a in tables}
	# ad-hoc tables (a named table outside the layout) get live tiles too
	for t in sorted(t for t in by_table if t not in configured):
		out.append(tile(t, None, "Other", temp=True))
	shown = {b["order"] for t in out for b in t["orders"]}
	other = [dict(r, state=_order_state(r)) for r in running if r["name"] not in shown]
	return {"tables": out, "other": other}


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def order_detail(order: str):
	"""One order's full contents - to load a running tab back into the till."""
	doc = frappe.get_doc("Pep Order", order)
	return {
		"name": doc.name, "outlet": doc.outlet, "restaurant": doc.restaurant, "status": doc.status,
		"source": doc.source, "table_no": doc.table_no, "order_type": doc.order_type,
		"kot_no": doc.kot_no, "kot_fired": doc.kot_fired, "guests": doc.guests,
		"customer_name": doc.customer_name, "customer_phone": doc.customer_phone,
		"delivery_address": doc.delivery_address, "notes": doc.notes, "allergy_note": doc.allergy_note,
		"nc": doc.nc, "nc_authorized_by": doc.nc_authorized_by, "nc_note": doc.nc_note,
		"paid": doc.paid, "payment_mode": doc.payment_mode, "tenders": doc.tenders,
		"discount_amount": doc.discount_amount, "discount_reason": doc.discount_reason,
		"subtotal": doc.subtotal, "order_total": doc.order_total,
		"service_charge_rate": doc.service_charge_rate, "service_charge": doc.service_charge,
		"tax_rate": doc.tax_rate, "tax_amount": doc.tax_amount, "prices_include_tax": doc.prices_include_tax,
		"grand_total": doc.grand_total, "label": _label(doc.as_dict()),
		"kot_tickets": _kot_tickets_of(doc), "creation": str(doc.creation),
		"items": [
			{"row": it.name, "menu_item": it.menu_item, "item_name": it.item_name, "qty": it.qty,
			 "rate": it.rate, "amount": it.amount, "instructions": it.instructions, "course": it.course,
			 "kot_status": it.kot_status, "voided": it.voided, "void_reason": it.void_reason}
			for it in doc.items
		],
	}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def add_items(order: str, items):
	"""Add a round to a running tab - new lines are priced from the menu and
	start as New (a later fire_kot sends them to the kitchen)."""
	doc = _open_doc(order)
	lines = _load_items(doc.outlet, items)
	if not lines:
		frappe.throw(_("Add at least one available item."))
	for line in lines:
		doc.append("items", line)
	doc.save()
	return {"ok": True, "grand_total": doc.grand_total}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def update_order(order: str, table_no: str | None = None, guests=None, customer_name: str | None = None,
                 customer_phone: str | None = None, delivery_address: str | None = None,
                 notes: str | None = None, allergy_note: str | None = None, order_type: str | None = None):
	"""Edit a running bill's header: move it to another table, change covers,
	customer details or notes. Only the fields passed are touched."""
	doc = _open_doc(order)
	old_table = doc.table_no
	if table_no is not None:
		doc.table_no = table_no.strip() or None
	if guests is not None:
		doc.guests = cint(guests) or None
	if order_type in ORDER_TYPES:
		doc.order_type = order_type
	for f, v, n in (("customer_name", customer_name, 100), ("customer_phone", customer_phone, 30),
	                ("delivery_address", delivery_address, 300), ("notes", notes, 500),
	                ("allergy_note", allergy_note, 140)):
		if v is not None:
			doc.set(f, v.strip()[:n] or None)
	doc.save()
	if old_table and old_table != doc.table_no:
		ghost = frappe._dict(outlet=doc.outlet, table_no=old_table, order_type="Dine In")
		_flag_cleaning_if_freed(ghost)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def confirm_order(order: str):
	"""Captain vets a guest's QR order before it can fire to the kitchen."""
	doc = _open_doc(order)
	if doc.status == "Placed":
		doc.status = "Confirmed"
	if not doc.captain:
		doc.captain = frappe.session.user
	doc.save()
	return {"ok": True, "status": doc.status}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def apply_discount(order: str, amount: float = 0, percent: float = 0, reason: str = ""):
	"""Grant a discount with a reason. Pass an amount, or a percent of the
	subtotal. Zero removes it."""
	doc = _open_doc(order)
	amount = flt(amount)
	if flt(percent):
		amount = flt(doc.subtotal) * min(flt(percent), 100) / 100
	if amount > 0 and not (reason or "").strip():
		frappe.throw(_("A discount needs a reason."))
	doc.discount_amount = flt(amount, 2)
	doc.discount_reason = (reason or "").strip()[:140] or None
	doc.save()
	return {"ok": True, "discount": doc.discount_amount, "grand_total": doc.grand_total}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def split_order(order: str, item_rows, table_no: str | None = None):
	"""Move the chosen lines to a new bill on the same table (or a named one).
	Fired lines keep their kitchen status and stock flag, and the two bills
	conserve the original total."""
	if isinstance(item_rows, str):
		item_rows = frappe.parse_json(item_rows)
	rows = {r for r in (item_rows or []) if r}
	if not rows:
		frappe.throw(_("Pick at least one line to move."))
	src = _open_doc(order)
	move = [it for it in src.items if it.name in rows and not it.voided]
	if len(move) != len(rows):
		frappe.throw(_("Some lines were not found (or already voided)."))
	if not [it for it in src.items if it.name not in rows and not it.voided]:
		frappe.throw(_("Every line is moving - move the bill to another table instead of splitting it."))
	fired = any(it.kot_status != "New" for it in move)
	new = frappe.get_doc({
		"doctype": "Pep Order",
		"restaurant": src.restaurant,
		"outlet": src.outlet,
		"status": "Preparing" if fired else src.status,
		"source": src.source,
		"order_type": src.order_type,
		"customer_name": src.customer_name,
		"customer_phone": src.customer_phone,
		"delivery_address": src.delivery_address,
		"table_no": (table_no or "").strip() or src.table_no,
		"captain": frappe.session.user,
		"kot_fired": 1 if fired else 0,
		"kot_no": src.kot_no,  # shared: the kitchen knows it by this ticket
		"accepted_at": src.accepted_at,
		"notes": src.notes,
		"allergy_note": src.allergy_note,
		"tax_rate": src.tax_rate,
		"service_charge_rate": src.service_charge_rate,
		"prices_include_tax": src.prices_include_tax,
		"items": [{
			"menu_item": it.menu_item, "item_name": it.item_name, "qty": it.qty, "rate": it.rate,
			"instructions": it.instructions, "course": it.course, "prep_station": it.prep_station,
			"kot_status": it.kot_status, "fired_at": it.fired_at, "prepared_at": it.prepared_at,
			# the food is already cooked and deducted; carrying the flag is what
			# stops the new bill deducting it twice
			"stock_posted": it.stock_posted,
		} for it in move],
	})
	new.flags.keep_rates = True
	new.insert()
	for it in move:
		src.remove(it)
	# a discount larger than what is left would silently move value; clamp it
	src.save()
	return {"ok": True, "new_order": new.name, "source_total": src.grand_total, "new_total": new.grand_total}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def merge_orders(order: str, into: str):
	"""Fold one bill into another at the same outlet (two tables pushed
	together, or a split undone). Lines keep their kitchen state."""
	if order == into:
		frappe.throw(_("Pick two different bills."))
	src, dst = _open_doc(order), _open_doc(into)
	if src.outlet != dst.outlet:
		frappe.throw(_("Both bills must be at the same outlet."))
	if src.nc != dst.nc:
		frappe.throw(_("Can't merge an NC bill with a charged one."))
	for it in src.items:
		row = it.as_dict()
		for k in ("name", "parent", "parentfield", "parenttype", "idx", "creation", "modified", "owner",
		          "modified_by", "docstatus", "doctype"):
			row.pop(k, None)
		dst.append("items", row)
	if src.kot_fired:
		dst.kot_fired = 1
		dst.kot_no = dst.kot_no or src.kot_no
		if dst.status != "Preparing":
			dst.status = "Preparing"
	dst.guests = (cint(dst.guests) + cint(src.guests)) or None
	dst.save()
	src.status = "Cancelled"
	src.notes = (f"{src.notes}\n" if src.notes else "") + f"Merged into {dst.name}"
	src.flags.merged = True
	# every line now lives on the target; void the copies so the source's
	# kitchen lines do not show twice
	for it in src.items:
		it.voided = 1
		it.void_reason = f"Merged into {dst.name}"
		it.void_seen = 1
	src.save()
	return {"ok": True, "order": dst.name, "grand_total": dst.grand_total}


# ------------------------------------------------------------ the kitchen


def _kot_tickets_of(doc) -> list:
	raw = getattr(doc, "last_kot_ticket", None)
	try:
		data = json.loads(raw) if raw else []
	except ValueError:
		data = []
	return data if isinstance(data, list) else []


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def fire_kot(order: str, course: str | None = None):
	"""Send the order to the kitchen: New lines become Fired and show on the
	kitchen display. Stamps the KOT number (a daily sequence per outlet) and
	returns the just-fired lines so the till can print the thermal ticket.

	Pass a course to send only that course and hold the rest. A guest's QR
	order must be confirmed by a captain first. Outlets with auto KOT also
	accept the ticket at the pass, and the response tells the till to print."""
	doc = _open_doc(order)
	if doc.source == "QR" and doc.status == "Placed":
		frappe.throw(_("Confirm the guest's QR order before sending it to the kitchen."))
	stamp = now()
	fired, fired_rows = [], []
	auto = bool(frappe.db.get_value("Pep Outlet", doc.outlet, "auto_kot"))
	for it in doc.items:
		if it.kot_status == "New" and not it.voided:
			if course and (it.course or DEFAULT_COURSE) != course:
				continue
			it.kot_status = "Fired"
			it.fired_at = stamp
			fired.append({"item_name": it.item_name, "qty": it.qty, "instructions": it.instructions,
			              "station": it.prep_station})
			fired_rows.append({"row": it.name, "menu_item": it.menu_item, "qty": it.qty,
			                   "stock_posted": it.stock_posted})
	if not fired:
		frappe.throw(_("Nothing is held on that course.") if course else _("There is nothing new to send."))
	if not doc.kot_no:
		# site-local "today", not the DB server's UTC date
		last = frappe.db.sql(
			"select max(kot_no) from `tabPep Order` where outlet=%s and creation >= %s",
			(doc.outlet, today()),
		)[0][0] or 0
		doc.kot_no = int(last) + 1
	doc.kot_fired = 1
	if doc.status in ("Placed", "Confirmed"):
		doc.status = "Preparing"
	if auto and not doc.accepted_at:
		doc.accepted_at = stamp
	doc.save()
	# Ingredients leave the shelf now - when the chef starts cooking - not when
	# the bill is paid. Never blocks: a short count must not stop service.
	from pep_restaurant.inventory import consume_for_lines

	alerts = consume_for_lines(doc, fired_rows)
	history = _kot_tickets_of(doc)
	ticket = {
		"kot_no": doc.kot_no, "at": stamp, "round": len(history) + 1, "nc": bool(doc.nc),
		"nc_by": doc.nc_authorized_by, "label": _label(doc.as_dict()), "order_type": doc.order_type,
		"order": doc.name, "customer": doc.customer_name, "address": doc.delivery_address,
		"allergy_note": doc.allergy_note, "course": course, "items": fired,
	}
	history.append(ticket)
	doc.db_set("last_kot_ticket", json.dumps(history, default=str), update_modified=False)
	return {"ok": True, "status": doc.status, "kot_no": doc.kot_no, "ticket": ticket,
	        "auto_print": bool(auto), "accepted_at": doc.accepted_at, "stock_alerts": alerts}


@frappe.whitelist()
@require_roles(*KITCHEN_ROLES)
def kitchen_queue(restaurant: str, outlet: str | None = None, station: str | None = None):
	"""The kitchen display: fired orders the kitchen still has work on.

	Each line carries a `state` the screen renders directly:
	  cooking   - fired, still to make
	  held      - a later course or a new round; visible but not to start
	  cancelled - voided after it fired; the chef may be cooking it right now,
	              so it stays (loudly) until acknowledged
	  done      - prepared; kept for context and to allow a recall

	A ticket stays on the board while it has cooking, held or cancelled lines.
	`fired_at` per line is what the display ages against."""
	assert_restaurant_access(restaurant)
	# cancelled orders stay on while a fired line's cancellation is unseen
	filters = {"restaurant": restaurant, "status": ("in", (*OPEN, "Cancelled")), "kot_fired": 1,
	           "modified": (">", add_to_date(now_datetime(), hours=-12))}
	if outlet:
		filters["outlet"] = outlet
	orders = frappe.get_all(
		"Pep Order", filters=filters,
		fields=["name", "outlet", "table_no", "creation", "notes", "kot_no", "order_type", "guests",
		        "captain", "allergy_note", "accepted_at", "customer_name", "nc"],
		order_by="creation asc",
	)
	if not orders:
		return []
	rows = frappe.get_all(
		"Pep Order Item",
		filters={"parent": ("in", [o.name for o in orders]), "parenttype": "Pep Order"},
		fields=["name", "parent", "item_name", "qty", "instructions", "kot_status", "menu_item", "voided",
		        "void_reason", "void_seen", "fired_at", "prepared_at", "course", "prep_station", "idx"],
		order_by="idx asc",
	)
	menu = {
		m.name: m for m in frappe.get_all(
			"Pep Menu Item", filters={"name": ("in", list({r.menu_item for r in rows}))},
			fields=["name", "is_veg", "is_alcohol", "allergens"],
		)
	} if rows else {}
	outlet_names = dict(frappe.get_all(
		"Pep Outlet", filters={"name": ("in", list({o.outlet for o in orders}))},
		fields=["name", "outlet_name"], as_list=True,
	))
	allergy_of = {o.name: o.allergy_note for o in orders}
	by_order: dict[str, list] = {}
	for r in rows:
		if r.voided and (r.void_seen or r.kot_status not in ("Fired", "Prepared")):
			continue  # acknowledged, or voided before it ever reached the line
		if station and (r.prep_station or "Kitchen") != station:
			continue
		meta = menu.get(r.menu_item) or {}
		r["state"] = ("cancelled" if r.voided else "held" if r.kot_status == "New"
		              else "done" if r.kot_status == "Prepared" else "cooking")
		r["course"] = r.course or DEFAULT_COURSE
		r["is_veg"] = meta.get("is_veg")
		r["is_alcohol"] = meta.get("is_alcohol")
		r["allergens"] = meta.get("allergens")
		r["allergy_hits"] = _allergy_hits(allergy_of.get(r.parent), meta.get("allergens"))
		by_order.setdefault(r.parent, []).append(r)
	out = []
	for o in orders:
		items = by_order.get(o.name) or []
		if not any(i["state"] in ("cooking", "held", "cancelled") for i in items):
			continue
		o["outlet_name"] = outlet_names.get(o.outlet)
		o["label"] = _label(o)
		o["items"] = items
		held = {i["course"] for i in items if i["state"] == "held"}
		o["held_courses"] = [c for c in COURSE_ORDER if c in held]
		out.append(o)
	return out


@frappe.whitelist(methods=["POST"])
@require_roles(*KITCHEN_ROLES)
def accept_ticket(order: str):
	"""The kitchen takes the ticket on. Until then the floor has no evidence
	anyone has seen it - a KOT can print to an empty pass."""
	doc = frappe.get_doc("Pep Order", order)
	if not doc.accepted_at:
		doc.accepted_at = now()
		doc.save()
	return {"ok": True, "accepted_at": doc.accepted_at}


@frappe.whitelist(methods=["POST"])
@require_roles(*KITCHEN_ROLES)
def mark_prepared(order: str, item_row: str | None = None):
	"""Kitchen marks one line (or every cooking line) prepared. Voided lines
	are never swept up by "all ready" - that food is cancelled, not cooked."""
	doc = _open_doc(order)
	stamp = now()
	for it in doc.items:
		if it.voided:
			continue
		if (item_row and it.name == item_row and it.kot_status == "Fired") or (
			not item_row and it.kot_status == "Fired"
		):
			it.kot_status = "Prepared"
			it.prepared_at = stamp
	if not doc.accepted_at:
		doc.accepted_at = stamp
	doc.save()
	live = [it for it in doc.items if not it.voided and it.kot_status != "New"]
	return {"ok": True, "all_prepared": bool(live) and all(it.kot_status == "Prepared" for it in live)}


@frappe.whitelist(methods=["POST"])
@require_roles(*KITCHEN_ROLES)
def recall_prepared(order: str, item_row: str | None = None):
	"""Undo a mark-prepared: the line goes back to Fired (never New - that
	would re-fire and re-deduct stock). A mis-tap must not be one-way."""
	doc = _open_doc(order)
	for it in doc.items:
		if it.voided:
			continue
		if (item_row and it.name == item_row) or (not item_row and it.kot_status == "Prepared"):
			if it.kot_status == "Prepared":
				it.kot_status = "Fired"
				it.prepared_at = None
	doc.save()
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles(*KITCHEN_ROLES)
def acknowledge_void(order: str, item_row: str):
	"""The chef has seen that a fired line was cancelled; drop it from the
	display. The void itself stays on the order."""
	doc = frappe.get_doc("Pep Order", order)
	target = next((it for it in doc.items if it.name == item_row), None)
	if not target:
		frappe.throw(_("Order line not found."))
	if not target.voided:
		frappe.throw(_("That line is not voided."))
	target.void_seen = 1
	doc.save()
	return {"ok": True}


# -------------------------------------------------------- voids and comps


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def void_item(order: str, item_row: str, reason: str):
	"""Void one line with a reason - it stays on the order (struck through,
	amount zero) so the KOT-vs-bill audit holds up."""
	if not (reason or "").strip():
		frappe.throw(_("A void reason is required."))
	doc = _open_doc(order)
	target = next((it for it in doc.items if it.name == item_row), None)
	if not target:
		frappe.throw(_("Order line not found."))
	if target.voided:
		frappe.throw(_("That line is already voided."))
	target.voided = 1
	target.void_reason = reason.strip()[:140]
	target.voided_by = frappe.session.user
	doc.save()
	return {"ok": True, "grand_total": doc.grand_total, "subtotal": doc.subtotal}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def change_qty(order: str, item_row: str, qty: float):
	"""Change the quantity of a line not yet sent to the kitchen. Once fired,
	a change is a void (with a reason) plus a new line - the kitchen has the
	old number on its ticket."""
	doc = _open_doc(order)
	target = next((it for it in doc.items if it.name == item_row), None)
	if not target or target.voided:
		frappe.throw(_("Order line not found."))
	if target.kot_status != "New":
		frappe.throw(_("This line is already in the kitchen - void it with a reason instead."))
	qty = flt(qty)
	if qty <= 0:
		doc.remove(target)
	else:
		target.qty = min(qty, 999)
	if not [it for it in doc.items]:
		frappe.throw(_("A bill needs at least one line - cancel the order instead."))
	doc.save()
	return {"ok": True, "grand_total": doc.grand_total}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def mark_nc(order: str, authorized_by: str = "", note: str = "", undo: int = 0):
	"""NC (no charge / complimentary). Needs who authorized it and takes a
	free-text reference. Items still fire to the kitchen - the bill just
	closes at zero. `undo=1` lifts it."""
	doc = _open_doc(order)
	if doc.paid:
		frappe.throw(_("Already paid."))
	if cint(undo):
		doc.nc, doc.nc_authorized_by, doc.nc_note = 0, None, None
	else:
		if not (authorized_by or "").strip():
			frappe.throw(_("Who authorized the NC? (captain / chef / manager...)"))
		doc.nc = 1
		doc.nc_authorized_by = authorized_by.strip()[:80]
		doc.nc_note = (note or "").strip()[:200] or None
	doc.save()
	return {"ok": True, "nc": bool(doc.nc), "grand_total": doc.grand_total}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def cancel_order(order: str, reason: str):
	"""Cancel a running order - needs a reason, kept for the audit. Fired food
	stays consumed (see inventory.consume_for_lines)."""
	if not (reason or "").strip():
		frappe.throw(_("A cancellation reason is required."))
	doc = _open_doc(order)
	doc.status = "Cancelled"
	doc.notes = (f"{doc.notes}\n" if doc.notes else "") + f"Cancelled: {reason.strip()[:200]}"
	for it in doc.items:
		if not it.voided and it.kot_status != "New":
			it.voided = 1
			it.void_reason = f"Order cancelled: {reason.strip()[:100]}"
			it.voided_by = frappe.session.user
	doc.save()
	_flag_cleaning_if_freed(doc)
	return {"ok": True, "status": "Cancelled"}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def close_order(order: str):
	"""Close a bill with nothing to collect: an NC bill, or one whose lines
	are all voided. Paid bills close in pay_order."""
	doc = _open_doc(order)
	doc.status = "Closed"
	doc.settled_by = frappe.session.user
	doc.save()  # guard_bill_close refuses an unsettled bill
	_flag_cleaning_if_freed(doc)
	return {"ok": True, "status": "Closed"}


# --------------------------------------------------------------- the till


def _parse_tenders(doc, mode: str | None, payments, tendered) -> tuple[list[dict], float]:
	if isinstance(payments, str):
		payments = frappe.parse_json(payments) if payments.strip() else None
	due = flt(doc.grand_total, 2)
	if payments:
		tenders = []
		for p in payments:
			m, amt = p.get("mode"), flt(p.get("amount"), 2)
			if m not in PAY_MODES:
				frappe.throw(_("Unknown payment mode {0}.").format(m))
			if amt <= 0:
				continue
			tenders.append({"mode": m, "amount": amt})
		if not tenders:
			frappe.throw(_("Enter at least one payment."))
	else:
		if mode not in PAY_MODES:
			frappe.throw(_("Pick a payment mode: {0}.").format(", ".join(PAY_MODES)))
		tenders = [{"mode": mode, "amount": due}]
	paid = flt(sum(t["amount"] for t in tenders), 2)
	cash = flt(sum(t["amount"] for t in tenders if t["mode"] == "Cash"), 2)
	change = 0.0
	if paid > due:
		# only cash can be over-tendered: the excess is change handed back
		change = flt(paid - due, 2)
		if change > cash + 0.001:
			frappe.throw(_("Card/UPI payments can't be more than the bill."))
		for t in tenders:
			if t["mode"] == "Cash":
				t["amount"] = flt(t["amount"] - change, 2)
				break
	elif abs(paid - due) > 0.009:
		frappe.throw(_("Payments add up to {0} but the bill is {1}.").format(paid, due))
	if tendered:
		change = max(change, flt(flt(tendered) - cash, 2))
	return [t for t in tenders if t["amount"] > 0], change


@frappe.whitelist(methods=["POST"])
@require_roles(*MONEY_ROLES)
def pay_order(order: str, mode: str | None = None, payments=None, pin: str | None = None,
              tendered: float | None = None):
	"""Settle a bill at the till and close it. One mode (`mode`) or a split
	(`payments=[{mode, amount}, ...]`). Each tender is posted into the
	cashier's open shift so the drawer reconciles at close."""
	doc = _open_doc(order)
	if doc.paid:
		frappe.throw(_("Already paid."))
	if doc.nc:
		frappe.throw(_("This is an NC (complimentary) bill - close it, there is nothing to collect."))
	if flt(doc.grand_total) <= 0:
		frappe.throw(_("Nothing to collect on this bill - close it instead."))
	require_cashier_pin(doc.restaurant, pin)
	from pep_restaurant.cashier import record_txn, session_for_payment

	sess = session_for_payment(doc.restaurant)
	tenders, change = _parse_tenders(doc, mode, payments, tendered)
	doc.paid = 1
	doc.payment_mode = tenders[0]["mode"] if len(tenders) == 1 else "Split"
	doc.payments_json = json.dumps(tenders)
	doc.paid_at = now()
	doc.settled_by = frappe.session.user
	doc.session = sess
	doc.status = "Closed"
	doc.save()
	for t in tenders:
		record_txn(doc.restaurant, "Payment", t["mode"], t["amount"], order=doc.name,
		           reference=f"Bill {doc.name}", session=sess)
	_flag_cleaning_if_freed(doc)
	return {"ok": True, "status": "Closed", "paid": True, "payment_mode": doc.payment_mode,
	        "tenders": tenders, "change": change, "grand_total": doc.grand_total}


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def bill_data(order: str):
	"""Everything the thermal bill needs: names, live lines, discount, service
	charge and the tax split the restaurant's way (CGST+SGST, one VAT line)."""
	from pep_restaurant.pep_restaurant.doctype.pep_restaurant.pep_restaurant import parse_tax_split

	doc = frappe.get_doc("Pep Order", order)
	rest = frappe.get_cached_doc("Pep Restaurant", doc.restaurant)
	outlet_name = frappe.db.get_value("Pep Outlet", doc.outlet, "outlet_name")
	split = parse_tax_split(rest.tax_split) or [(rest.tax_label or "Tax", 1.0)]
	return {
		"order": doc.name, "kot_no": doc.kot_no, "status": doc.status,
		"restaurant_name": rest.restaurant_name, "address": rest.address, "phone": rest.phone,
		"tax_id": rest.tax_id, "footer": rest.receipt_footer, "currency": rest.currency,
		"outlet_name": outlet_name, "order_type": doc.order_type, "table_no": doc.table_no,
		"label": _label(doc.as_dict()), "guests": doc.guests,
		"customer_name": doc.customer_name, "customer_phone": doc.customer_phone,
		"delivery_address": doc.delivery_address, "captain": doc.captain, "created": str(doc.creation),
		"items": [{"item_name": it.item_name, "qty": it.qty, "rate": it.rate, "amount": it.amount}
		          for it in doc.items if not it.voided],
		"subtotal": doc.subtotal, "discount_amount": doc.discount_amount,
		"discount_reason": doc.discount_reason,
		"service_charge_rate": doc.service_charge_rate, "service_charge": doc.service_charge,
		"taxable": doc.taxable_amount, "tax_label": rest.tax_label or "Tax", "tax_rate": doc.tax_rate,
		"prices_include_tax": doc.prices_include_tax,
		"tax_parts": [{"label": label.upper(), "rate": flt(flt(doc.tax_rate) * share, 3),
		               "amount": flt(flt(doc.tax_amount) * share, 2)} for label, share in split],
		"tax_amount": doc.tax_amount, "grand_total": doc.grand_total,
		"paid": doc.paid, "payment_mode": doc.payment_mode, "tenders": doc.tenders,
		"nc": doc.nc, "nc_authorized_by": doc.nc_authorized_by, "nc_note": doc.nc_note,
	}


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def recent_orders(outlet: str, limit: int = 15, search: str | None = None):
	"""The outlet's latest bills, newest first - open or settled - so a
	captain can jump back to a running bill or reprint a settled one."""
	filters = {"outlet": outlet}
	or_filters = None
	if search:
		like = f"%{search.strip()}%"
		or_filters = {"name": ("like", like), "table_no": ("like", like), "customer_name": ("like", like),
		              "customer_phone": ("like", like)}
	rows = frappe.get_all(
		"Pep Order", filters=filters, or_filters=or_filters,
		fields=["name", "status", "order_type", "table_no", "customer_name", "grand_total", "paid",
		        "payment_mode", "nc", "creation", "modified"],
		order_by="modified desc", limit=min(cint(limit) or 15, 50),
	)
	for r in rows:
		r["label"] = _label(r)
		r["open"] = r.status in OPEN
	return rows


# ----------------------------------------------------------- reservations


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def reservations(outlet: str, date: str | None = None):
	day = getdate(date) if date else getdate()
	return frappe.get_all(
		"Pep Table Reservation",
		filters={"outlet": outlet, "reserved_at": ("between", [f"{day} 00:00:00", f"{day} 23:59:59"])},
		fields=["name", "table_no", "guest_name", "phone", "party_size", "reserved_at", "status", "notes"],
		order_by="reserved_at asc",
	)


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def reserve_table(outlet: str, table_no: str, guest_name: str, reserved_at: str, phone: str | None = None,
                  party_size=None, notes: str | None = None):
	"""Reserve a table - it reads as Reserved on the map from a while before
	the time until it's seated, cancelled or marked a no-show."""
	if not (guest_name or "").strip():
		frappe.throw(_("Whose reservation is it?"))
	if not (table_no or "").strip():
		frappe.throw(_("Pick a table."))
	doc = frappe.get_doc({
		"doctype": "Pep Table Reservation", "outlet": outlet, "table_no": table_no.strip(),
		"guest_name": guest_name.strip()[:100], "phone": (phone or "").strip() or None,
		"party_size": cint(party_size) or None, "reserved_at": reserved_at,
		"notes": (notes or "").strip()[:200] or None,
	})
	doc.insert()
	return {"ok": True, "reservation": doc.name}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def set_reservation(reservation: str, status: str):
	if status not in ("Seated", "Cancelled", "No Show", "Booked"):
		frappe.throw(_("Status must be Seated, Cancelled, No Show or Booked."))
	doc = frappe.get_doc("Pep Table Reservation", reservation)
	doc.status = status
	doc.save()
	return {"ok": True, "status": status}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def mark_table_clean(outlet: str, table_no: str):
	frappe.cache.delete_value(_cleaning_key(outlet, table_no))
	return {"ok": True}


def expire_stale_reservations():
	"""Daily: a booking a day past its time that nobody seated is a no-show."""
	cutoff = add_to_date(now_datetime(), hours=-24)
	for name in frappe.get_all(
		"Pep Table Reservation", filters={"status": "Booked", "reserved_at": ("<", cutoff)}, pluck="name"
	):
		frappe.db.set_value("Pep Table Reservation", name, "status", "No Show")


# --------------------------------------------------------------- reports


@frappe.whitelist()
@require_roles(*MONEY_ROLES)
def outlet_dashboard(outlet: str, date: str | None = None, to_date: str | None = None):
	"""A shift (or a date range) at a glance: what sold, what's open, the
	exceptions a manager should see (NC, voids, cancels, discounts), tenders
	and how fast the kitchen turned tickets. Defaults to today."""
	day = getdate(date) if date else getdate()
	end_day = getdate(to_date) if to_date else day
	start, end = f"{day} 00:00:00", f"{end_day} 23:59:59"
	orders = frappe.get_all(
		"Pep Order",
		filters={"outlet": outlet, "creation": ("between", [start, end])},
		fields=["name", "status", "order_type", "table_no", "customer_name", "order_total", "subtotal",
		        "grand_total", "tax_amount", "service_charge", "discount_amount", "discount_reason", "paid",
		        "payment_mode", "payments_json", "nc", "nc_authorized_by", "nc_note", "guests", "notes",
		        "kot_no", "creation", "source"],
	)
	names = [o.name for o in orders]
	items = frappe.get_all(
		"Pep Order Item",
		filters={"parent": ("in", names), "parenttype": "Pep Order"},
		fields=["parent", "item_name", "qty", "rate", "voided", "void_reason", "voided_by", "fired_at",
		        "prepared_at", "kot_status"],
	) if names else []
	closed = [o for o in orders if o.status == "Closed"]
	sold = [o for o in closed if not o.nc and o.paid]
	open_bills = [o for o in orders if o.status in OPEN]
	cancelled = [o for o in orders if o.status == "Cancelled" and not (o.notes or "").count("Merged into")]
	nc_bills = [o for o in closed if o.nc]
	gross = sum(flt(o.grand_total) for o in sold)
	net = sum(flt(o.order_total) for o in sold)

	def bucket(rows, key):
		out: dict[str, dict] = {}
		for o in rows:
			b = out.setdefault(key(o) or "Other", {"bills": 0, "total": 0.0})
			b["bills"] += 1
			b["total"] += flt(o.grand_total)
		return [{"label": k, **v} for k, v in sorted(out.items(), key=lambda kv: -kv[1]["total"])]

	tenders: dict[str, float] = {}
	for o in sold:
		try:
			parts = json.loads(o.payments_json or "[]")
		except ValueError:
			parts = []
		for p in parts or [{"mode": o.payment_mode or "Other", "amount": o.grand_total}]:
			tenders[p["mode"]] = tenders.get(p["mode"], 0.0) + flt(p["amount"])

	sold_names = {o.name for o in sold}
	top: dict[str, dict] = {}
	for it in items:
		if it.parent not in sold_names or it.voided:
			continue
		t = top.setdefault(it.item_name, {"qty": 0.0, "amount": 0.0})
		t["qty"] += flt(it.qty)
		t["amount"] += flt(it.qty) * flt(it.rate)
	by_name = {o.name: o for o in orders}
	waits = []
	for it in items:
		if it.fired_at and it.prepared_at:
			secs = (get_datetime(it.prepared_at) - get_datetime(it.fired_at)).total_seconds()
			if secs >= 0:
				waits.append(secs)

	def cancel_reason(o) -> str | None:
		for line in reversed((o.notes or "").splitlines()):
			if line.startswith("Cancelled: "):
				return line[len("Cancelled: "):]
		return None

	return {
		"outlet": outlet, "date": str(day), "to_date": str(end_day),
		"gross_sales": flt(gross, 2), "net_sales": flt(net, 2),
		"tax": flt(sum(flt(o.tax_amount) for o in sold), 2),
		"service_charge": flt(sum(flt(o.service_charge) for o in sold), 2),
		"discounts": flt(sum(flt(o.discount_amount) for o in sold), 2),
		"bills": len(sold),
		"covers": sum(cint(o.guests) for o in closed),
		"avg_bill": flt(gross / len(sold), 2) if sold else 0,
		"by_order_type": bucket(sold, lambda o: o.order_type),
		"by_tender": [{"label": k, "total": flt(v, 2)} for k, v in sorted(tenders.items(), key=lambda kv: -kv[1])],
		"by_hour": _by_hour(sold),
		"open_bills": [{"name": o.name, "label": _label(o), "status": o.status, "grand_total": o.grand_total,
		                "kot_no": o.kot_no, "creation": str(o.creation)}
		               for o in sorted(open_bills, key=lambda o: o.creation)],
		"nc": {
			"count": len(nc_bills),
			# an NC bill totals zero; what it cost the house is its subtotal
			"value": flt(sum(flt(o.subtotal) for o in nc_bills), 2),
			"bills": [{"name": o.name, "label": _label(o), "subtotal": o.subtotal,
			           "authorized_by": o.nc_authorized_by, "note": o.nc_note} for o in nc_bills],
		},
		"discount_bills": [{"name": o.name, "label": _label(o), "amount": o.discount_amount,
		                    "reason": o.discount_reason} for o in sold if flt(o.discount_amount)],
		"voids": [{"order": it.parent, "label": _label(by_name.get(it.parent) or {"name": it.parent}),
		           "item_name": it.item_name, "qty": it.qty, "amount": flt(it.qty) * flt(it.rate),
		           "reason": it.void_reason, "by": it.voided_by, "after_fire": it.kot_status != "New"}
		          for it in items if it.voided and not (it.void_reason or "").startswith("Merged into")],
		"cancellations": [{"name": o.name, "label": _label(o), "subtotal": o.subtotal,
		                   "reason": cancel_reason(o)} for o in cancelled],
		"top_items": [{"item_name": k, **v} for k, v in sorted(top.items(), key=lambda kv: -kv[1]["qty"])][:10],
		"avg_fire_to_ready_mins": flt(sum(waits) / len(waits) / 60, 1) if waits else None,
		"qr_orders": sum(1 for o in orders if o.source == "QR"),
	}


def _by_hour(rows) -> list:
	hours: dict[int, float] = {}
	for o in rows:
		h = get_datetime(o.creation).hour
		hours[h] = hours.get(h, 0.0) + flt(o.grand_total)
	return [{"hour": h, "total": flt(v, 2)} for h, v in sorted(hours.items())]
