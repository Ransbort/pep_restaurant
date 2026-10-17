"""Kitchen stock: what a dish consumes, and what each outlet has left.

Ported from kamra.inventory. Three ideas hold it together:

1. HEAT IS IRREVERSIBLE. Ingredients leave the shelf when the chef starts
   cooking (fire_kot), not when the bill is paid. Nothing downstream puts
   them back - not a void, a cancel or a recall. A line voided after firing
   was cooked and binned: that is wastage, not a reversal.

2. A SHORT COUNT NEVER BLOCKS SERVICE. If the numbers say the paneer ran
   out, the chef still has paneer in hand and the ticket still fires. The
   balance goes negative and says so: "this count is stale, go recount".
   Do NOT clamp it.

3. THE RECIPE IS AN ESTIMATE. A chef's hand is not a scale, which is why
   adjust_stock() (the stock take) and last_counted_at exist.

Permissions: consume_for_lines() runs under a captain's session, which cannot
write stock by design. The writes in _apply_move() use ignore_permissions /
db.set_value on purpose: the authorization for consumption is the floor-role
gate on fire_kot, not doctype perms on the ledger.
"""

import uuid

import frappe
from frappe import _
from frappe.utils import cint, flt

from pep_restaurant.authz import INVENTORY_READ, INVENTORY_WRITE, assert_restaurant_access, require_roles

STATUS_OK, STATUS_LOW, STATUS_OUT, STATUS_NEGATIVE = "OK", "LOW", "OUT", "NEGATIVE"
_RANK = {STATUS_NEGATIVE: 0, STATUS_OUT: 1, STATUS_LOW: 2, STATUS_OK: 3}


def _status(qty: float, par: float) -> str:
	"""Derived on read, never stored - a stored status drifts."""
	if qty < 0:
		return STATUS_NEGATIVE
	if qty == 0:
		return STATUS_OUT
	if par and qty <= par:
		return STATUS_LOW
	return STATUS_OK


def _outlet_restaurant(outlet: str) -> str:
	r = frappe.db.get_value("Pep Outlet", outlet, "restaurant")
	if not r:
		frappe.throw(_("Unknown outlet {0}.").format(outlet))
	return r


def _check_ingredient(restaurant: str, ingredient: str):
	if frappe.db.get_value("Pep Ingredient", ingredient, "restaurant") != restaurant:
		frappe.throw(_("{0} is not an ingredient of this restaurant.").format(ingredient))


def _stock_row(restaurant: str, outlet: str, ingredient: str, for_update: bool = False) -> str:
	"""The (outlet, ingredient) balance row, created on first touch.

	The name is deterministic - "{outlet}::{ingredient}" - which makes the
	composite key the PRIMARY key, so the database refuses a duplicate rather
	than application code, where races live. Do not replace this with an
	exists()-then-insert or a validate() uniqueness check."""
	name = f"{outlet}::{ingredient}"
	if frappe.db.get_value("Pep Ingredient Stock", name, "name", for_update=for_update):
		return name
	try:
		doc = frappe.get_doc({
			"doctype": "Pep Ingredient Stock", "name": name, "restaurant": restaurant, "outlet": outlet,
			"ingredient": ingredient, "qty_on_hand": 0.0, "par_level": 0.0,
		})
		doc.flags.name_set = True
		doc.insert(ignore_permissions=True)
	except frappe.DuplicateEntryError:
		# someone created it between our read and our insert - lock theirs
		frappe.db.get_value("Pep Ingredient Stock", name, "name", for_update=True)
	return name


