import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'

const links = [
  { to: '/entry', label: 'Production entry' },
  { to: '/jobs', label: 'Finished jobs' },
  { to: '/outside-downtime', label: 'Outside-job downtime' },
  { to: '/masters', label: 'Master lists', admin: true },
  { to: '/users', label: 'Users', admin: true },
]

export function Layout() {
  const { profile, signOut } = useAuth()
  const isAdmin = profile?.role === 'admin'

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Pragati Offset</span>
          <span className="brand-sub">Production Logbook</span>
        </div>
        <div className="account">
          <span>
            {profile?.full_name} · {profile?.username}
            {isAdmin ? ' · Admin' : ''}
          </span>
          <NavLink to="/change-password" className="button">
            Change password
          </NavLink>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="Main navigation">
        {links
          .filter((l) => !l.admin || isAdmin)
          .map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => (isActive ? 'tab active' : 'tab')}>
              {l.label}
            </NavLink>
          ))}
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
