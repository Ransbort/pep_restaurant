"""Desk / REST scoping hooks (Frappe's own list and form paths).

Whitelisted endpoints enforce scope themselves (authz.require_roles); these
hooks close the generic /api/resource and Desk paths. Only active under the
site config `pep_strict_scope` - otherwise Frappe's User Permissions on
Restaurant (applied through each doctype's `restaurant` link) govern."""

import frappe
from frappe.utils import cint

from pep_restaurant.authz import restricted_restaurants


def _strict() -> bool:
	return bool(cint(frappe.conf.get("pep_strict_scope")))


def query_conditions(user: str | None = None, doctype: str | None = None) -> str:
	if not _strict() or not doctype:
		return ""
	allowed = restricted_restaurants(user)
	if allowed is None:
		return ""
	if not allowed:
		return "1=0"
	names = ", ".join(frappe.db.escape(r) for r in sorted(allowed))
	return f"`tab{doctype}`.`restaurant` IN ({names})"


def has_permission(doc, ptype: str | None = None, user: str | None = None, debug: bool = False) -> bool:
	if not _strict():
		return True
	allowed = restricted_restaurants(user)
	return allowed is None or doc.get("restaurant") in allowed