def _apply_move(restaurant: str, outlet: str, ingredient: str, qty_change: float, reason: str, *,
                ref_dt: str | None = None, ref_dn: str | None = None, note: str | None = None,
                supplier: str | None = None, invoice_no: str | None = None, batch_id: str | None = None,
                set_counted: bool = False) -> float:
	"""THE only writer of qty_on_hand. One move = one locked row + one ledger
	entry, in one transaction. The for_update lock stops a lost update (two
	chefs firing paneer in the same second both reading 10, both writing 8)."""
	name = _stock_row(restaurant, outlet, ingredient, for_update=True)
	current = flt(frappe.db.get_value("Pep Ingredient Stock", name, "qty_on_hand", for_update=True))
	after = current + flt(qty_change)
	frappe.db.set_value("Pep Ingredient Stock", name, "qty_on_hand", after, update_modified=False)
	if set_counted:
		frappe.db.set_value("Pep Ingredient Stock", name, {
			"last_counted_at": frappe.utils.now(), "last_counted_by": frappe.session.user,
		}, update_modified=False)
	frappe.get_doc({
		"doctype": "Pep Stock Ledger Entry", "restaurant": restaurant, "outlet": outlet,
		"ingredient": ingredient, "qty_change": flt(qty_change), "balance_after": after, "reason": reason,
		"reference_doctype": ref_dt, "reference_name": ref_dn, "note": note, "supplier": supplier,
		"invoice_no": invoice_no, "batch_id": batch_id,
		"cost_per_unit": frappe.db.get_value("Pep Ingredient", ingredient, "cost_per_unit"),
	}).insert(ignore_permissions=True)
	return after


def _recipes_of(menu_items) -> dict:
	"""menu_item -> [(ingredient, qty_per_unit), ...] in one query."""
	ids = [m for m in menu_items if m]
	if not ids:
		return {}
	out: dict[str, list] = {}
	for r in frappe.get_all(
		"Pep Menu Item Ingredient", filters={"parent": ("in", ids), "parenttype": "Pep Menu Item"},
		fields=["parent", "ingredient", "qty"], order_by="idx asc",
	):
		out.setdefault(r.parent, []).append((r.ingredient, flt(r.qty)))
	return out


def consume_for_lines(order, lines) -> list:
	"""Take a fired order's recipes off its outlet's stock. Called from
	fire_kot with the lines it just fired - never from a doc hook, because
	split_order inserts NEW orders whose lines are already Fired; a hook keyed
	on "fired and not posted" would deduct twice for every split bill.

	Idempotent per line via stock_posted. What does NOT move stock: create /
	add (nothing left the shelf), voids (fired = binned, new = never taken),
	recall (Prepared -> Fired, never -> New), cancel, payment, NC (a comped
	dish consumed real food), recipe edits (history is never rewritten). The
	genuinely-not-cooked case is fixed by a human with adjust_stock."""
	todo = [it for it in lines if not it.get("stock_posted")]
	if not todo:
		return []
	recipes = _recipes_of({it["menu_item"] for it in todo})
	need: dict[str, float] = {}
	for it in todo:
		for ing, per in recipes.get(it["menu_item"], ()):
			need[ing] = need.get(ing, 0.0) + per * flt(it.get("qty") or 1)
	alerts = []
	# SORTED IS A DEADLOCK GUARD: a global lock order means two tickets that
	# share ingredients wait for each other instead of deadlocking mid-service.
	for ing in sorted(need):
		after = _apply_move(order.restaurant, order.outlet, ing, -need[ing], "Consumed",
		                    ref_dt="Pep Order", ref_dn=order.name, note=f"KOT {order.kot_no or '-'}")
		if after <= 0:
			alerts.append({
				"ingredient": ing,
				"ingredient_name": frappe.db.get_value("Pep Ingredient", ing, "ingredient_name"),
				"qty_on_hand": after,
				"level": STATUS_NEGATIVE.lower() if after < 0 else STATUS_OUT.lower(),
			})
	# stamp after every move landed - same transaction, so they roll back together
	for it in todo:
		frappe.db.set_value("Pep Order Item", it["row"], "stock_posted", 1, update_modified=False)
	return alerts


