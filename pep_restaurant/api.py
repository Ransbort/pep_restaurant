"""Boot + setup endpoints for the SPA."""

import frappe
from frappe import _
from frappe.utils import cint, flt

from pep_restaurant.authz import ALL_ROLES, is_admin, require_roles, restricted_restaurants


@frappe.whitelist(allow_guest=True)
def whoami():
	user = frappe.session.user
	if user == "Guest":
		return {"user": "Guest", "full_name": "Guest", "roles": []}
	roles = frappe.get_roles(user)
	return {
		"user": user,
		"full_name": frappe.utils.get_fullname(user),
		"roles": [r for r in roles if r in (*ALL_ROLES, "System Manager", "Administrator")],
		"is_admin": is_admin(user),
	}


@frappe.whitelist()
@require_roles(*ALL_ROLES)
def boot():
	"""The restaurants (and their outlets) this user may work in."""
	allowed = restricted_restaurants()
	filters = {"disabled": 0}
	if allowed is not None:
		filters["name"] = ("in", list(allowed) or [""])
	rests = frappe.get_all(
		"Pep Restaurant", filters=filters,
		fields=["name", "restaurant_name", "currency", "tax_label", "prices_include_tax", "require_cashier_pin",
		        "require_open_session", "logo", "accent_color", "prep_stations"],
		order_by="restaurant_name asc",
	)
	outlets = frappe.get_all(
		"Pep Outlet", filters={"restaurant": ("in", [r.name for r in rests] or [""]), "disabled": 0},
		fields=["name", "restaurant", "outlet_name", "outlet_type", "tax_rate", "service_charge_rate", "auto_kot",
		        "qr_ordering"],
		order_by="outlet_name asc",
	)
	symbols = {c.name: c.symbol for c in frappe.get_all(
		"Currency", filters={"name": ("in", list({r.currency for r in rests}) or [""])}, fields=["name", "symbol"])}
	from pep_restaurant.pep_restaurant.doctype.pep_restaurant.pep_restaurant import parse_stations

	for r in rests:
		r["prep_stations"] = parse_stations(r.prep_stations)
		r["currency_symbol"] = symbols.get(r.currency) or r.currency
		r["outlets"] = [o for o in outlets if o.restaurant == r.name]
	return {"restaurants": rests, "can_setup": is_admin()}


# ------------------------------------------------------------------ setup

RESTAURANT_FIELDS = ("currency", "phone", "email", "address", "tax_id", "tax_label", "tax_split",
                     "prices_include_tax", "require_open_session", "require_cashier_pin", "pin_max_attempts",
                     "pin_lock_minutes", "reservation_before_min", "reservation_after_min", "receipt_footer",
                     "disabled", "logo", "accent_color", "prep_stations")
OUTLET_FIELDS = ("outlet_type", "tax_rate", "service_charge_rate", "auto_kot", "qr_ordering", "tables", "disabled")
CHECKS = {"prices_include_tax", "require_open_session", "require_cashier_pin", "disabled", "auto_kot", "qr_ordering"}
INTS = {"pin_max_attempts", "pin_lock_minutes", "reservation_before_min", "reservation_after_min"}
FLOATS = {"tax_rate", "service_charge_rate"}


def _coerce(k, v):
	if k in CHECKS:
		return cint(v)
	if k in INTS:
		return cint(v)
	if k in FLOATS:
		return flt(v)
	return v.strip() if isinstance(v, str) else v


@frappe.whitelist()
@require_roles()
def get_restaurant(restaurant: str):
	return frappe.get_doc("Pep Restaurant", restaurant).as_dict()


@frappe.whitelist(methods=["POST"])
@require_roles()
def save_restaurant(restaurant_name: str, name: str | None = None, **fields):
	if name:
		doc = frappe.get_doc("Pep Restaurant", name)
	else:
		if not (restaurant_name or "").strip():
			frappe.throw(_("A restaurant needs a name."))
		doc = frappe.new_doc("Pep Restaurant")
		doc.restaurant_name = restaurant_name.strip()
	for k in RESTAURANT_FIELDS:
		if k in fields:
			doc.set(k, _coerce(k, fields[k]))
	doc.save()
	return {"ok": True, "name": doc.name}


@frappe.whitelist()
@require_roles()
def get_outlet(outlet: str):
	return frappe.get_doc("Pep Outlet", outlet).as_dict()


@frappe.whitelist(methods=["POST"])
@require_roles(scope={"name": "Pep Outlet"})
def save_outlet(restaurant: str, outlet_name: str, name: str | None = None, **fields):
	if not (outlet_name or "").strip():
		frappe.throw(_("An outlet needs a name."))
	doc = frappe.get_doc("Pep Outlet", name) if name else frappe.new_doc("Pep Outlet")
	if name and doc.restaurant != restaurant:
		frappe.throw(_("That outlet belongs to another restaurant."))
	doc.restaurant = restaurant
	doc.outlet_name = outlet_name.strip()[:140]
	for k in OUTLET_FIELDS:
		if k in fields:
			doc.set(k, _coerce(k, fields[k]))
	doc.save()
	return {"ok": True, "name": doc.name}


@frappe.whitelist()
@require_roles()
def qr_targets(restaurant: str):
	"""Each outlet's tables, for the printable QR sheet. The codes are drawn
	in the browser - no QR web service sees these links."""
	from pep_restaurant.pos import parse_tables

	out = []
	for o in frappe.get_all("Pep Outlet", filters={"restaurant": restaurant, "disabled": 0},
	                        fields=["name", "outlet_name", "tables", "qr_ordering"], order_by="outlet_name"):
		out.append({"outlet": o.name, "outlet_name": o.outlet_name, "qr_ordering": o.qr_ordering,
		            "tables": [{"table": t, "seats": s, "area": a} for t, s, a in parse_tables(o.tables)]})
	return out


@frappe.whitelist(methods=["POST"])
@require_roles()
def set_accent(restaurant: str, accent_color: str):
	"""Settings -> Colour theme: the restaurant's brand colour."""
	doc = frappe.get_doc("Pep Restaurant", restaurant)
	doc.accent_color = accent_color
	doc.save()  # the controller validates and normalises the hex
	return {"ok": True, "accent_color": doc.accent_color}
