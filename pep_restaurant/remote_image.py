"""Download a dish photo from a URL into the site's public files.

Used by the menu CSV import so a spreadsheet can carry photo links instead of
files. A manager supplies the URL, but the server does the fetching, so it
refuses anything that resolves to a private, loopback or link-local address
(no reaching into the restaurant's own network), follows at most three
redirects - each re-checked - and accepts only real images up to 5 MB.
"""

import ipaddress
import os
import socket
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import frappe
from frappe import _

MAX_BYTES = 5 * 1024 * 1024
TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
UA = "PepRestaurant/0.1 (Frappe restaurant POS; menu photo import)"


def is_url(v: str | None) -> bool:
	return str(v or "").strip().lower().startswith(("http://", "https://"))


def _clean(url: str) -> str:
	"""Drop tracking query strings (utm_*) that change nothing about the image."""
	p = urlsplit(url.strip())
	q = "&".join(x for x in p.query.split("&") if x and not x.lower().startswith("utm_"))
	return urlunsplit((p.scheme, p.netloc, p.path, q, ""))


def _check_host(url: str):
	p = urlsplit(url)
	if p.scheme not in ("http", "https") or not p.hostname:
		frappe.throw(_("Only http(s) image links are allowed."))
	try:
		addrs = {a[4][0] for a in socket.getaddrinfo(p.hostname, p.port or 443, proto=socket.IPPROTO_TCP)}
	except socket.gaierror:
		frappe.throw(_("Couldn't find the server {0}.").format(p.hostname))
	for a in addrs:
		ip = ipaddress.ip_address(a.split("%")[0])
		if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
			frappe.throw(_("Refusing to fetch an image from a private network address."))


def fetch(url: str) -> tuple[bytes, str, str]:
	"""(content, extension, final url) of the image at url, or throws."""
	import requests

	url = _clean(url)
	for _hop in range(4):
		_check_host(url)
		r = requests.get(url, headers={"User-Agent": UA, "Accept": "image/*"}, timeout=(5, 20),
		                 stream=True, allow_redirects=False)
		if r.is_redirect or r.status_code in (301, 302, 303, 307, 308):
			url = urljoin(url, r.headers.get("Location", ""))
			r.close()
			continue
		if r.status_code != 200:
			frappe.throw(_("The image link answered {0}.").format(r.status_code))
		ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
		if ctype not in TYPES:
			frappe.throw(_("That link isn't a JPEG, PNG, WebP or GIF image ({0}).").format(ctype or "unknown type"))
		data = b""
		for chunk in r.iter_content(64 * 1024):
			data += chunk
			if len(data) > MAX_BYTES:
				frappe.throw(_("The image is over 5 MB."))
		return data, TYPES[ctype], url
	frappe.throw(_("Too many redirects."))


def attach_to_dish(dish: str, url: str) -> str:
	"""Download url, store it as a public File attached to the dish's image
	field, and set the dish's image. Returns the file URL. Frappe reuses an
	identical file already on the site, so re-importing doesn't pile up copies."""
	data, ext, final = fetch(url)
	stem = os.path.splitext(unquote(os.path.basename(urlsplit(final).path)))[0] or "dish"
	stem = "".join(c if c.isalnum() or c in "-_" else "-" for c in stem).strip("-")[:80] or "dish"
	f = frappe.get_doc({
		"doctype": "File", "file_name": f"{stem}{ext}", "content": data, "is_private": 0,
		"attached_to_doctype": "Pep Menu Item", "attached_to_name": dish, "attached_to_field": "image",
	})
	f.insert(ignore_permissions=True)
	frappe.db.set_value("Pep Menu Item", dish, "image", f.file_url)
	return f.file_url
