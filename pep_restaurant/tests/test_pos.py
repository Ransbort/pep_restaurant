"""End-to-end POS rules: money math, kitchen flow, stock, settlement.

bench --site <site> run-tests --app pep_restaurant
"""

import frappe
from frappe.utils import flt

try:
	from frappe.tests import IntegrationTestCase as TestCase
except ImportError:  # Frappe v14
	from frappe.tests.utils import FrappeTestCase as TestCase

from pep_restaurant import cashier, inventory, pos
from pep_restaurant.public_api import qr_order

REST = "_Test Restaurant"


def _ensure_user(email, role=None):
	if not frappe.db.exists("User", email):
		frappe.get_doc({"doctype": "User", "email": email, "first_name": email.split("@")[0],
		                "send_welcome_email": 0,
		                "roles": [{"role": role}] if role else []}).insert(ignore_permissions=True)
	return email


class TestPepPOS(TestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		from pep_restaurant.install import ensure_roles

		ensure_roles()
		if not frappe.db.exists("Restaurant", REST):
			frappe.get_doc({"doctype": "Restaurant", "restaurant_name": REST, "currency": "INR",
			                "tax_label": "GST", "tax_split": "CGST:50\nSGST:50",
			                "require_open_session": 1}).insert()
		cls.outlet = frappe.db.get_value("Restaurant Outlet", {"restaurant": REST, "outlet_name": "Test Hall"})
		if not cls.outlet:
			cls.outlet = frappe.get_doc({"doctype": "Restaurant Outlet", "restaurant": REST, "outlet_name": "Test Hall",
			                             "tax_rate": 5, "service_charge_rate": 10,
			                             "tables": "[Hall]\nT1:4\nT2:2"}).insert().name
		cls.paneer = frappe.get_doc({"doctype": "Restaurant Ingredient", "restaurant": REST,
		                             "ingredient_name": "Paneer", "uom": "kg", "cost_per_unit": 400}).insert().name
		cls.tikka = frappe.get_doc({"doctype": "Restaurant Menu Item", "outlet": cls.outlet, "item_name": "Tikka",
		                            "price": 300, "course": "Starter",
		                            "recipe": [{"ingredient": cls.paneer, "qty": 0.2}]}).insert().name
		cls.curry = frappe.get_doc({"doctype": "Restaurant Menu Item", "outlet": cls.outlet, "item_name": "Curry",
		                            "price": 200, "course": "Main"}).insert().name
		cls.cashier_user = _ensure_user("pep-cashier@example.com", "Restaurant Cashier")

	def tearDown(self):
		frappe.set_user("Administrator")

	def _order(self, **kw):
		items = kw.pop("items", [{"menu_item": self.tikka, "qty": 2}, {"menu_item": self.curry, "qty": 1}])
		return pos.create_order(outlet=self.outlet, items=items, table_no="T1", **kw)["order"]

	def _stock(self):
		return flt(frappe.db.get_value("Restaurant Ingredient Stock", f"{self.outlet}::{self.paneer}", "qty_on_hand"))

	def test_price_comes_from_menu_and_totals(self):
		name = self._order(items=[{"menu_item": self.tikka, "qty": 2, "rate": 1}])
		doc = frappe.get_doc("Restaurant Order", name)
		self.assertEqual(doc.items[0].rate, 300)  # the caller's rate is ignored
		self.assertEqual(doc.subtotal, 600)
		self.assertEqual(doc.service_charge, 60)  # 10% of net
		self.assertEqual(doc.tax_amount, 33)  # 5% of 660
		self.assertEqual(doc.grand_total, 693)
		pos.apply_discount(order=name, amount=100, reason="regular")
		doc.reload()
		self.assertEqual(doc.order_total, 500)
		self.assertEqual(doc.grand_total, flt((500 + 50) * 1.05, 2))

	def test_prices_include_tax(self):
		frappe.db.set_value("Restaurant", REST, "prices_include_tax", 1)
		try:
			name = self._order(items=[{"menu_item": self.curry, "qty": 1}])
			doc = frappe.get_doc("Restaurant Order", name)
			self.assertEqual(doc.grand_total, 220)  # 200 + 10% service, tax inside
			self.assertAlmostEqual(doc.tax_amount, flt(220 - 220 / 1.05, 2), places=2)
		finally:
			frappe.db.set_value("Restaurant", REST, "prices_include_tax", 0)

	def test_fire_deducts_stock_once_and_void_does_not_restore(self):
		before = self._stock()
		name = self._order()
		out = pos.fire_kot(order=name)
		self.assertEqual(out["kot_no"] > 0, True)
		self.assertAlmostEqual(self._stock(), before - 0.4, places=6)
		with self.assertRaises(frappe.ValidationError):
			pos.fire_kot(order=name)  # nothing new to send
		row = frappe.get_doc("Restaurant Order", name).items[0].name
		pos.void_item(order=name, item_row=row, reason="guest changed mind")
		self.assertAlmostEqual(self._stock(), before - 0.4, places=6)  # heat is irreversible

	def test_course_firing_holds_the_rest(self):
		name = self._order()
		pos.fire_kot(order=name, course="Starter")
		doc = frappe.get_doc("Restaurant Order", name)
		states = {it.item_name: it.kot_status for it in doc.items}
		self.assertEqual(states, {"Tikka": "Fired", "Curry": "New"})
		board = next(o for o in pos.kitchen_queue(restaurant=REST, outlet=self.outlet) if o["name"] == name)
		self.assertEqual(board["held_courses"], ["Main"])
		self.assertEqual({i["item_name"]: i["state"] for i in board["items"]}, {"Tikka": "cooking", "Curry": "held"})

	def test_split_does_not_double_deduct(self):
		before = self._stock()
		name = self._order()
		pos.fire_kot(order=name)
		row = next(it.name for it in frappe.get_doc("Restaurant Order", name).items if it.item_name == "Tikka")
		new = pos.split_order(order=name, item_rows=[row], table_no="T2")["new_order"]
		self.assertEqual(frappe.get_doc("Restaurant Order", new).items[0].stock_posted, 1)
		pos.add_items(order=new, items=[{"menu_item": self.curry, "qty": 1}])
		pos.fire_kot(order=new)
		self.assertAlmostEqual(self._stock(), before - 0.4, places=6)

	def test_bill_cannot_close_unsettled(self):
		name = self._order()
		with self.assertRaises(frappe.ValidationError):
			pos.close_order(order=name)
		with self.assertRaises(frappe.ValidationError):
			pos.mark_nc(order=name, authorized_by="")
		pos.mark_nc(order=name, authorized_by="GM", note="birthday")
		self.assertEqual(frappe.db.get_value("Restaurant Order", name, "grand_total"), 0)
		pos.close_order(order=name)
		self.assertEqual(frappe.db.get_value("Restaurant Order", name, "status"), "Closed")

	def test_payment_needs_shift_and_reconciles(self):
		name = self._order(items=[{"menu_item": self.curry, "qty": 1}])  # 200 + 20 + 11 = 231
		frappe.set_user(self.cashier_user)
		with self.assertRaises(frappe.ValidationError):
			pos.pay_order(order=name, mode="Cash")
		sess = cashier.open_session(restaurant=REST, opening_float=1000)["name"]
		out = pos.pay_order(order=name, payments=[{"mode": "Card", "amount": 100}, {"mode": "Cash", "amount": 200}])
		self.assertEqual(out["change"], 69)
		self.assertEqual(out["payment_mode"], "Split")
		s = frappe.get_doc("Restaurant Cashier Session", sess)
		self.assertEqual(s.system_card, 100)
		self.assertEqual(s.system_cash, 131)
		self.assertEqual(s.expected_cash, 1131)
		with self.assertRaises(frappe.ValidationError):
			cashier.close_session(session=sess, counted_cash=1100)  # variance needs a note
		closed = cashier.close_session(session=sess, counted_cash=1100, notes="short 31")
		self.assertEqual(closed["variance"], -31)

	def test_card_cannot_be_over_tendered(self):
		name = self._order(items=[{"menu_item": self.curry, "qty": 1}])
		with self.assertRaises(frappe.ValidationError):
			pos.pay_order(order=name, payments=[{"mode": "Card", "amount": 500}])

	def test_qr_order_must_be_confirmed(self):
		frappe.set_user("Guest")
		out = qr_order(outlet=self.outlet, items=[{"menu_item": self.curry, "qty": 1, "rate": 0}], table_no="T2")
		frappe.set_user("Administrator")
		doc = frappe.get_doc("Restaurant Order", out["order"])
		self.assertEqual((doc.source, doc.status, doc.items[0].rate), ("QR", "Placed", 200))
		with self.assertRaises(frappe.ValidationError):
			pos.fire_kot(order=doc.name)
		pos.confirm_order(order=doc.name)
		pos.fire_kot(order=doc.name)

	def test_table_map_and_merge(self):
		a = pos.create_order(outlet=self.outlet, items=[{"menu_item": self.tikka, "qty": 2},
		                     {"menu_item": self.curry, "qty": 1}], table_no="M1")["order"]
		b = pos.create_order(outlet=self.outlet, items=[{"menu_item": self.curry, "qty": 1}], table_no="M2")["order"]
		tiles = {t["table"]: t for t in pos.table_map(outlet=self.outlet)["tables"]}
		self.assertEqual(tiles["M1"]["state"], "running")  # ad-hoc table gets a live tile
		self.assertTrue(tiles["M1"]["temp"])
		pos.fire_kot(order=b)
		self.assertEqual({t["table"]: t for t in pos.table_map(outlet=self.outlet)["tables"]}["M2"]["state"], "fired")
		pos.merge_orders(order=b, into=a)
		self.assertEqual(frappe.db.get_value("Restaurant Order", b, "status"), "Cancelled")
		self.assertEqual(frappe.db.get_value("Restaurant Order", a, "subtotal"), 1000)

	def test_stock_take_needs_note(self):
		with self.assertRaises(frappe.ValidationError):
			inventory.adjust_stock(outlet=self.outlet, rows=[{"ingredient": self.paneer, "counted_qty": 5}], note="")
		out = inventory.adjust_stock(outlet=self.outlet, rows=[{"ingredient": self.paneer, "counted_qty": 5}],
		                             note="weekly count")
		self.assertEqual(self._stock(), 5)
		self.assertTrue(out["ok"])

	def test_role_gate(self):
		_ensure_user("pep-nobody@example.com")
		frappe.set_user("pep-nobody@example.com")
		with self.assertRaises(frappe.PermissionError):
			pos.table_map(outlet=self.outlet)

	def test_accent_colour(self):
		from pep_restaurant.api import set_accent

		self.assertEqual(set_accent(restaurant=REST, accent_color="0F8")["accent_color"], "#00ff88")
		with self.assertRaises(frappe.ValidationError):
			set_accent(restaurant=REST, accent_color="teal")
		frappe.set_user(self.cashier_user)
		with self.assertRaises(frappe.PermissionError):
			set_accent(restaurant=REST, accent_color="#000000")

	def test_kitchen_stations(self):
		from pep_restaurant import menu

		rest = frappe.get_doc("Restaurant", REST)
		rest.prep_stations = "Kitchen\nGrill\nPizza Oven\ngrill\n"
		rest.save()
		self.assertEqual(rest.prep_stations, "Kitchen\nGrill\nPizza Oven")  # deduped, trimmed
		dish = menu.save_menu_item(outlet=self.outlet, item_name="Margherita", price=400, prep_station="pizza oven")["name"]
		self.assertEqual(frappe.db.get_value("Restaurant Menu Item", dish, "prep_station"), "Pizza Oven")
		with self.assertRaises(frappe.ValidationError):
			menu.save_menu_item(outlet=self.outlet, item_name="Naan", price=60, prep_station="Tandoor")
		rest.reload()
		rest.prep_stations = "Kitchen\nGrill"  # Pizza Oven still has a dish
		with self.assertRaises(frappe.ValidationError):
			rest.save()

	def test_csv_import_excel_style(self):
		from pep_restaurant import menu

		out = menu.import_csv(outlet=self.outlet,
		                      csv_text="﻿item_name;price;category;prep_station;is_veg\nKulfi;90;Desserts;Kitchen;yes\n")
		self.assertEqual((out["created"] + out["updated"], out["errors"]), (1, []))
		self.assertEqual(frappe.db.get_value("Restaurant Menu Item", {"item_name": "Kulfi"}, "is_veg"), 1)

	def test_ingredient_import(self):
		from pep_restaurant.inventory import import_ingredients

		old = frappe.get_all("Restaurant Ingredient", {"restaurant": REST, "ingredient_name": ("like", "Imported %")},
		                     pluck="name")
		if old:  # rerun-safe: another test may have committed an earlier run's rows
			for t in ("Restaurant Stock Ledger Entry", "Restaurant Ingredient Stock"):
				frappe.db.delete(t, {"ingredient": ("in", old)})
			frappe.db.delete("Restaurant Ingredient", {"name": ("in", old)})
		csv_text = ("﻿ingredient_name;uom;category;cost_per_unit;opening_stock;par_level\n"
		            "Imported Rice;kgs;Dry;22;25;8\n"
		            "Imported Beer;Bottles;Bar;₵14;48;24\n"
		            "Bad Unit;barrel;Dry;1;;\n"
		            "Imported Rice;kg;Dry;23;;\n")
		with self.assertRaises(frappe.ValidationError):  # stock columns need an outlet
			import_ingredients(restaurant=REST, csv_text=csv_text)
		out = import_ingredients(restaurant=REST, csv_text=csv_text, outlet=self.outlet)
		self.assertEqual((out["created"], out["opening"]), (2, 2))
		self.assertEqual({e["item"] for e in out["errors"]}, {"Bad Unit", "Imported Rice"})  # bad unit + duplicate
		rice = frappe.db.get_value("Restaurant Ingredient", {"restaurant": REST, "ingredient_name": "Imported Rice"},
		                           ["name", "uom", "cost_per_unit"], as_dict=True)
		self.assertEqual((rice.uom, rice.cost_per_unit), ("kg", 22))
		beer = frappe.db.get_value("Restaurant Ingredient", {"restaurant": REST, "ingredient_name": "Imported Beer"}, "uom")
		self.assertEqual(beer, "bottle")
		stock = lambda: frappe.db.get_value("Restaurant Ingredient Stock", f"{self.outlet}::{rice.name}",  # noqa: E731
		                                   ["qty_on_hand", "par_level"])
		self.assertEqual(stock(), (25, 8))
		# re-importing the same file must not double the shelf
		again = import_ingredients(restaurant=REST, csv_text=csv_text, outlet=self.outlet)
		self.assertEqual((again["created"], again["updated"], again["opening"]), (0, 2, 0))
		self.assertEqual(len(again["notes"]), 2)
		self.assertEqual(stock(), (25, 8))
		# a unit can't change once stock is recorded in the old one
		bad = import_ingredients(restaurant=REST, csv_text="ingredient_name,uom\nImported Rice,g\n")
		self.assertEqual(len(bad["errors"]), 1)
		self.assertEqual(frappe.db.get_value("Restaurant Ingredient", rice.name, "uom"), "kg")

	def test_menu_import_downloads_photos(self):
		from unittest import mock

		from pep_restaurant import menu, remote_image

		png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
		                    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")

		class Resp:
			def __init__(self, status=200, ctype="image/png", body=png, location=None):
				self.status_code, self.headers = status, {"Content-Type": ctype}
				if location:
					self.headers["Location"] = location
				self.is_redirect, self._body = bool(location), body

			def iter_content(self, n):
				yield self._body

			def close(self):
				pass

		def fake_get(url, **kw):
			if "redirect" in url:
				return Resp(302, location="https://img.example.com/real.png")
			if "html" in url:
				return Resp(ctype="text/html", body=b"<html>")
			return Resp()

		public = [(2, 1, 6, "", ("93.184.216.34", 443))]
		csv_text = ("item_name,price,image,image_credit\n"
		            "Photo Dish,50,https://img.example.com/redirect.png?utm_source=x,\"Photo: A, CC BY 4.0\"\n"
		            "Not An Image,60,https://img.example.com/page.html,\n")
		with mock.patch("requests.get", side_effect=fake_get), mock.patch("socket.getaddrinfo", return_value=public):
			out = menu.import_csv(outlet=self.outlet, csv_text=csv_text)
		self.assertEqual((out["created"] + out["updated"], out["photos"], out["errors"]), (2, 1, []))
		self.assertEqual(len(out["notes"]), 1)  # the HTML link is a note; the dish still imports
		dish = frappe.db.get_value("Restaurant Menu Item", {"outlet": self.outlet, "item_name": "Photo Dish"},
		                           ["name", "image", "image_credit"], as_dict=True)
		self.assertTrue(dish.image.startswith("/files/"))
		self.assertEqual(dish.image_credit, "Photo: A, CC BY 4.0")
		self.assertTrue(frappe.db.exists("File", {"attached_to_name": dish.name, "file_url": dish.image}))
		self.assertFalse(frappe.db.get_value("Restaurant Menu Item", {"item_name": "Not An Image"}, "image"))
		# never fetch from the restaurant's own network
		with mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("192.168.1.10", 80))]):
			with self.assertRaises(frappe.ValidationError):
				remote_image.fetch("http://router.local/admin.png")
		with mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 80))]):
			with self.assertRaises(frappe.ValidationError):
				remote_image.fetch("http://localhost/x.png")

	def test_cashier_pin(self):
		from unittest.mock import patch

		from pep_restaurant import authz

		frappe.db.set_value("Restaurant", REST, {"require_cashier_pin": 1, "pin_max_attempts": 3, "pin_lock_minutes": 15})
		frappe.db.delete("Restaurant Cashier PIN", {"user": self.cashier_user})
		# a wrong PIN commits so the count survives the rollback; keep the test's data out of the db
		commit = patch.object(frappe.db, "commit")
		commit.start()
		try:
			frappe.set_user(self.cashier_user)
			frappe.cache.delete_value(authz._unlock_key(self.cashier_user))
			with self.assertRaisesRegex(frappe.ValidationError, "PIN_NOT_SET"):
				authz.require_cashier_pin(REST)
			authz.set_my_pin("4821")
			self.assertTrue(frappe.db.exists("Restaurant Cashier PIN", self.cashier_user))
			with self.assertRaisesRegex(frappe.ValidationError, "PIN_REQUIRED"):
				authz.require_cashier_pin(REST)
			with self.assertRaisesRegex(frappe.ValidationError, "Wrong cashier PIN"):
				authz.unlock(REST, "1111")
			self.assertEqual(authz.unlock(REST, "4821")["unlocked_minutes"], 15)
			authz.require_cashier_pin(REST)  # inside the unlock window: no PIN needed
			# changing the PIN needs the current one
			with self.assertRaisesRegex(frappe.ValidationError, "current PIN is wrong"):
				authz.set_my_pin("9999", current_pin="0000")
			authz.set_my_pin("9999", current_pin="4821")
			# three wrong tries lock the PIN, even the right one is refused then
			frappe.cache.delete_value(authz._unlock_key(self.cashier_user))
			for _ in range(2):
				with self.assertRaisesRegex(frappe.ValidationError, "Wrong cashier PIN"):
					authz.require_cashier_pin(REST, "1234")
			with self.assertRaisesRegex(frappe.ValidationError, "PIN_LOCKED"):
				authz.require_cashier_pin(REST, "1234")
			with self.assertRaisesRegex(frappe.ValidationError, "PIN_LOCKED"):
				authz.require_cashier_pin(REST, "9999")
			# a manager reset clears the lock and forces a new PIN
			frappe.set_user("Administrator")
			authz.reset_pin(self.cashier_user)
			frappe.set_user(self.cashier_user)
			with self.assertRaisesRegex(frappe.ValidationError, "PIN_MUST_RESET"):
				authz.require_cashier_pin(REST, "9999")
			authz.set_my_pin("5555")
			self.assertTrue(authz.unlock(REST, "5555")["ok"])
		finally:
			commit.stop()
			frappe.set_user("Administrator")
			frappe.cache.delete_value(authz._unlock_key(self.cashier_user))
			frappe.db.set_value("Restaurant", REST, "require_cashier_pin", 0)

	def test_rename_restaurant(self):
		from pep_restaurant import api

		for n in ("_Test Rename A", "_Test Rename B"):
			frappe.db.delete("Restaurant Outlet", {"restaurant": n})
			frappe.db.delete("Restaurant", {"name": n})
		frappe.get_doc({"doctype": "Restaurant", "restaurant_name": "_Test Rename A", "currency": "INR"}).insert()
		out = frappe.get_doc({"doctype": "Restaurant Outlet", "restaurant": "_Test Rename A",
		                      "outlet_name": "Rename Hall"}).insert().name
		r = api.save_restaurant(restaurant_name="_Test Rename B", name="_Test Rename A", currency="GHS")
		self.assertEqual(r["name"], "_Test Rename B")
		self.assertFalse(frappe.db.exists("Restaurant", "_Test Rename A"))
		doc = frappe.get_doc("Restaurant", "_Test Rename B")
		self.assertEqual((doc.restaurant_name, doc.currency), ("_Test Rename B", "GHS"))
		self.assertEqual(frappe.db.get_value("Restaurant Outlet", out, "restaurant"), "_Test Rename B")
		with self.assertRaisesRegex(frappe.ValidationError, "already a restaurant"):
			api.save_restaurant(restaurant_name=REST, name="_Test Rename B")
		with self.assertRaisesRegex(frappe.ValidationError, "isn't in the currency list"):
			api.save_restaurant(restaurant_name="_Test Rename B", name="_Test Rename B", currency="XYZ")
