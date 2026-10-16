import frappe

from pep_restaurant.authz import ALL_ROLES

# Desk access: managers use Desk for masters; floor and kitchen live in /restaurant
DESK = {"Restaurant Manager": 1}


def after_install():
	ensure_roles()
	set_favicon()


def after_migrate():
	ensure_roles()


def ensure_roles():
	"""Roles only - their grants live on the endpoints (@require_roles) and
	in the doctype JSON, never in Custom DocPerms (a custom perm on a doctype
	replaces ALL its standard perms in Frappe)."""
	for role in ALL_ROLES:
		if not frappe.db.exists("Role", role):
			frappe.get_doc({
				"doctype": "Role", "role_name": role, "desk_access": DESK.get(role, 0),
			}).insert(ignore_permissions=True)


def set_favicon():
	ws = frappe.get_doc("Website Settings")
	if not ws.favicon:
		ws.favicon = "/assets/pep_restaurant/pep-mark.svg"
		ws.flags.ignore_mandatory = True
		ws.save(ignore_permissions=True)
