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


class PepRestaurant(Document):
	def validate(self):
		parts = parse_tax_split(self.tax_split)
		if parts:
			total = round(sum(s for _l, s in parts), 4)
			if abs(total - 1) > 0.0001:
				frappe.throw(_("Tax split shares must add up to 100% (they add up to {0}%).").format(total * 100))
			if any(not label for label, _s in parts):
				frappe.throw(_("Every tax split line needs a label, e.g. CGST:50."))
		for f in ("pin_max_attempts", "pin_lock_minutes"):
			if (self.get(f) or 0) < 1:
				self.set(f, 5 if f == "pin_max_attempts" else 15)
