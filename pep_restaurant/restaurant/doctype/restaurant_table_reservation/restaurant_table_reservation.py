# Copyright (c) 2026, Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class RestaurantTableReservation(Document):
	def validate(self):
		self.restaurant = frappe.db.get_value("Restaurant Outlet", self.outlet, "restaurant")