# ---------------------------------------------------------------- recipes


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def ingredients(restaurant: str, active_only: int = 1):
	filters = {"restaurant": restaurant}
	if cint(active_only):
		filters["is_active"] = 1
	return frappe.get_all(
		"Pep Ingredient", filters=filters,
		fields=["name", "ingredient_name", "uom", "category", "cost_per_unit", "is_active"],
		order_by="ingredient_name asc",
	)


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def menu_recipe(menu_item: str):
	"""One dish's recipe with each line's unit, cost and what the dish's
	outlet has on hand right now."""
	mi = frappe.db.get_value("Pep Menu Item", menu_item, ["item_name", "restaurant", "outlet", "price"],
	                         as_dict=True)
	if not mi:
		frappe.throw(_("Menu item not found."))
	rows = frappe.get_all(
		"Pep Menu Item Ingredient", filters={"parent": menu_item, "parenttype": "Pep Menu Item"},
		fields=["name", "ingredient", "qty", "note"], order_by="idx asc",
	)
	cost = 0.0
	for r in rows:
		meta = frappe.db.get_value("Pep Ingredient", r.ingredient, ["ingredient_name", "uom", "cost_per_unit"],
		                           as_dict=True) or {}
		r.update(meta)
		r["line_cost"] = flt(r.qty) * flt(meta.get("cost_per_unit"))
		cost += r["line_cost"]
		r["qty_on_hand"] = frappe.db.get_value("Pep Ingredient Stock", f"{mi.outlet}::{r.ingredient}", "qty_on_hand")
	return {"menu_item": menu_item, "item_name": mi.item_name, "outlet": mi.outlet,
	        "restaurant": mi.restaurant, "price": mi.price, "food_cost": flt(cost, 2),
	        "food_cost_pct": flt(cost / flt(mi.price) * 100, 1) if flt(mi.price) else None, "recipe": rows}


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def recipe_overview(restaurant: str):
	"""Every dish, whether it has a recipe yet, and its food cost."""
	dishes = frappe.get_all(
		"Pep Menu Item", filters={"restaurant": restaurant},
		fields=["name", "item_name", "outlet", "category", "available", "price"],
		order_by="outlet asc, category asc, item_name asc",
	)
	if not dishes:
		return []
	costs = {i.name: flt(i.cost_per_unit) for i in frappe.get_all(
		"Pep Ingredient", filters={"restaurant": restaurant}, fields=["name", "cost_per_unit"])}
	lines: dict[str, int] = {}
	cost: dict[str, float] = {}
	for r in frappe.get_all(
		"Pep Menu Item Ingredient",
		filters={"parent": ("in", [d.name for d in dishes]), "parenttype": "Pep Menu Item"},
		fields=["parent", "ingredient", "qty"],
	):
		lines[r.parent] = lines.get(r.parent, 0) + 1
		cost[r.parent] = cost.get(r.parent, 0.0) + flt(r.qty) * costs.get(r.ingredient, 0)
	outlet_names = dict(frappe.get_all("Pep Outlet", filters={"restaurant": restaurant},
	                                   fields=["name", "outlet_name"], as_list=True))
	for d in dishes:
		d["lines"] = lines.get(d.name, 0)
		d["food_cost"] = flt(cost.get(d.name, 0), 2)
		d["food_cost_pct"] = flt(d["food_cost"] / flt(d.price) * 100, 1) if flt(d.price) and d["lines"] else None
		d["outlet_name"] = outlet_names.get(d.outlet)
	return dishes


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def save_recipe(menu_item: str, rows):
	"""Replace a dish's recipe wholesale. An empty list is valid: "this dish
	never touches inventory"."""
	if isinstance(rows, str):
		rows = frappe.parse_json(rows)
	doc = frappe.get_doc("Pep Menu Item", menu_item)
	clean = []
	for r in rows or []:
		if not r.get("ingredient"):
			continue
		clean.append({"ingredient": r["ingredient"], "qty": flt(r.get("qty")), "note": r.get("note") or None})
	doc.set("recipe", clean)
	doc.save()  # the controller validates qty > 0, duplicates and restaurant
	return {"ok": True, "lines": len(clean)}


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE, scope={"name": "Pep Ingredient"})
def save_ingredient(restaurant: str, ingredient_name: str, uom: str, category: str | None = None,
                    cost_per_unit: float = 0, is_active: int = 1, name: str | None = None):
	if not (ingredient_name or "").strip():
		frappe.throw(_("An ingredient needs a name."))
	doc = frappe.get_doc("Pep Ingredient", name) if name else frappe.new_doc("Pep Ingredient")
	if name and doc.restaurant != restaurant:
		frappe.throw(_("That ingredient belongs to another restaurant."))
	doc.update({
		"restaurant": restaurant, "ingredient_name": ingredient_name.strip(), "uom": uom,
		"category": (category or "").strip() or None, "cost_per_unit": flt(cost_per_unit),
		"is_active": cint(is_active),
	})
	doc.save()
	return {"ok": True, "name": doc.name}


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE, scope={"name": "Pep Ingredient"})
def delete_ingredient(name: str):
	"""Refuse if it is on a recipe or has history - deactivate instead."""
	used = frappe.db.count("Pep Menu Item Ingredient", {"ingredient": name})
	if used:
		frappe.throw(_("{0} dish(es) use this ingredient. Deactivate it instead.").format(used))
	if frappe.db.count("Pep Stock Ledger Entry", {"ingredient": name}):
		frappe.throw(_("This ingredient has stock history. Deactivate it instead."))
	for s in frappe.get_all("Pep Ingredient Stock", filters={"ingredient": name}, pluck="name"):
		frappe.delete_doc("Pep Ingredient Stock", s, ignore_permissions=True)
	frappe.delete_doc("Pep Ingredient", name)
	return {"ok": True}


