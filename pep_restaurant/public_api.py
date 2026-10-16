"""Guest-facing endpoints behind a table QR code. Rate-limited, and never
trust a price from the browser: lines are priced from the menu, and the
order lands as a QR order a captain must confirm before it fires."""

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit

from pep_restaurant.pos import _menu, create_order_core, parse_tables


def _public_outlet(outlet: str):
	o = frappe.db.get_value("Pep Outlet", outlet, ["outlet_name", "disabled", "restaurant", "qr_ordering", "tables"],
	                        as_dict=True)
	if not o or o.disabled:
		frappe.throw(_("This menu isn't available."))
	return o


@frappe.whitelist(allow_guest=True)
def qr_menu(outlet: str):
	o = _public_outlet(outlet)
	rest = frappe.db.get_value("Pep Restaurant", o.restaurant,
	                           ["restaurant_name", "currency", "logo", "prices_include_tax", "disabled"], as_dict=True)
	if not rest or rest.disabled:
		frappe.throw(_("This menu isn't available."))
	return {
		"outlet": outlet, "outlet_name": o.outlet_name, "restaurant_name": rest.restaurant_name,
		"currency": rest.currency, "currency_symbol": frappe.db.get_value("Currency", rest.currency, "symbol"),
		"logo": rest.logo, "prices_include_tax": rest.prices_include_tax, "ordering": bool(o.qr_ordering),
		"categories": _menu(outlet, guest=True),
	}


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=30, seconds=3600)
def qr_order(outlet: str, items, table_no: str | None = None, notes: str | None = None,
             customer_name: str | None = None, allergy_note: str | None = None):
	o = _public_outlet(outlet)
	if not o.qr_ordering:
		frappe.throw(_("Ordering from the table isn't on here - please ask a server."))
	tables = {t for t, _s, _a in parse_tables(o.tables)}
	if table_no and tables and table_no not in tables:
		frappe.throw(_("Unknown table. Scan the code on your table again."))
	out = create_order_core(outlet, items, table_no=table_no or None, source="QR",
	                        order_type="Dine In" if table_no else "Takeaway", notes=notes,
	                        customer_name=customer_name, allergy_note=allergy_note, ignore_permissions=True)
	frappe.db.commit()  # persist before answering a public caller
	return {"ok": True, "order": out["order"], "grand_total": out["grand_total"],
	        "message": _("Order placed - a server will confirm it shortly.")}
