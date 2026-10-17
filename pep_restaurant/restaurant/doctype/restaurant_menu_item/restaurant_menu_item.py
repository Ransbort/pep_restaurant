# Copyright (c) 2026, Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class RestaurantMenuItem(Document):
	def validate(self):
		self.restaurant = frappe.db.get_value("Restaurant Outlet", self.outlet, "restaurant")
		from pep_restaurant.restaurant.doctype.restaurant.restaurant import parse_stations

		stations = parse_stations(frappe.db.get_value("Restaurant", self.restaurant, "prep_stations"))
		match = next((s for s in stations if s.lower() == (self.prep_station or "").strip().lower()), None)
		if not (self.prep_station or "").strip():
			match = stations[0]
		if not match:
			frappe.throw(_("{0} isn't one of this restaurant's kitchen stations ({1}). Add it in Setup, or pick another.")
			             .format(self.prep_station, ", ".join(stations)))
		self.prep_station = match
		if (self.price or 0) < 0:
			frappe.throw(_("Price cannot be negative."))
		seen = set()
		for row in self.recipe:
			if (row.qty or 0) <= 0:
				frappe.throw(_("Every recipe line needs a quantity above zero."))
			if row.ingredient in seen:
				frappe.throw(_("{0} is on the recipe twice - put it on one line.").format(row.ingredient))
			seen.add(row.ingredient)
			if frappe.db.get_value("Restaurant Ingredient", row.ingredient, "restaurant") != self.restaurant:
				frappe.throw(_("{0} belongs to another restaurant.").format(row.ingredient))