# ------------------------------------------------------------ stock moves


def _rows(rows) -> list:
	if isinstance(rows, str):
		rows = frappe.parse_json(rows)
	return rows or []


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def receive_stock(outlet: str, rows, supplier: str | None = None, invoice_no: str | None = None):
	"""Goods in. rows = [{ingredient, qty, cost_per_unit?}]. One batch_id ties
	the delivery together - a receipt is its ledger rows plus a supplier."""
	restaurant = _outlet_restaurant(outlet)
	rows = _rows(rows)
	if not rows:
		frappe.throw(_("Nothing to receive."))
	batch = uuid.uuid4().hex[:12]
	out = []
	for r in rows:
		qty = flt(r.get("qty"))
		if qty <= 0:
			frappe.throw(_("Received quantity must be above zero."))
		ing = r["ingredient"]
		_check_ingredient(restaurant, ing)
		if r.get("cost_per_unit") not in (None, ""):
			# the price we actually paid becomes the price we value waste at
			frappe.db.set_value("Pep Ingredient", ing, "cost_per_unit", flt(r["cost_per_unit"]))
		after = _apply_move(restaurant, outlet, ing, qty, "Received", supplier=supplier, invoice_no=invoice_no,
		                    batch_id=batch, note=r.get("note"))
		out.append({"ingredient": ing, "qty_on_hand": after})
	return {"ok": True, "batch_id": batch, "rows": out}


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def adjust_stock(outlet: str, rows, note: str):
	"""The stock take. rows = [{ingredient, counted_qty}] - COUNTS, not deltas:
	a human reports what is on the shelf and the system works out its own
	error. The note is required: a write-off with no reason is exactly the
	silence this module exists to remove."""
	restaurant = _outlet_restaurant(outlet)
	rows = _rows(rows)
	if not (note or "").strip():
		frappe.throw(_("A stock take needs a note - what did you count, and why does it differ?"))
	if not rows:
		frappe.throw(_("Nothing counted."))
	batch = uuid.uuid4().hex[:12]
	out = []
	for r in rows:
		ing = r["ingredient"]
		_check_ingredient(restaurant, ing)
		counted = flt(r.get("counted_qty"))
		name = _stock_row(restaurant, outlet, ing)
		current = flt(frappe.db.get_value("Pep Ingredient Stock", name, "qty_on_hand"))
		delta = counted - current
		if abs(delta) < 1e-9:
			frappe.db.set_value("Pep Ingredient Stock", name, {
				"last_counted_at": frappe.utils.now(), "last_counted_by": frappe.session.user,
			}, update_modified=False)
			continue
		after = _apply_move(restaurant, outlet, ing, delta, "Count", note=note.strip()[:500], batch_id=batch,
		                    set_counted=True)
		out.append({"ingredient": ing, "was": current, "now": after, "variance": delta})
	return {"ok": True, "batch_id": batch, "adjusted": out}


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def record_wastage(outlet: str, ingredient: str, qty: float, reason_note: str):
	"""Stock destroyed OUTSIDE a sale (a crate rots, a bottle breaks). Not for
	food cooked then voided - that already has its Consumed row; see
	wastage_report()."""
	restaurant = _outlet_restaurant(outlet)
	_check_ingredient(restaurant, ingredient)
	qty = flt(qty)
	if qty <= 0:
		frappe.throw(_("Wasted quantity must be above zero."))
	if not (reason_note or "").strip():
		frappe.throw(_("Wastage needs a reason."))
	after = _apply_move(restaurant, outlet, ingredient, -qty, "Wastage", note=reason_note.strip()[:500])
	return {"ok": True, "qty_on_hand": after}


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def set_par_level(outlet: str, ingredient: str, par_level: float):
	"""Where LOW starts for this ingredient at this outlet. Zero = no par."""
	restaurant = _outlet_restaurant(outlet)
	_check_ingredient(restaurant, ingredient)
	name = _stock_row(restaurant, outlet, ingredient)
	frappe.db.set_value("Pep Ingredient Stock", name, "par_level", max(flt(par_level), 0), update_modified=False)
	return {"ok": True}


