import type { ComponentType } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { NAV } from './lib/nav'
import { HomeRedirect, RequireAuth, RequirePermission } from './components/RequireAuth'
import { AppShell } from './components/AppShell'
import { LoginPage } from './pages/LoginPage'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { DashboardPage } from './pages/DashboardPage'
import { ComingSoonPage } from './pages/ComingSoonPage'

// Screens built so far; every other menu entry shows its planned phase.
const BUILT: Record<string, ComponentType> = {
  '/dashboard': DashboardPage,
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            {/* Outside the app shell: a forced change comes before any other screen. */}
            <Route
              path="change-password"
              element={
                <div className="auth-page">
                  <ChangePasswordPage />
                </div>
              }
            />
            <Route element={<AppShell />}>
              <Route index element={<HomeRedirect />} />
              {NAV.flatMap((m) => m.items).map((item) => {
                const Page = BUILT[item.path] ?? ComingSoonPage
                return (
                  <Route key={item.path} element={<RequirePermission resource={item.resource} action={item.action} />}>
                    <Route path={item.path.slice(1)} element={<Page />} />
                  </Route>
                )
              })}
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
