# Copyright (c) 2026, Pep Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class PepTableReservation(Document):
	def validate(self):
		self.restaurant = frappe.db.get_value("Pep Outlet", self.outlet, "restaurant")
