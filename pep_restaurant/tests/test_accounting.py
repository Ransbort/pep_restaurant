"""Posting to ERPNext: exact money, GL accounts, idempotence, failure handling.

Runs only on a site with ERPNext and at least one company:
bench --site <erp-site> run-tests --app pep_restaurant --module pep_restaurant.tests.test_accounting
"""

import unittest

import frappe
from frappe.utils import flt, nowdate

try:
	from frappe.tests import IntegrationTestCase as TestCase
except ImportError:  # Frappe v14
	from frappe.tests.utils import FrappeTestCase as TestCase

from pep_restaurant import accounting, cashier, pos

REST = "_Test Pep Accounting"


def _erp_ready() -> bool:
	return "erpnext" in frappe.get_installed_apps() and bool(frappe.db.count("Company"))


def _account(name: str, company: str, abbr: str, parent_like: str, account_type: str = "Tax") -> str:
	full = f"{name} - {abbr}"
	if not frappe.db.exists("Account", full):
		parent = frappe.db.get_value("Account", {"company": company, "is_group": 1,
		                                         "account_name": ("like", f"%{parent_like}%")}, "name")
		frappe.get_doc({"doctype": "Account", "account_name": name, "parent_account": parent, "company": company,
		                "account_type": account_type}).insert(ignore_permissions=True)
	return full


