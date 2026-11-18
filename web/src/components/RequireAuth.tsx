import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { NAV } from '../lib/nav'
import type { Action, Resource } from '../lib/types'

export function RequireAuth() {
  const { loading, session, profile, error, retry, signOut } = useAuth()
  const location = useLocation()

  if (loading) return <div className="page-status">Loading…</div>
  // Signed in, but the account could not be loaded (no connection): stay signed in.
  if (session && !profile && error) {
    return (
      <div className="auth-page">
        <section className="card auth-card">
          <h1>Connection problem</h1>
          <p className="notice error">{error}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={retry}>
              Try again
            </button>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </div>
        </section>
      </div>
    )
  }
  if (!session || !profile) return <Navigate to="/login" replace state={{ from: location }} />
  if (profile.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />
  }
  return <Outlet />
}

// Screen-level check. The database enforces the same permissions on the data.
export function RequirePermission({ resource, action = 'view' }: { resource: Resource; action?: Action }) {
  const { can } = useAuth()
  if (!can(resource, action)) {
    return (
      <section className="card">
        <h1>No access</h1>
        <p className="muted">You do not have permission to open this screen. Ask the Super Admin if you need it.</p>
      </section>
    )
  }
  return <Outlet />
}

// Sends the user to the first screen they are allowed to open.
export function HomeRedirect() {
  const { can } = useAuth()
  const first = NAV.flatMap((m) => m.items).find((i) => can(i.resource, i.action))
  if (!first) {
    return (
      <section className="card">
        <h1>No screens assigned</h1>
        <p className="muted">Your account has no permissions yet. Ask the Super Admin to assign them.</p>
      </section>
    )
  }
  return <Navigate to={first.path} replace />
}
