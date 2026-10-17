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
	if frappe.db.exists("Module Def", "Pep Restaurant") and not frappe.db.exists("Module Def", "Restaurant"):
		frappe.rename_doc("Module Def", "Pep Restaurant", "Restaurant", force=True, show_alert=False)
	for old, new in RENAMES:
		if frappe.db.exists("DocType", old) and not frappe.db.exists("DocType", new):
			frappe.rename_doc("DocType", old, new, force=True, show_alert=False, rebuild_search=False)
	# the Item Group the ERPNext posting creates for dish items followed the old app name
	if frappe.db.exists("DocType", "Item Group") and frappe.db.exists("Item Group", "Pep Restaurant") \
			and not frappe.db.exists("Item Group", "Restaurant"):
		frappe.rename_doc("Item Group", "Pep Restaurant", "Restaurant", force=True, show_alert=False)
		if frappe.db.exists("DocType", "Restaurant Accounting Settings"):
			frappe.db.sql("update `tabRestaurant Accounting Settings` set item_group='Restaurant' where item_group='Pep Restaurant'")
	frappe.clear_cache()
