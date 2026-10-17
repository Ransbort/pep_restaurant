"""Menu admin: the dishes an outlet sells, 86-ing, and bulk CSV import."""

import csv
import io

import frappe
from frappe import _
from frappe.utils import cint, flt

from pep_restaurant.authz import FLOOR_ROLES, KITCHEN_ROLES, require_roles
from pep_restaurant.remote_image import attach_to_dish, is_url

FIELDS = ("item_name", "category", "price", "course", "prep_station", "is_veg", "is_alcohol", "available",
          "allergens", "description", "image", "image_credit", "sort_order")
COURSES = ("Starter", "Main", "Dessert", "Drink")


@frappe.whitelist()
@require_roles(*FLOOR_ROLES, *KITCHEN_ROLES)
def menu_items(outlet: str, include_unavailable: int = 1):
	filters = {"outlet": outlet}
	if not cint(include_unavailable):
		filters["available"] = 1
	return frappe.get_all("Pep Menu Item", filters=filters, fields=["name", "outlet", *FIELDS],
	                      order_by="category asc, sort_order asc, item_name asc")


@frappe.whitelist(methods=["POST"])
@require_roles(scope={"name": "Pep Menu Item"})
def save_menu_item(outlet: str, item_name: str, price: float, name: str | None = None, **fields):
	"""Create or update a dish. Unknown keys are ignored."""
	if not (item_name or "").strip():
		frappe.throw(_("A dish needs a name."))
	doc = frappe.get_doc("Pep Menu Item", name) if name else frappe.new_doc("Pep Menu Item")
	doc.outlet = outlet
	doc.item_name = item_name.strip()[:140]
	doc.price = flt(price)
	for k in FIELDS:
		if k in fields and k not in ("item_name", "price"):
			v = fields[k]
			if k in ("is_veg", "is_alcohol", "available", "sort_order"):
				v = cint(v)
			elif k == "course" and v not in COURSES:
				v = "Main"
			elif isinstance(v, str):
				v = v.strip() or None
			doc.set(k, v)
	doc.save()
	return {"ok": True, "name": doc.name}


@frappe.whitelist(methods=["POST"])
@require_roles(scope={"name": "Pep Menu Item"})
def delete_menu_item(name: str):
	"""A dish that has been sold is part of bill history - hide it instead."""
	if frappe.db.count("Pep Order Item", {"menu_item": name}):
		frappe.throw(_("This dish is on past bills. Mark it unavailable instead."))
	frappe.delete_doc("Pep Menu Item", name)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles(*KITCHEN_ROLES)
def set_availability(menu_item: str, available: int):
	"""86 a dish, or put it back. The ONLY thing that ever pulls an item off
	the menu for stock reasons - and a human presses it. Nothing auto-86s on
	a zero balance: the count is the least trustworthy number in the building."""
	frappe.db.set_value("Pep Menu Item", menu_item, "available", 1 if cint(available) else 0)
	doc = frappe.get_doc("Pep Menu Item", menu_item)
	doc.run_method("on_update")  # realtime ping so tills refresh
	return {"ok": True, "available": doc.available}


@frappe.whitelist(methods=["POST"])
@require_roles()
def import_csv(outlet: str, csv_text: str, update_existing: int = 1):
	"""Paste a menu: a header row with at least item_name and price, and any of
	category, course, prep_station, is_veg, is_alcohol, allergens, description.
	Existing dishes (same name, same outlet) are updated when update_existing."""
	text = (csv_text or "").lstrip("\ufeff").strip()  # Excel's UTF-8 BOM
	first = text.splitlines()[0] if text else ""
	# Excel in many locales saves "CSV" with semicolons
	delimiter = ";" if first.count(";") > first.count(",") else ","
	reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
	if not reader.fieldnames:
		frappe.throw(_("Paste a CSV with a header row."))
	headers = {h.strip().lower().replace(" ", "_"): h for h in reader.fieldnames if h}
	if "item_name" not in headers and "name" in headers:
		headers["item_name"] = headers["name"]
	if "item_name" not in headers or "price" not in headers:
		frappe.throw(_("The CSV needs item_name and price columns."))
	created = updated = photos = 0
	errors, notes = [], []
	for i, raw in enumerate(reader, start=2):
		row = {k: (raw.get(src) or "").strip() for k, src in headers.items()}
		if not row.get("item_name"):
			continue
		try:
			price = flt(str(row["price"]).replace(",", ""))
			existing = frappe.db.get_value("Pep Menu Item", {"outlet": outlet, "item_name": row["item_name"]})
			if existing and not cint(update_existing):
				continue
			extra = {k: row[k] for k in FIELDS if k in row and row[k] != "" and k not in ("item_name", "price")}
			image_url = extra.pop("image") if is_url(extra.get("image")) else None
			for b in ("is_veg", "is_alcohol", "available"):
				if b in extra:
					extra[b] = 1 if str(extra[b]).lower() in ("1", "y", "yes", "true", "veg") else 0
			dish = save_menu_item(outlet=outlet, item_name=row["item_name"], price=price, name=existing, **extra)["name"]
			updated += 1 if existing else 0
			created += 0 if existing else 1
			if image_url:
				# the dish is saved either way; a photo that won't download is a note, not a failed row
				frappe.db.savepoint("pep_img")
				try:
					attach_to_dish(dish, image_url)
					photos += 1
				except Exception as e:
					frappe.db.rollback(save_point="pep_img")
					frappe.clear_last_message()
					notes.append({"line": i, "item": row.get("item_name"), "note": f"photo not added: {str(e)[:160]}"})
		except Exception as e:
			frappe.clear_last_message()
			errors.append({"line": i, "item": row.get("item_name"), "error": str(e)[:200]})
	return {"ok": True, "created": created, "updated": updated, "photos": photos, "errors": errors, "notes": notes}