@unittest.skipUnless(_erp_ready(), "needs ERPNext with a company")
class TestPepAccounting(TestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		from pep_restaurant.install import ensure_roles

		ensure_roles()
		cls.company = frappe.get_all("Company", pluck="name")[0]
		c = frappe.get_cached_value("Company", cls.company, ["abbr", "default_currency", "cost_center",
		                                                     "default_income_account"], as_dict=True)
		cls.abbr, cls.currency = c.abbr, c.default_currency
		cls.vat = _account("Test VAT", cls.company, c.abbr, "Duties and Taxes")
		cls.nhil = _account("Test NHIL", cls.company, c.abbr, "Duties and Taxes")
		cls.svc = _account("Test Service Charge", cls.company, c.abbr, "Direct Income", "Income Account")
		cls.momo_acct = _account("Test MoMo Wallet", cls.company, c.abbr, "Bank Accounts", "Bank")
		if not frappe.db.exists("Mode of Payment", "Test MoMo"):
			frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": "Test MoMo", "type": "Bank",
			                "accounts": [{"company": cls.company, "default_account": cls.momo_acct}]}
			               ).insert(ignore_permissions=True)
		accounting.quick_setup(restaurant=cls._restaurant(), company=cls.company)
		cls.outlet = frappe.db.get_value("Restaurant Outlet", {"restaurant": REST}) or frappe.get_doc({
			"doctype": "Restaurant Outlet", "restaurant": REST, "outlet_name": "Hall", "tax_rate": 20,
			"service_charge_rate": 10, "tables": "T1\nT2"}).insert().name
		cls.jollof = frappe.db.get_value("Restaurant Menu Item", {"outlet": cls.outlet, "item_name": "Jollof"}) or \
			frappe.get_doc({"doctype": "Restaurant Menu Item", "outlet": cls.outlet, "item_name": "Jollof",
			                "price": 120, "prep_station": "Kitchen"}).insert().name
		cls.sobolo = frappe.db.get_value("Restaurant Menu Item", {"outlet": cls.outlet, "item_name": "Sobolo"}) or \
			frappe.get_doc({"doctype": "Restaurant Menu Item", "outlet": cls.outlet, "item_name": "Sobolo",
			                "price": 25, "prep_station": "Bar"}).insert().name

	@classmethod
	def _restaurant(cls):
		if not frappe.db.exists("Restaurant", REST):
			frappe.get_doc({"doctype": "Restaurant", "restaurant_name": REST,
			                "currency": frappe.get_cached_value("Company", frappe.get_all("Company", pluck="name")[0],
			                                                    "default_currency"),
			                "tax_label": "VAT", "tax_split": "VAT:75\nNHIL:25", "require_open_session": 0}).insert()
		return REST

	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.set_value("Restaurant", REST, "prices_include_tax", 0)
		frappe.clear_document_cache("Restaurant", REST)

	def _settings(self, **kw):
		v = {
			"enabled": 1, "posting_mode": "Per bill", "start_from": nowdate(), "company": self.company,
			"customer": "Walk-in Customer", "item_mode": "Single item", "sales_item": "Restaurant Sales",
			"income_account": frappe.get_cached_value("Company", self.company, "default_income_account"),
			"cost_center": frappe.get_cached_value("Company", self.company, "cost_center"),
			"service_charge_account": self.svc, "default_tax_account": self.vat,
			"tax_accounts": [{"tax_label": "VAT", "account": self.vat}, {"tax_label": "NHIL", "account": self.nhil}],
			"payment_modes": [{"pep_mode": "Cash", "mode_of_payment": "Cash"},
			                  {"pep_mode": "Wallet", "mode_of_payment": "Test MoMo"}],
		}
		v.update(kw)
		accounting.save_settings(restaurant=REST, values=v)

	def _paid_bill(self, items, discount=0, **pay):
		o = pos.create_order(outlet=self.outlet, items=items, table_no="T1")["order"]
		pos.fire_kot(order=o)
		if discount:
			pos.apply_discount(order=o, amount=discount, reason="regular")
		pos.pay_order(order=o, **(pay or {"mode": "Cash"}))
		return frappe.get_doc("Restaurant Order", o)

	def _gl(self, invoice):
		rows = frappe.get_all("GL Entry", filters={"voucher_no": invoice, "is_cancelled": 0},
		                      fields=["account", "debit", "credit"])
		out = {}
		for r in rows:
			out[r.account] = flt(out.get(r.account, 0) + r.credit - r.debit, 2)
		return out

	def test_per_bill_exact_money_and_gl(self):
		self._settings()
		# 2 x 120 + 2 x 25 = 290; discount 20 -> 270; service 10% = 27; tax 20% of 297 = 59.40; total 356.40
		o = self._paid_bill([{"menu_item": self.jollof, "qty": 2}, {"menu_item": self.sobolo, "qty": 2}], discount=20,
		                    payments=[{"mode": "Cash", "amount": 200}, {"mode": "Wallet", "amount": 156.40}])
		self.assertEqual(o.grand_total, 356.40)
		self.assertEqual(o.erp_status, "Pending")
		inv = accounting.post_bill(o.name)
		self.assertTrue(inv, frappe.db.get_value("Restaurant Order", o.name, "erp_error"))
		si = frappe.get_doc("Sales Invoice", inv)
		self.assertEqual((si.docstatus, flt(si.grand_total, 2), flt(si.paid_amount, 2), flt(si.outstanding_amount, 2)),
		                 (1, 356.40, 356.40, 0))
		gl = self._gl(inv)
		income = frappe.get_cached_value("Company", self.company, "default_income_account")
		self.assertEqual(gl[income], 270)  # food after discount
		self.assertEqual(gl[self.svc], 27)
		self.assertEqual(gl[self.vat], 44.55)  # 75% of 59.40
		self.assertEqual(gl[self.nhil], 14.85)
		cash = frappe.get_cached_value("Company", self.company, "default_cash_account")
		self.assertEqual(gl[cash], -200)  # debit
		self.assertEqual(gl[self.momo_acct], -156.40)
		self.assertEqual(frappe.db.get_value("Restaurant Order", o.name, ["erp_status", "erp_invoice"]), ("Posted", inv))
		# idempotent: posting again returns the same invoice, no duplicate
		self.assertEqual(accounting.post_bill(o.name), inv)

	def test_per_shift_inclusive_tax_per_dish(self):
		frappe.db.set_value("Restaurant", REST, "prices_include_tax", 1)
		frappe.clear_document_cache("Restaurant", REST)
		self._settings(posting_mode="Per shift", item_mode="One item per dish")
		frappe.db.set_value("Restaurant", REST, "require_open_session", 1)
		sess = cashier.open_session(restaurant=REST, opening_float=100)["name"]
		try:
			a = self._paid_bill([{"menu_item": self.jollof, "qty": 3}], mode="Cash")
			b = self._paid_bill([{"menu_item": self.jollof, "qty": 1}, {"menu_item": self.sobolo, "qty": 1}],
			                    mode="Wallet")
			self.assertEqual(a.session, sess)
			cashier.close_session(session=sess, counted_cash=100 + a.grand_total)
		finally:
			frappe.db.set_value("Restaurant", REST, "require_open_session", 0)
		self.assertEqual(frappe.db.get_value("Restaurant Cashier Session", sess, "erp_status"), "Pending")
		inv = accounting.post_shift(sess)
		self.assertTrue(inv, frappe.db.get_value("Restaurant Cashier Session", sess, "erp_error"))
		si = frappe.get_doc("Sales Invoice", inv)
		self.assertEqual(flt(si.grand_total, 2), flt(a.grand_total + b.grand_total, 2))
		self.assertEqual(flt(si.paid_amount, 2), flt(si.grand_total, 2))
		# dishes become their own items; Jollof aggregates across the two bills
		qty: dict[str, float] = {}
		for it in si.items:
			qty[it.item_code] = qty.get(it.item_code, 0) + flt(it.qty)
		self.assertEqual(qty[f"PEP-{self.jollof}"], 4)
		self.assertEqual(qty[f"PEP-{self.sobolo}"], 1)
		# tax backed out of inclusive prices lands on the tax accounts exactly
		posted_tax = sum(flt(t.tax_amount) for t in si.taxes if t.account_head in (self.vat, self.nhil))
		self.assertAlmostEqual(posted_tax, flt(a.tax_amount + b.tax_amount, 2), places=2)
		self.assertEqual({frappe.db.get_value("Restaurant Order", n, "erp_invoice") for n in (a.name, b.name)}, {inv})
		self.assertEqual(frappe.db.get_value("Restaurant Cashier Session", sess, ["erp_status", "erp_invoice"]),
		                 ("Posted", inv))

	def test_nc_and_disabled_are_not_posted(self):
		self._settings(enabled=0)
		o = self._paid_bill([{"menu_item": self.sobolo, "qty": 1}])
		self.assertFalse(frappe.db.get_value("Restaurant Order", o.name, "erp_status"))
		self._settings()
		nc = pos.create_order(outlet=self.outlet, items=[{"menu_item": self.sobolo, "qty": 1}], table_no="T2")["order"]
		pos.mark_nc(order=nc, authorized_by="Manager")
		pos.close_order(order=nc)
		self.assertIsNone(accounting.post_bill(nc))
		self.assertEqual(frappe.db.get_value("Restaurant Order", nc, "erp_status"), "Skipped")

	def test_failure_is_recorded_and_retry_posts(self):
		self._settings()
		o = self._paid_bill([{"menu_item": self.sobolo, "qty": 2}], mode="Card")  # Card isn't mapped
		self.assertIsNone(accounting.post_bill(o.name))
		status, err = frappe.db.get_value("Restaurant Order", o.name, ["erp_status", "erp_error"])
		self.assertEqual(status, "Failed")
		self.assertIn("Card", err)
		self._settings(payment_modes=[{"pep_mode": "Cash", "mode_of_payment": "Cash"},
		                              {"pep_mode": "Card", "mode_of_payment": "Test MoMo"},
		                              {"pep_mode": "Wallet", "mode_of_payment": "Test MoMo"}])
		out = accounting.retry(restaurant=REST)
		self.assertTrue(out["posted"])
		self.assertEqual(frappe.db.get_value("Restaurant Order", o.name, "erp_status"), "Posted")

	def test_settings_validation(self):
		with self.assertRaises(frappe.ValidationError):
			self._settings(income_account=self.vat)  # a liability is not income
		with self.assertRaises(frappe.ValidationError):
			self._settings(payment_modes=[{"pep_mode": "Wallet", "mode_of_payment": "Test MoMo"}])  # no Cash

	def test_search_link(self):
		for i in range(3):
			if not frappe.db.exists("Customer", f"Zz Search {i}"):
				frappe.get_doc({"doctype": "Customer", "customer_name": f"Zz Search {i}", "customer_type": "Individual",
				                "customer_group": frappe.db.get_value("Customer Group", {"is_group": 0}),
				                "territory": frappe.db.get_value("Territory", {"is_group": 0})}).insert()
		hits = accounting.search_link(kind="customer", txt="walk")
		self.assertEqual(hits[0]["value"], "Walk-in Customer")  # found however many customers exist
		self.assertEqual(len(accounting.search_link(kind="customer", txt="Zz Search", limit=2)), 2)
		income = [h["value"] for h in accounting.search_link(kind="income_account", company=self.company)]
		self.assertTrue(income)
		self.assertTrue(all(frappe.db.get_value("Account", a, "root_type") == "Income" for a in income))
		self.assertNotIn(self.vat, [h["value"] for h in accounting.search_link(kind="income_account", txt="VAT",
		                                                                        company=self.company)])
		self.assertIn(self.vat, [h["value"] for h in accounting.search_link(kind="tax_account", txt="Test VAT",
		                                                                     company=self.company)])
		self.assertEqual(accounting.search_link(kind="income_account"), [])  # accounts need a company
		with self.assertRaises(frappe.ValidationError):
			accounting.search_link(kind="user")
