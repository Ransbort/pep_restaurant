"""Live updates: one tiny event says "something at this restaurant changed".

Screens don't care what changed - they re-fetch their own view. Publishing
after commit means the re-fetch always sees the new state."""

import frappe


def notify(doc, method=None):
	try:
		frappe.publish_realtime(
			"pep_changed",
			{"doctype": doc.doctype, "restaurant": doc.get("restaurant"), "outlet": doc.get("outlet")},
			after_commit=True,
		)
	except Exception:
		pass  # realtime must never break the write
