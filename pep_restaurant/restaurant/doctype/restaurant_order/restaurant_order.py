# Copyright (c) 2026, Restaurant and contributors
# For license information, please see license.txt

import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt

OPEN_STATUSES = ("Placed", "Confirmed", "Preparing")


class RestaurantOrder(Document):
	def before_insert(self):
		outlet = frappe.db.get_value(
			"Restaurant Outlet", self.outlet, ["restaurant", "tax_rate", "service_charge_rate"], as_dict=True
		)
		if not outlet:
			frappe.throw(_("Unknown outlet {0}.").format(self.outlet))
		self.restaurant = outlet.restaurant
		# rates are snapshotted when the bill opens: a manager editing the
		# outlet's tax mid-shift must not re-price bills already running
		# (split_order copies the source bill's rates and sets keep_rates)
		if not self.flags.keep_rates:
			self.tax_rate = flt(outlet.tax_rate)
			self.service_charge_rate = flt(outlet.service_charge_rate)
			self.prices_include_tax = int(
				frappe.db.get_value("Restaurant", self.restaurant, "prices_include_tax") or 0
			)

	def validate(self):
		self.compute_totals()
		self.guard_bill_close()

	def compute_totals(self):
		"""The one place bill money is computed. Lines are priced from the menu
		when they are added (pos._load_items) - never from the caller."""
		subtotal = 0.0
		for it in self.items:
			it.amount = 0.0 if it.voided else flt(it.qty or 1) * flt(it.rate)
			subtotal += it.amount
		self.subtotal = flt(subtotal, 2)
		self.discount_amount = min(max(flt(self.discount_amount), 0.0), self.subtotal)
		if self.nc:
			# NC (no charge): the items stand for the kitchen and the audit,
			# the bill is zero
			self.order_total = self.service_charge = self.taxable_amount = 0.0
			self.tax_amount = self.grand_total = 0.0
			return
		net = flt(self.subtotal - self.discount_amount, 2)
		self.order_total = net
		self.service_charge = flt(net * flt(self.service_charge_rate) / 100, 2)
		gross = net + self.service_charge
		rate = flt(self.tax_rate)
		if self.prices_include_tax:
			self.taxable_amount = flt(gross / (1 + rate / 100), 2) if rate else gross
			self.tax_amount = flt(gross - self.taxable_amount, 2)
			self.grand_total = flt(gross, 2)
		else:
			self.taxable_amount = flt(gross, 2)
			self.tax_amount = flt(gross * rate / 100, 2)
			self.grand_total = flt(gross + self.tax_amount, 2)

	def guard_bill_close(self):
		"""Closed means the BILL is closed, not that food left the pass (the
		kitchen tracks that per line). A bill closes only when it is:

		- paid at the till (pos.pay_order), or
		- complimentary (NC) with who authorized it, or
		- empty - every line voided, nothing to charge.

		Anything else was food served with nothing billed and nothing paid."""
		if self.status != "Closed":
			return
		previous = self.get_doc_before_save()
		if previous and previous.status == "Closed":
			return
		if self.paid:
			if not self.payment_mode:
				frappe.throw(_("A paid bill needs its payment mode."))
			return
		if self.nc:
			if not (self.nc_authorized_by or "").strip():
				frappe.throw(_("An NC (complimentary) bill needs who authorized it before it can close."))
			return
		if not any(not it.voided for it in self.items):
			return
		frappe.throw(_("This bill is not settled. Take payment, or mark it NC with an authorization, before closing it."))

	@property
	def tenders(self) -> list:
		try:
			return json.loads(self.payments_json or "[]")
		except ValueError:
			return []