# ----------------------------------------------------------------- reads


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def stock_list(outlet: str, status: str | None = None):
	"""Everything this outlet holds - including active ingredients never yet
	moved here (shown at zero), so a first goods-in has rows to fill."""
	restaurant = _outlet_restaurant(outlet)
	rows = {r.ingredient: r for r in frappe.get_all(
		"Pep Ingredient Stock", filters={"outlet": outlet},
		fields=["name", "ingredient", "qty_on_hand", "par_level", "last_counted_at", "last_counted_by"])}
	out = []
	for ing in frappe.get_all(
		"Pep Ingredient", filters={"restaurant": restaurant},
		fields=["name", "ingredient_name", "uom", "category", "cost_per_unit", "is_active"],
	):
		r = rows.get(ing.name)
		if not r and not ing.is_active:
			continue
		row = {"ingredient": ing.name, "qty_on_hand": flt(r.qty_on_hand) if r else 0.0,
		       "par_level": flt(r.par_level) if r else 0.0,
		       "last_counted_at": r.last_counted_at if r else None,
		       "last_counted_by": r.last_counted_by if r else None,
		       "ingredient_name": ing.ingredient_name, "uom": ing.uom, "category": ing.category,
		       "cost_per_unit": ing.cost_per_unit, "is_active": ing.is_active}
		row["status"] = _status(row["qty_on_hand"], row["par_level"])
		row["value"] = flt(max(row["qty_on_hand"], 0) * flt(ing.cost_per_unit), 2)
		if status and row["status"] != status:
			continue
		out.append(row)
	out.sort(key=lambda r: (_RANK[r["status"]], r.get("ingredient_name") or ""))
	return out


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def ingredient_ledger(outlet: str, ingredient: str, limit: int = 50):
	"""Where did my paneer go? Newest first, each row with the balance it left."""
	return frappe.get_all(
		"Pep Stock Ledger Entry", filters={"outlet": outlet, "ingredient": ingredient},
		fields=["name", "creation", "qty_change", "balance_after", "reason", "reference_doctype",
		        "reference_name", "note", "supplier", "invoice_no", "cost_per_unit", "owner"],
		order_by="creation desc", limit=min(cint(limit) or 50, 500),
	)


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def low_stock(restaurant: str, outlet: str | None = None):
	"""Everything at/under par, out or negative - and the dishes each takes
	down with it. We flag and offer; a human decides. Nothing auto-86s."""
	filters = {"restaurant": restaurant}
	if outlet:
		filters["outlet"] = outlet
	out = []
	for r in frappe.get_all("Pep Ingredient Stock", filters=filters,
	                        fields=["outlet", "ingredient", "qty_on_hand", "par_level", "last_counted_at"]):
		st = _status(flt(r.qty_on_hand), flt(r.par_level))
		if st == STATUS_OK:
			continue
		r.update(frappe.db.get_value("Pep Ingredient", r.ingredient, ["ingredient_name", "uom"], as_dict=True) or {})
		r["status"] = st
		uses = frappe.get_all("Pep Menu Item Ingredient",
		                      filters={"ingredient": r.ingredient, "parenttype": "Pep Menu Item"}, pluck="parent")
		r["dishes"] = frappe.get_all("Pep Menu Item", filters={"name": ("in", uses), "outlet": r.outlet},
		                             fields=["name", "item_name", "available"]) if uses else []
		out.append(r)
	out.sort(key=lambda r: _RANK[r["status"]])
	return out


