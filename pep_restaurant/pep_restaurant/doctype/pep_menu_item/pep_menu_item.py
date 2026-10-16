# Copyright (c) 2026, Pep Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PepMenuItem(Document):
	def validate(self):
		self.restaurant = frappe.db.get_value("Pep Outlet", self.outlet, "restaurant")
		if (self.price or 0) < 0:
			frappe.throw(_("Price cannot be negative."))
		seen = set()
		for row in self.recipe:
			if (row.qty or 0) <= 0:
				frappe.throw(_("Every recipe line needs a quantity above zero."))
			if row.ingredient in seen:
				frappe.throw(_("{0} is on the recipe twice - put it on one line.").format(row.ingredient))
			seen.add(row.ingredient)
			if frappe.db.get_value("Pep Ingredient", row.ingredient, "restaurant") != self.restaurant:
				frappe.throw(_("{0} belongs to another restaurant.").format(row.ingredient))
