# Copyright (c) 2026, Pep Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PepOutlet(Document):
	def validate(self):
		from pep_restaurant.pos import parse_tables

		seen = set()
		for table, _seats, _area in parse_tables(self.tables):
			key = table.lower()
			if key in seen:
				frappe.throw(_("Table {0} is listed twice.").format(table))
			seen.add(key)
		for f in ("tax_rate", "service_charge_rate"):
			if (self.get(f) or 0) < 0 or (self.get(f) or 0) > 100:
				frappe.throw(_("{0} must be between 0 and 100.").format(self.meta.get_label(f)))
