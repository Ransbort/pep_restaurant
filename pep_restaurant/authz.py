"""Endpoint authorization.

Frappe checks doctype permissions on ORM paths, but frappe.get_all, raw SQL
and db.set_value sail past them. Every whitelisted restaurant endpoint therefore
declares who may call it with @require_roles - and, for staff restricted to
some restaurants (Frappe User Permissions on "Restaurant"), which
restaurant's records it may touch.

Ported from kamra.authz with the hotel "property" scope replaced by the
restaurant.
"""

import inspect
import json
from functools import wraps

import frappe
from frappe import _
from frappe.utils import add_to_date, cint, now_datetime

MANAGER = "Restaurant Manager"
CAPTAIN = "Restaurant Captain"
CASHIER = "Restaurant Cashier"
KITCHEN = "Kitchen Staff"

ADMIN = ("System Manager", "Administrator", MANAGER)

# who works the floor (takes orders, fires KOTs)
FLOOR_ROLES = (CAPTAIN, CASHIER)
# who touches money at the till
MONEY_ROLES = (CASHIER,)
# the kitchen display; floor staff may run it too (small places)
KITCHEN_ROLES = (KITCHEN, CAPTAIN, CASHIER)
# who may look at stock / move it deliberately
INVENTORY_READ = (CASHIER, KITCHEN)
INVENTORY_WRITE = ()  # managers only (ADMIN is always allowed)

ALL_ROLES = (MANAGER, CAPTAIN, CASHIER, KITCHEN)


# Endpoint argument name -> doctype(s) it names. Each carries a `restaurant`
# link, so the guard can tell which restaurant a call reaches into.
SCOPED_ARGS = {
	"outlet": ("Restaurant Outlet",),
	"order": ("Restaurant Order",),
	"menu_item": ("Restaurant Menu Item",),
	"ingredient": ("Restaurant Ingredient",),
	"reservation": ("Restaurant Table Reservation",),
	"session": ("Restaurant Cashier Session",),
}


def restricted_restaurants(user: str | None = None) -> set[str] | None:
	"""The restaurants the user is limited to by User Permissions, or None
	when unrestricted. With site config `pep_strict_scope`, everyone but
	Administrator / System Manager needs explicit permissions."""
	from frappe.core.doctype.user_permission.user_permission import get_user_permissions

	user = user or frappe.session.user
	perms = get_user_permissions(user).get("Restaurant")
	if perms:
		return {p.get("doc") for p in perms}
	if cint(frappe.conf.get("pep_strict_scope")) and not (
		user == "Administrator" or "System Manager" in frappe.get_roles(user)
	):
		return set()
	return None


def assert_restaurant_access(restaurant: str | None):
	allowed = restricted_restaurants()
	if restaurant and allowed is not None and restaurant not in allowed:
		frappe.throw(_("You don't have access to {0}.").format(restaurant), frappe.PermissionError)


def _values(value) -> list[str]:
	if isinstance(value, str) and value.startswith("["):
		try:
			value = json.loads(value)
		except ValueError:
			return [value]
	if isinstance(value, list | tuple):
		return [v for v in value if isinstance(v, str)]
	return [value] if isinstance(value, str) else []


def _enforce_scope(fn, args, kwargs, scope: dict):
	allowed = restricted_restaurants()
	if allowed is None:
		return
	try:
		bound = inspect.signature(fn).bind_partial(*args, **kwargs).arguments
	except TypeError:
		bound = kwargs
	for arg, value in bound.items():
		if arg == "restaurant":
			assert_restaurant_access(value if isinstance(value, str) else None)
			continue
		doctypes = scope.get(arg) or SCOPED_ARGS.get(arg)
		if not doctypes:
			continue
		if isinstance(doctypes, str):
			doctypes = (doctypes,)
		for name in _values(value):
			for dt in doctypes:
				rest = frappe.db.get_value(dt, name, "restaurant")
				if rest:
					assert_restaurant_access(rest)
					break


def require_roles(*roles, scope: dict | None = None):
	"""Allow the listed roles (plus admins) and enforce restaurant scope.
	Place BELOW @frappe.whitelist() so the registered function is guarded."""
	allowed = set(roles) | set(ADMIN)
	scope = scope or {}

	def deco(fn):
		@wraps(fn)
		def guarded(*args, **kwargs):
			if not allowed & set(frappe.get_roles()):
				frappe.throw(
					_("Not permitted - needs one of: {0}.").format(", ".join(sorted(roles) or [MANAGER])),
					frappe.PermissionError,
				)
			_enforce_scope(fn, args, kwargs, scope)
			return fn(*args, **kwargs)

		guarded._pep_roles = allowed
		return guarded

	return deco


def is_admin(user: str | None = None) -> bool:
	return bool(set(ADMIN) & set(frappe.get_roles(user)))


# ------------------------------------------------------------- cashier PIN


def _pin_policy(restaurant: str | None) -> tuple[int, int]:
	r = frappe.db.get_value("Restaurant", restaurant, ["pin_max_attempts", "pin_lock_minutes"], as_dict=True) or {}
	return int(r.get("pin_max_attempts") or 5), int(r.get("pin_lock_minutes") or 15)


