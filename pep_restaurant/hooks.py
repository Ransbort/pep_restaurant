app_name = "pep_restaurant"
app_title = "Pep Restaurant"
app_publisher = "Pep Restaurant"
app_description = (
	"Standalone restaurant POS - table map, captain ordering, KOT and kitchen "
	"display, guest QR ordering, cash shifts, recipes and ingredient stock."
)
app_email = "ransbor82@gmail.com"
app_license = "agpl-3.0"
app_logo_url = "/assets/pep_restaurant/pep-mark.svg"

add_to_apps_screen = [
	{
		"name": "pep_restaurant",
		"logo": "/assets/pep_restaurant/pep-mark.svg",
		"title": "Pep Restaurant",
		"route": "/restaurant",
	}
]

# The React SPA owns everything under /restaurant (see www/restaurant.py).
website_route_rules = [
	{"from_route": "/restaurant/<path:app_path>", "to_route": "restaurant"},
]

after_install = "pep_restaurant.install.after_install"
after_migrate = ["pep_restaurant.install.after_migrate"]

# One tiny "something changed" ping per restaurant; screens re-fetch.
doc_events = {
	doctype: {
		"after_insert": "pep_restaurant.realtime.notify",
		"on_update": "pep_restaurant.realtime.notify",
		"on_trash": "pep_restaurant.realtime.notify",
	}
	for doctype in ("Pep Order", "Pep Table Reservation", "Pep Menu Item")
}

# Restaurant-scoped doctypes: under site config `pep_strict_scope`, staff
# without a User Permission on Pep Restaurant see none of them in Desk/REST.
_SCOPED = (
	"Pep Outlet", "Pep Menu Item", "Pep Order", "Pep Table Reservation",
	"Pep Ingredient", "Pep Ingredient Stock", "Pep Stock Ledger Entry",
	"Pep Cashier Session", "Pep Cashier Transaction",
)
permission_query_conditions = {dt: "pep_restaurant.permissions.query_conditions" for dt in _SCOPED}
has_permission = {dt: "pep_restaurant.permissions.has_permission" for dt in _SCOPED}

scheduler_events = {
	"daily": ["pep_restaurant.pos.expire_stale_reservations"],
}
