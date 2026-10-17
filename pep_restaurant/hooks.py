app_name = "pep_restaurant"
app_title = "Restaurant"
app_publisher = "Restaurant"
app_description = (
	"Standalone restaurant POS - table map, captain ordering, KOT and kitchen "
	"display, guest QR ordering, cash shifts, recipes and ingredient stock."
)
app_email = "ransbor82@gmail.com"
app_license = "agpl-3.0"
app_logo_url = "/assets/pep_restaurant/restaurant.svg"

add_to_apps_screen = [
	{
		"name": "pep_restaurant",
		"logo": "/assets/pep_restaurant/restaurant.svg",
		"title": "Restaurant",
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
	for doctype in ("Restaurant Order", "Restaurant Table Reservation", "Restaurant Menu Item")
}

# Restaurant-scoped doctypes: under site config `pep_strict_scope`, staff
# without a User Permission on Restaurant see none of them in Desk/REST.
_SCOPED = (
	"Restaurant Outlet", "Restaurant Menu Item", "Restaurant Order", "Restaurant Table Reservation",
	"Restaurant Ingredient", "Restaurant Ingredient Stock", "Restaurant Stock Ledger Entry",
	"Restaurant Cashier Session", "Restaurant Cashier Transaction", "Restaurant Accounting Settings",
)
permission_query_conditions = {dt: "pep_restaurant.permissions.query_conditions" for dt in _SCOPED}
has_permission = {dt: "pep_restaurant.permissions.has_permission" for dt in _SCOPED}

scheduler_events = {
	"daily": [
		"pep_restaurant.pos.expire_stale_reservations",
		"pep_restaurant.accounting.sweep",
	],
}
