import { lazy, Suspense, type ReactNode } from "react"
import { Navigate, Route, Routes, useLocation } from "react-router-dom"
import { R, useAuth } from "./lib/auth"
import { VenueProvider, useVenue } from "./lib/venue"
import { PinProvider } from "./components/PinGate"
import Shell from "./components/Shell"
import Login from "./screens/Login"

const Till = lazy(() => import("./screens/Till"))
const Kitchen = lazy(() => import("./screens/Kitchen"))
const Dishes = lazy(() => import("./screens/Dishes"))
const Recipes = lazy(() => import("./screens/Recipes"))
const Stock = lazy(() => import("./screens/Stock"))
const Cash = lazy(() => import("./screens/Cash"))
const Reports = lazy(() => import("./screens/Reports"))
const QrCodes = lazy(() => import("./screens/QrCodes"))
const Setup = lazy(() => import("./screens/Setup"))
const QrMenu = lazy(() => import("./screens/QrMenu"))

const Loading = () => <div className="flex h-full items-center justify-center text-sm text-mute">Loading…</div>

function Authed({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const loc = useLocation()
  if (status === "loading") return <Loading />
  if (status === "anon") return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return (
    <VenueProvider>
      <PinProvider>
        <Gate>{children}</Gate>
      </PinProvider>
    </VenueProvider>
  )
}

/** No restaurant yet: managers go to setup, everyone else is told why. */
function Gate({ children }: { children: ReactNode }) {
  const { loaded, restaurants, canSetup } = useVenue()
  const loc = useLocation()
  if (!loaded) return <Loading />
  if (!restaurants.length && !loc.pathname.startsWith("/setup")) {
    if (canSetup) return <Navigate to="/setup" replace />
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-bold">You're not assigned to a restaurant yet</p>
          <p className="mt-1 text-sm text-mute">Ask a manager to give you access to one.</p>
        </div>
      </div>
    )
  }
  return <>{children}</>
}

function Home() {
  const { has } = useAuth()
  if (has(R.captain, R.cashier)) return <Navigate to="/till" replace />
  if (has(R.kitchen)) return <Navigate to="/kitchen" replace />
  return <Navigate to="/reports" replace />
}

export default function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/menu/:outlet" element={<QrMenu />} />
        <Route path="/kitchen" element={<Authed><Kitchen /></Authed>} />
        <Route path="/till" element={<Authed><Shell bare><Till /></Shell></Authed>} />
        <Route path="/dishes" element={<Authed><Shell><Dishes /></Shell></Authed>} />
        <Route path="/recipes" element={<Authed><Shell><Recipes /></Shell></Authed>} />
        <Route path="/stock" element={<Authed><Shell><Stock /></Shell></Authed>} />
        <Route path="/cash" element={<Authed><Shell><Cash /></Shell></Authed>} />
        <Route path="/reports" element={<Authed><Shell><Reports /></Shell></Authed>} />
        <Route path="/qr" element={<Authed><Shell><QrCodes /></Shell></Authed>} />
        <Route path="/setup" element={<Authed><Shell><Setup /></Shell></Authed>} />
        <Route path="*" element={<Authed><Home /></Authed>} />
      </Routes>
    </Suspense>
  )
}
