import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "./index.css"
import App from "./App"
import { AuthProvider } from "./lib/auth"
import { ToastProvider } from "./components/ui"

// Served at /restaurant in production; at / by the Vite dev server.
const basename = location.pathname.startsWith("/restaurant") ? "/restaurant" : "/"

const icon = document.createElement("link")
icon.rel = "icon"
icon.type = "image/svg+xml"
icon.href = import.meta.env.BASE_URL + "pep-mark.svg"
document.head.appendChild(icon)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