def _unlock_key(user: str) -> str:
	return f"pep_cashier_unlock:{user}"


def pin_required(restaurant: str | None) -> bool:
	return bool(restaurant and frappe.db.get_value("Restaurant", restaurant, "require_cashier_pin"))


def require_cashier_pin(restaurant: str, pin=None):
	"""Money actions re-confirm WHO is acting with a personal PIN, even in a
	valid session (the walk-up-to-an-unlocked-till guard). Off unless the
	restaurant turns it on. A correct PIN opens a sliding unlock window."""
	if not pin_required(restaurant):
		return
	user = frappe.session.user
	if user == "Administrator":
		return
	max_attempts, lock_minutes = _pin_policy(restaurant)
	key = _unlock_key(user)
	if frappe.cache.get_value(key):
		frappe.cache.set_value(key, 1, expires_in_sec=lock_minutes * 60)
		return
	if not frappe.db.exists("Restaurant Cashier PIN", user):
		frappe.throw(_("PIN_NOT_SET: set your cashier PIN first, then retry."))
	doc = frappe.get_doc("Restaurant Cashier PIN", user)
	if doc.must_reset:
		frappe.throw(_("PIN_MUST_RESET: your PIN was reset by a manager - set a new one."))
	if doc.locked_until and now_datetime() < doc.locked_until:
		frappe.throw(_("PIN_LOCKED: too many wrong attempts - try again later."))
	if not pin:
		frappe.throw(_("PIN_REQUIRED: this action needs your cashier PIN."))
	from frappe.utils.password import get_decrypted_password

	stored = get_decrypted_password("Restaurant Cashier PIN", user, "pin", raise_exception=False)
	if not stored or str(pin).strip() != str(stored):
		attempts = int(doc.pin_attempts or 0) + 1
		doc.pin_attempts = attempts
		if attempts >= max_attempts:
			doc.locked_until = add_to_date(now_datetime(), minutes=lock_minutes)
			doc.pin_attempts = 0
			doc.save(ignore_permissions=True)
			frappe.db.commit()  # the lockout must survive the exception's rollback
			frappe.throw(_("PIN_LOCKED: too many wrong attempts - locked for {0} minutes.").format(lock_minutes))
		doc.save(ignore_permissions=True)
		frappe.db.commit()  # count the wrong attempt even though we throw
		frappe.throw(_("Wrong cashier PIN."))
	if doc.pin_attempts or doc.locked_until:
		doc.pin_attempts = 0
		doc.locked_until = None
		doc.save(ignore_permissions=True)
	frappe.cache.set_value(key, 1, expires_in_sec=lock_minutes * 60)


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def set_my_pin(pin: str, current_pin: str | None = None):
	"""Enroll or change your own 4-6 digit cashier PIN."""
	pin = str(pin or "").strip()
	if not (pin.isdigit() and 4 <= len(pin) <= 6):
		frappe.throw(_("A PIN is 4 to 6 digits."))
	user = frappe.session.user
	if frappe.db.exists("Restaurant Cashier PIN", user):
		doc = frappe.get_doc("Restaurant Cashier PIN", user)
		if not doc.must_reset:
			from frappe.utils.password import get_decrypted_password

			stored = get_decrypted_password("Restaurant Cashier PIN", user, "pin", raise_exception=False)
			if str(current_pin or "").strip() != str(stored):
				frappe.throw(_("Your current PIN is wrong."))
		doc.pin = pin
		doc.must_reset = 0
		doc.pin_attempts = 0
		doc.locked_until = None
		doc.save(ignore_permissions=True)
	else:
		frappe.get_doc({"doctype": "Restaurant Cashier PIN", "user": user, "pin": pin}).insert(ignore_permissions=True)
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles()
def reset_pin(user: str):
	"""Manager: force a staff member to enroll a new PIN."""
	if frappe.db.exists("Restaurant Cashier PIN", user):
		frappe.db.set_value("Restaurant Cashier PIN", user, {"must_reset": 1, "pin_attempts": 0, "locked_until": None})
	return {"ok": True}


@frappe.whitelist(methods=["POST"])
@require_roles(*FLOOR_ROLES)
def unlock(restaurant: str, pin: str):
	"""The PIN pad: verify and open the unlock window."""
	frappe.cache.delete_value(_unlock_key(frappe.session.user))
	require_cashier_pin(restaurant, pin)
	return {"ok": True, "unlocked_minutes": _pin_policy(restaurant)[1]}


@frappe.whitelist()
@require_roles(*FLOOR_ROLES)
def pin_status(restaurant: str):
	user = frappe.session.user
	required = pin_required(restaurant)
	has_pin = bool(frappe.db.exists("Restaurant Cashier PIN", user))
	doc = frappe.get_doc("Restaurant Cashier PIN", user) if has_pin else None
	return {
		"required": required,
		"has_pin": has_pin,
		"must_reset": bool(doc and doc.must_reset),
		"locked": bool(doc and doc.locked_until and now_datetime() < doc.locked_until),
		"unlocked": bool(frappe.cache.get_value(_unlock_key(user))) or not required or user == "Administrator",
	}
