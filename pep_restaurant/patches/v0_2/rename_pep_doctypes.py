"""Rename the app's doctypes from "Pep …" to "Restaurant …" on sites that
were installed before the rename, keeping every record.

Runs before model sync: frappe.rename_doc renames each table, rewrites every
Link and Dynamic Link that points at the old name (orders -> outlets, files
attached to dishes, user permissions on the restaurant, version history), and
the sync that follows then updates the renamed doctypes from the new JSON.
A fresh install has nothing to rename and skips straight through."""

import frappe

RENAMES = (
	("Pep Restaurant", "Restaurant"),
	("Pep Outlet", "Restaurant Outlet"),
	("Pep Menu Item", "Restaurant Menu Item"),
	("Pep Menu Item Ingredient", "Restaurant Menu Item Ingredient"),
	("Pep Order", "Restaurant Order"),
	("Pep Order Item", "Restaurant Order Item"),
	("Pep Table Reservation", "Restaurant Table Reservation"),
	("Pep Ingredient", "Restaurant Ingredient"),
	("Pep Ingredient Stock", "Restaurant Ingredient Stock"),
	("Pep Stock Ledger Entry", "Restaurant Stock Ledger Entry"),
	("Pep Cashier Session", "Restaurant Cashier Session"),
	("Pep Cashier Transaction", "Restaurant Cashier Transaction"),
	("Pep Cashier PIN", "Restaurant Cashier PIN"),
	("Pep Accounting Settings", "Restaurant Accounting Settings"),
	("Pep Tax Account", "Restaurant Tax Account"),
	("Pep Payment Mode Map", "Restaurant Payment Mode Map"),
)


def execute():
	for old, new in RENAMES:
		if frappe.db.exists("DocType", old) and not frappe.db.exists("DocType", new):
			frappe.rename_doc("DocType", old, new, force=True, show_alert=False, rebuild_search=False)
	# the Item Group the ERPNext posting creates for dish items followed the old app name
	if frappe.db.exists("DocType", "Item Group") and frappe.db.exists("Item Group", "Pep Restaurant") \
			and not frappe.db.exists("Item Group", "Restaurant"):
		frappe.rename_doc("Item Group", "Pep Restaurant", "Restaurant", force=True, show_alert=False)
		if frappe.db.exists("DocType", "Restaurant Accounting Settings"):
			frappe.db.sql("update `tabRestaurant Accounting Settings` set item_group='Restaurant' where item_group='Pep Restaurant'")
	_move_module("Pep Restaurant", "Restaurant")
	frappe.clear_cache()
	# the module map migrate loaded at start still says pep_restaurant.pep_restaurant;
	# rebuild it from modules.txt or the model sync that follows can't import it
	frappe.setup_module_map()


def _move_module(old, new):
	"""Frappe won't rename an app's Module Def, so repoint everything that
	names the old module (DocTypes, Reports, Workspaces, Pages…) by hand and
	drop it. Migrate may already have created the new one from modules.txt."""
	if not frappe.db.exists("Module Def", old):
		return
	if not frappe.db.exists("Module Def", new):
		frappe.get_doc({"doctype": "Module Def", "module_name": new, "app_name": "pep_restaurant"}).db_insert()
	links = frappe.get_all("DocField", filters={"fieldtype": "Link", "options": "Module Def"},
	                       fields=["parent", "fieldname"])
	links += frappe.get_all("Custom Field", filters={"fieldtype": "Link", "options": "Module Def"},
	                        fields=["dt as parent", "fieldname"])
	for row in links:
		meta = frappe.get_meta(row.parent)
		if meta.issingle or meta.is_virtual or not frappe.db.table_exists(row.parent):
			continue
		frappe.db.sql(f"update `tab{row.parent}` set `{row.fieldname}`=%s where `{row.fieldname}`=%s", (new, old))
	frappe.db.delete("Module Def", {"name": old})
