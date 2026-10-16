import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// Dev: served at / on :5174, proxying /api and /socket.io to the bench.
// Build: emits into the Frappe app's public/ folder, served at
// /assets/pep_restaurant/frontend/. The SPA itself mounts at /restaurant
// (website_route_rules in hooks.py, router basename in main.tsx).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/assets/pep_restaurant/frontend/" : "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../pep_restaurant/public/frontend",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|cookie)\//.test(id)) return "vendor"
        },
      },
    },
  },
  server: {
    port: Number(process.env.PEP_DEV_PORT) || 5174,
    proxy: {
      "/api": { target: process.env.PEP_API_TARGET || "http://localhost:8000", headers: { Host: process.env.PEP_SITE || "restaurant.localhost" } },
      "/files": { target: process.env.PEP_API_TARGET || "http://localhost:8000", headers: { Host: process.env.PEP_SITE || "restaurant.localhost" } },
    },
  },
}))
