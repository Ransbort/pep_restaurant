import os

import frappe

# The SPA owns its own routing; never cache the boot shell.
no_cache = 1


def get_context(context):
	"""Serve the built React SPA with the session CSRF token injected.

	Vite builds into pep_restaurant/public/frontend (served by Frappe at
	/assets/pep_restaurant/frontend/). index.html is read at request time so
	asset hashes never need hard-coding."""
	index_path = frappe.get_app_path("pep_restaurant", "public", "frontend", "index.html")
	if not os.path.exists(index_path):
		frappe.throw(
			"The Restaurant front-end is not built. Run "
			"<code>cd apps/pep_restaurant/frontend && npm install && npm run build</code>.",
			title="Restaurant not built",
		)
	with open(index_path, encoding="utf-8") as f:
		html = f.read()
	csrf = frappe.sessions.get_csrf_token()
	html = html.replace("</head>", f'<script>window.csrf_token = "{csrf}";</script></head>', 1)
	context.spa_html = html
	context.no_cache = 1
	return context
