# Copyright (c) 2026, Pep Restaurant and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


def parse_tax_split(raw: str | None) -> list[tuple[str, float]]:
	""""CGST:50\\nSGST:50" -> [("CGST", 0.5), ("SGST", 0.5)]. Blank -> []."""
	out = []
	for line in (raw or "").replace(",", "\n").splitlines():
		line = line.strip()
		if not line:
			continue
		label, _sep, share = line.partition(":")
		out.append((label.strip(), flt(share or 100) / 100))
	return out


DEFAULT_STATIONS = ("Kitchen", "Tandoor", "Grill", "Fryer", "Bar", "Cold")


def parse_stations(raw: str | None) -> list[str]:
	"""The restaurant's kitchen stations, one per line, in order, deduplicated
	(case-insensitively). Blank falls back to the defaults."""
	out, seen = [], set()
	for line in (raw or "").replace(",", "\n").splitlines():
		name = line.strip()[:40]
		if name and name.lower() not in seen:
			seen.add(name.lower())
			out.append(name)
	return out or list(DEFAULT_STATIONS)


def normalise_hex(value: str | None) -> str | None:
	"""#abc / abc / #aabbcc -> #aabbcc; None when it isn't a colour."""
	v = (value or "").strip().lstrip("#")
	if len(v) == 3:
		v = "".join(c * 2 for c in v)
	if len(v) != 6 or any(c not in "0123456789abcdefABCDEF" for c in v):
		return None
	return f"#{v.lower()}"


class PepRestaurant(Document):
	def validate(self):
		if self.accent_color:
			colour = normalise_hex(self.accent_color)
			if not colour:
				frappe.throw(_("Accent colour must be a hex colour like #f2a900."))
			self.accent_color = colour
		parts = parse_tax_split(self.tax_split)
		if parts:
			total = round(sum(s for _l, s in parts), 4)
			if abs(total - 1) > 0.0001:
				frappe.throw(_("Tax split shares must add up to 100% (they add up to {0}%).").format(total * 100))
			if any(not label for label, _s in parts):
				frappe.throw(_("Every tax split line needs a label, e.g. CGST:50."))
		self.validate_stations()
		for f in ("pin_max_attempts", "pin_lock_minutes"):
			if (self.get(f) or 0) < 1:
				self.set(f, 5 if f == "pin_max_attempts" else 15)

	def validate_stations(self):
		stations = parse_stations(self.prep_stations)
		self.prep_stations = "\n".join(stations)
		if self.is_new():
			return
		# a station that still has dishes can't just vanish: those dishes would
		# never show on any station's kitchen screen
		keep = {s.lower() for s in stations}
		from collections import Counter

		in_use = Counter(frappe.get_all("Pep Menu Item", filters={"restaurant": self.name}, pluck="prep_station"))
		orphans = [f"{st} ({n} dish{'es' if n != 1 else ''})" for st, n in in_use.items()
		           if st and st.lower() not in keep]
		if orphans:
			frappe.throw(_("Move these dishes to another station before removing it: {0}.").format(", ".join(orphans)))
