# Copyright (c) 2026, Pep Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class PepAccountingSettings(Document):
	def validate(self):
		seen = set()
		for r in self.payment_modes:
			if r.pep_mode in seen:
				frappe.throw(_("{0} is mapped twice.").format(r.pep_mode))
			seen.add(r.pep_mode)
		if not self.enabled:
			return
		from pep_restaurant.accounting import validate_settings

		validate_settings(self)
		if "Cash" not in seen:
			frappe.throw(_("Map at least Cash to an ERPNext Mode of Payment."))
