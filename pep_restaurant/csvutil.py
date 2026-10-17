"""CSV parsing shared by the menu and ingredient imports."""

import csv
import io

import frappe
from frappe import _

TRUE = ("1", "y", "yes", "true", "veg", "active")


def read_csv(csv_text: str) -> tuple[dict[str, str], list[tuple[int, dict]]]:
	"""(headers, rows) from pasted or uploaded CSV text. Tolerates Excel's
	UTF-8 BOM and semicolon separators. Header names are normalised to
	snake_case; each row comes with its line number for error reports."""
	text = (csv_text or "").lstrip("﻿").strip()
	if not text:
		frappe.throw(_("The CSV is empty."))
	first = text.splitlines()[0]
	delimiter = ";" if first.count(";") > first.count(",") else ","
	reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
	if not reader.fieldnames:
		frappe.throw(_("Paste a CSV with a header row."))
	headers = {h.strip().lower().replace(" ", "_"): h for h in reader.fieldnames if h}
	rows = []
	for i, raw in enumerate(reader, start=2):
		row = {k: (raw.get(src) or "").strip() for k, src in headers.items()}
		if any(row.values()):
			rows.append((i, row))
	return headers, rows


def yes(v) -> int:
	return 1 if str(v or "").strip().lower() in TRUE else 0


def number(v, label: str) -> float | None:
	"""A number from a spreadsheet cell ("1,250.50", "₵40" -> 1250.5, 40);
	None when the cell is blank. Anything else is an error naming the column."""
	s = str(v or "").strip()
	if not s:
		return None
	cleaned = "".join(c for c in s if c.isdigit() or c in ".-")
	try:
		return float(cleaned)
	except ValueError:
		frappe.throw(_("{0} must be a number, not \"{1}\".").format(label, s))