@frappe.whitelist()
@require_roles(*INVENTORY_READ)
def wastage_report(restaurant: str, outlet: str | None = None, days: int = 30):
	"""Food cooked then binned (lines voided after they fired), valued at
	recipe cost - derived, because the Consumed row is already the truth -
	plus stock written off outside a sale (Wastage rows)."""
	assert_restaurant_access(restaurant)
	conds = ["p.restaurant = %(restaurant)s", "i.voided = 1", "i.stock_posted = 1",
	         "p.creation >= DATE_SUB(NOW(), INTERVAL %(days)s DAY)",
	         "coalesce(i.void_reason, '') not like 'Merged into%%'"]
	params = {"restaurant": restaurant, "days": cint(days) or 30}
	if outlet:
		conds.append("p.outlet = %(outlet)s")
		params["outlet"] = outlet
	lines = frappe.db.sql(
		"""select i.item_name, i.menu_item, i.qty, i.void_reason, p.outlet, p.name as order_name, p.creation
		     from `tabPep Order Item` i join `tabPep Order` p on p.name = i.parent
		    where """ + " and ".join(conds) + " order by p.creation desc",
		params, as_dict=True,
	)
	recipes = _recipes_of({r.menu_item for r in lines})
	costs: dict[str, float] = {}
	total = 0.0
	by_reason: dict[str, float] = {}
	for r in lines:
		value = 0.0
		for ing, per in recipes.get(r.menu_item, ()):
			if ing not in costs:
				costs[ing] = flt(frappe.db.get_value("Pep Ingredient", ing, "cost_per_unit"))
			value += per * flt(r.qty) * costs[ing]
		r["value"] = flt(value, 2)
		total += value
		key = (r.void_reason or "no reason given").strip()
		by_reason[key] = by_reason.get(key, 0.0) + value
	wfilters = {"restaurant": restaurant, "reason": "Wastage",
	            "creation": (">=", frappe.utils.add_days(frappe.utils.nowdate(), -(cint(days) or 30)))}
	if outlet:
		wfilters["outlet"] = outlet
	written = frappe.get_all("Pep Stock Ledger Entry", filters=wfilters,
	                         fields=["ingredient", "qty_change", "cost_per_unit", "note", "creation", "outlet"],
	                         order_by="creation desc")
	for w in written:
		w["ingredient_name"] = frappe.db.get_value("Pep Ingredient", w.ingredient, "ingredient_name")
		w["value"] = flt(abs(flt(w.qty_change)) * flt(w.cost_per_unit), 2)
	return {
		"lines": lines,
		"by_reason": sorted(({"reason": k, "value": flt(v, 2)} for k, v in by_reason.items()),
		                    key=lambda x: -x["value"]),
		"total_value": flt(total, 2),
		"written_off": written,
		"written_off_value": flt(sum(w["value"] for w in written), 2),
	}


# ----------------------------------------------------------------- import

UOMS = ("kg", "g", "L", "ml", "pc", "bottle", "packet", "dozen")
_UOM_ALIASES = {
	"kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg",
	"gm": "g", "gms": "g", "gram": "g", "grams": "g",
	"l": "L", "lt": "L", "ltr": "L", "litre": "L", "litres": "L", "liter": "L", "liters": "L",
	"millilitre": "ml", "milliliter": "ml", "mls": "ml",
	"pcs": "pc", "piece": "pc", "pieces": "pc", "each": "pc", "unit": "pc", "units": "pc", "nos": "pc",
	"bottles": "bottle", "btl": "bottle", "packets": "packet", "pack": "packet", "packs": "packet", "pkt": "packet",
	"doz": "dozen", "dozens": "dozen",
}


def _uom(v: str) -> str:
	s = (v or "").strip()
	if not s:
		return "kg"
	for u in UOMS:
		if s.lower() == u.lower():
			return u
	if s.lower() in _UOM_ALIASES:
		return _UOM_ALIASES[s.lower()]
	frappe.throw(_("Unit \"{0}\" isn't one of: {1}.").format(s, ", ".join(UOMS)))


