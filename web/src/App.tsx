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
import { MasterPage } from './pages/MasterPage'
import { JobsPage } from './pages/JobsPage'
import { ProductionEntriesPage } from './pages/ProductionEntriesPage'
import { ProductionEntryPage } from './pages/ProductionEntryPage'
import { DowntimePage } from './pages/DowntimePage'
import { ProductionLogPage } from './pages/ProductionLogPage'
import { InkEntryPage } from './pages/InkEntryPage'
import { InkSummaryPage } from './pages/InkSummaryPage'
import { InkFormulaPage } from './pages/InkFormulaPage'
import { WastageEntryPage } from './pages/WastageEntryPage'
import { WastageSummaryPage } from './pages/WastageSummaryPage'
import { UsersPage } from './pages/UsersPage'
import { UserFormPage } from './pages/UserFormPage'
import { ToastProvider } from './components/Toast'
import { MASTERS } from './lib/masters'

// Screens built so far; every other menu entry shows its planned phase.
const BUILT: Record<string, ComponentType> = {
  '/dashboard': DashboardPage,
  '/plan/jobs': JobsPage,
  '/production/entry': ProductionEntriesPage,
  '/production/bdt': DowntimePage,
  '/production/odt': DowntimePage,
  '/production/log': ProductionLogPage,
  '/ink/entry': InkEntryPage,
  '/ink/summary': InkSummaryPage,
  '/wastage/entry': WastageEntryPage,
  '/wastage/summary': WastageSummaryPage,
  '/users': UsersPage,
  '/users/new': UserFormPage,
  ...Object.fromEntries(MASTERS.map((m) => [`/masters/${m.slug}`, MasterPage])),
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
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
                {/* Production Entry form: new needs Create; an existing entry opens in view or edit mode. */}
                <Route element={<RequirePermission resource="production_entry" action="create" />}>
                  <Route path="production/entry/new" element={<ProductionEntryPage />} />
                </Route>
                <Route element={<RequirePermission resource="production_entry" />}>
                  <Route path="production/entry/:id" element={<ProductionEntryPage />} />
                </Route>
                <Route element={<RequirePermission resource="users" action="edit" />}>
                  <Route path="users/:id" element={<UserFormPage key="edit-user" />} />
                </Route>
                <Route element={<RequirePermission resource="ink_formula" />}>
                  <Route path="ink/summary/:id" element={<InkFormulaPage />} />
                </Route>
                {NAV.flatMap((m) => m.items).map((item) => {
                  const Page = BUILT[item.path] ?? ComingSoonPage
                  return (
                    <Route key={item.path} element={<RequirePermission resource={item.resource} action={item.action} />}>
                      <Route path={item.path.slice(1)} element={<Page key={item.path} />} />
                    </Route>
                  )
                })}
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
