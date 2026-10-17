"""Demo data: one restaurant, two outlets, a menu with recipes and stock.

bench --site <site> execute pep_restaurant.demo.seed
"""

import frappe

MENU = [
	# name, category, price, course, station, veg, alcohol, allergens, recipe
	("Paneer Tikka", "Starters", 320, "Starter", "Tandoor", 1, 0, "Dairy", [("Paneer", 0.18), ("Yogurt", 0.05)]),
	("Chicken Tikka", "Starters", 380, "Starter", "Tandoor", 0, 0, "Dairy", [("Chicken", 0.22), ("Yogurt", 0.05)]),
	("Masala Fries", "Starters", 180, "Starter", "Fryer", 1, 0, "", [("Potato", 0.25), ("Oil", 0.05)]),
	("Butter Chicken", "Mains", 450, "Main", "Kitchen", 0, 0, "Dairy, Nuts",
	 [("Chicken", 0.25), ("Butter", 0.03), ("Cream", 0.05), ("Tomato", 0.15)]),
	("Paneer Butter Masala", "Mains", 380, "Main", "Kitchen", 1, 0, "Dairy, Nuts",
	 [("Paneer", 0.2), ("Butter", 0.03), ("Cream", 0.05), ("Tomato", 0.15)]),
	("Dal Makhani", "Mains", 290, "Main", "Kitchen", 1, 0, "Dairy", [("Black Lentils", 0.1), ("Butter", 0.02), ("Cream", 0.03)]),
	("Butter Naan", "Breads", 70, "Main", "Tandoor", 1, 0, "Gluten, Dairy", [("Flour", 0.08), ("Butter", 0.01)]),
	("Jeera Rice", "Rice", 190, "Main", "Kitchen", 1, 0, "", [("Rice", 0.12)]),
	("Gulab Jamun", "Desserts", 140, "Dessert", "Cold", 1, 0, "Dairy, Gluten", []),
	("Masala Chai", "Beverages", 80, "Drink", "Bar", 1, 0, "Dairy", []),
	("Fresh Lime Soda", "Beverages", 110, "Drink", "Bar", 1, 0, "", []),
	("Kingfisher Beer", "Bar", 300, "Drink", "Bar", 1, 1, "Gluten", [("Beer Bottle", 1)]),
]
INGREDIENTS = [
	("Paneer", "Dairy", "kg", 380, 6), ("Yogurt", "Dairy", "kg", 90, 4), ("Butter", "Dairy", "kg", 520, 2),
	("Cream", "Dairy", "L", 260, 3), ("Chicken", "Meat", "kg", 260, 10), ("Potato", "Veg", "kg", 30, 15),
	("Tomato", "Veg", "kg", 40, 12), ("Oil", "Dry", "L", 150, 10), ("Black Lentils", "Dry", "kg", 140, 5),
	("Flour", "Dry", "kg", 45, 20), ("Rice", "Dry", "kg", 90, 15), ("Beer Bottle", "Bar", "bottle", 140, 48),
]


def seed(restaurant_name: str = "Pep Bistro"):
	if frappe.db.exists("Restaurant", restaurant_name):
		print(f"{restaurant_name} already exists - nothing to do")
		return
	frappe.get_doc({
		"doctype": "Restaurant", "restaurant_name": restaurant_name, "currency": "INR",
		"tax_label": "GST", "tax_split": "CGST:50\nSGST:50", "address": "12 MG Road, Bengaluru",
		"phone": "+91 80 1234 5678", "require_open_session": 1,
	}).insert(ignore_permissions=True)
	dining = frappe.get_doc({
		"doctype": "Restaurant Outlet", "restaurant": restaurant_name, "outlet_name": "Main Dining",
		"outlet_type": "Restaurant", "tax_rate": 5, "service_charge_rate": 0, "qr_ordering": 1,
		"tables": "[Main Hall]\nT1:2\nT2:2\nT3:4\nT4:4\nT5:6\n[Patio]\nP1:4\nP2:4\nP3:8",
	}).insert(ignore_permissions=True)
	bar = frappe.get_doc({
		"doctype": "Restaurant Outlet", "restaurant": restaurant_name, "outlet_name": "Rooftop Bar",
		"outlet_type": "Bar", "tax_rate": 18, "auto_kot": 1, "tables": "B1:2\nB2:2\nB3:4\nB4:4",
	}).insert(ignore_permissions=True)
	ing = {}
	for name, cat, uom, cost, opening in INGREDIENTS:
		d = frappe.get_doc({"doctype": "Restaurant Ingredient", "restaurant": restaurant_name, "ingredient_name": name,
		                    "category": cat, "uom": uom, "cost_per_unit": cost}).insert(ignore_permissions=True)
		ing[name] = (d.name, opening)
	for i, (name, cat, price, course, station, veg, alc, allergens, recipe) in enumerate(MENU):
		outlet = bar.name if cat == "Bar" else dining.name
		frappe.get_doc({
			"doctype": "Restaurant Menu Item", "outlet": outlet, "item_name": name, "category": cat, "price": price,
			"course": course, "prep_station": station, "is_veg": veg, "is_alcohol": alc, "allergens": allergens,
			"sort_order": i, "recipe": [{"ingredient": ing[r][0], "qty": q} for r, q in recipe],
		}).insert(ignore_permissions=True)
	from pep_restaurant.inventory import _apply_move

	for _name, (ing_name, opening) in ing.items():
		for outlet in (dining.name, bar.name):
			_apply_move(restaurant_name, outlet, ing_name, opening, "Opening", note="Demo opening stock")
	frappe.db.commit()
	print(f"Seeded {restaurant_name}: outlets {dining.name}, {bar.name}; {len(MENU)} dishes")