@frappe.whitelist(methods=["POST"])
@require_roles(*INVENTORY_WRITE)
def import_ingredients(restaurant: str, csv_text: str, outlet: str | None = None, update_existing: int = 1):
	"""Bulk-create ingredients from CSV: ingredient_name (required), uom,
	category, cost_per_unit, is_active - and, for the chosen outlet,
	opening_stock and par_level.

	Opening stock is only ever the FIRST balance: an ingredient that already
	has stock history at the outlet keeps it (re-importing the same file must
	not double the shelf), and the row says so. Counting existing stock is a
	stock take, which keeps the note and the variance."""
	from pep_restaurant.csvutil import number, read_csv, yes

	if outlet and frappe.db.get_value("Pep Outlet", outlet, "restaurant") != restaurant:
		frappe.throw(_("That outlet belongs to another restaurant."))
	headers, rows = read_csv(csv_text)
	if "ingredient_name" not in headers and "name" in headers:
		rows = [(i, {**r, "ingredient_name": r.get("name", "")}) for i, r in rows]
		headers["ingredient_name"] = headers["name"]
	if "ingredient_name" not in headers:
		frappe.throw(_("The CSV needs an ingredient_name column."))
	wants_stock = bool({"opening_stock", "par_level"} & set(headers))
	if wants_stock and not outlet:
		frappe.throw(_("Pick the outlet the opening stock and par levels belong to."))
	created = updated = opening = 0
	errors, notes = [], []
	batch = uuid.uuid4().hex[:12]
	seen = set()
	for line, r in rows:
		name = (r.get("ingredient_name") or "").strip()[:140]
		if not name:
			continue
		if name.lower() in seen:
			errors.append({"line": line, "item": name, "error": _("Listed twice in this file.")})
			continue
		seen.add(name.lower())
		frappe.db.savepoint("pep_ing_row")
		try:
			existing = frappe.db.get_value("Pep Ingredient", {"restaurant": restaurant, "ingredient_name": name})
			if existing and not cint(update_existing) and not wants_stock:
				continue
			cost = number(r.get("cost_per_unit"), "cost_per_unit")
			qty = number(r.get("opening_stock"), "opening_stock")
			par = number(r.get("par_level"), "par_level")
			if (qty is not None and qty < 0) or (par is not None and par < 0) or (cost is not None and cost < 0):
				frappe.throw(_("Quantities and costs can't be negative."))
			if not existing or cint(update_existing):
				doc = frappe.get_doc("Pep Ingredient", existing) if existing else frappe.new_doc("Pep Ingredient")
				doc.restaurant = restaurant
				doc.ingredient_name = name
				if not existing or r.get("uom"):
					if existing and _uom(r.get("uom")) != doc.uom and frappe.db.count(
							"Pep Stock Ledger Entry", {"ingredient": existing}):
						frappe.throw(_("Can't change the unit from {0} to {1}: this ingredient already has stock "
						               "history in {0}.").format(doc.uom, _uom(r.get("uom"))))
					doc.uom = _uom(r.get("uom"))
				if r.get("category") or not existing:
					doc.category = r.get("category") or None
				if cost is not None:
					doc.cost_per_unit = cost
				if r.get("is_active") or not existing:
					doc.is_active = yes(r.get("is_active")) if r.get("is_active") else 1
				doc.save()
				ing = doc.name
				created += 0 if existing else 1
				updated += 1 if existing else 0
			else:
				ing = existing
			if outlet and qty:
				if frappe.db.count("Pep Stock Ledger Entry", {"outlet": outlet, "ingredient": ing}):
					notes.append({"line": line, "item": name,
					              "note": _("already has stock here - opening stock skipped (use a stock take)")})
				else:
					_apply_move(restaurant, outlet, ing, qty, "Opening", batch_id=batch, note=_("Imported opening stock"))
					opening += 1
			if outlet and par is not None:
				set_par_level(outlet=outlet, ingredient=ing, par_level=par)
		except Exception as e:
			frappe.db.rollback(save_point="pep_ing_row")
			frappe.clear_last_message()
			errors.append({"line": line, "item": name, "error": str(e)[:200]})
	return {"ok": True, "created": created, "updated": updated, "opening": opening,
	        "errors": errors, "notes": notes}
