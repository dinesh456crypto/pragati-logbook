import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { RequireAuth } from './components/RequireAuth'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { HomePage } from './pages/HomePage'
import { PlaceholderPage } from './pages/PlaceholderPage'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route
              path="/change-password"
              element={
                <div className="auth-page">
                  <ChangePasswordPage />
                </div>
              }
            />
            <Route element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="entry" element={<PlaceholderPage title="Production entry" />} />
              <Route path="jobs" element={<PlaceholderPage title="Finished jobs" />} />
              <Route path="outside-downtime" element={<PlaceholderPage title="Outside-job downtime" />} />
              <Route element={<RequireAuth role="admin" />}>
                <Route path="masters" element={<PlaceholderPage title="Master lists" />} />
                <Route path="users" element={<PlaceholderPage title="Users" />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
