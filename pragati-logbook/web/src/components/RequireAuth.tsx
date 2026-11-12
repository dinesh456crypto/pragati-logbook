import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import type { Role } from '../lib/types'

export function RequireAuth({ role }: { role?: Role }) {
  const { loading, session, profile } = useAuth()
  const location = useLocation()

  if (loading) return <div className="page-status">Loading…</div>
  if (!session || !profile) return <Navigate to="/login" replace state={{ from: location }} />
  if (profile.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }
  if (role && profile.role !== role) return <Navigate to="/" replace />
  return <Outlet />
}
