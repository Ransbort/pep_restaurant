"""bench --site <site> execute pep_restaurant.tests.smoke.run  (after demo.seed)"""
import frappe


def run():
	from pep_restaurant import api, cashier, inventory, menu, pos, public_api
	frappe.set_user("Administrator")
	b = api.boot()
	r = b["restaurants"][0]
	o = r["outlets"][0]["name"]
	rest = r["name"]
	m = pos.pos_menu(outlet=o)
	first = m["categories"][0]["items"][0]["name"]
	order = pos.create_order(outlet=o, items=[{"menu_item": first, "qty": 2}], table_no="T3", guests=3)["order"]
	pos.fire_kot(order=order)
	pos.mark_prepared(order=order)
	print("bill", pos.bill_data(order=order)["tax_parts"])
	pos.pay_order(order=order, mode="Card")
	print("dash", {k: v for k, v in pos.outlet_dashboard(outlet=o).items() if k in ("gross_sales", "bills", "covers")})
	print("recipes", len(inventory.recipe_overview(restaurant=rest)))
	print("stock", len(inventory.stock_list(outlet=o)), "low", len(inventory.low_stock(restaurant=rest)))
	print("waste", inventory.wastage_report(restaurant=rest)["total_value"])
	print("menu", len(menu.menu_items(outlet=o)))
	print("csv", menu.import_csv(outlet=o, csv_text="item_name,price,category,is_veg\nSamosa,60,Starters,yes\n"))
	print("qr", len(public_api.qr_menu(outlet=o)["categories"]))
	print("sessions", cashier.list_sessions(restaurant=rest))
	print("res", pos.reserve_table(outlet=o, table_no="T5", guest_name="Asha", reserved_at=frappe.utils.now()))
	print("map", [t["state"] for t in pos.table_map(outlet=o)["tables"]])
	print("kq", len(pos.kitchen_queue(restaurant=rest)))
	frappe.db.rollback()
