import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { KeyRound, Menu } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { useAuth } from '../lib/auth'
import { findNav } from '../lib/nav'
import { ROLE_LABELS } from '../lib/types'

const COLLAPSE_KEY = 'pragati.sidebarCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

export function AppShell() {
  const { profile } = useAuth()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const current = findNav(location.pathname)
  const crumb = current
    ? current.module.label === 'Dashboard'
      ? 'Dashboard'
      : `${current.module.label} / ${current.item.label}`
    : ''

  function toggleMenu() {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setMobileOpen((o) => !o)
      return
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        /* preference only */
      }
      return !c
    })
  }

  return (
    <div className={`shell ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />
      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button type="button" className="icon-button" onClick={toggleMenu} aria-label="Toggle menu" title="Menu">
              <Menu size={22} />
            </button>
            <span className="crumb">{crumb}</span>
          </div>
          <div className="topbar-right">
            <span className="who">
              <b>{profile?.full_name}</b>
              <span>{profile ? ROLE_LABELS[profile.role] : ''}</span>
            </span>
            <Link to="/change-password" className="icon-button" aria-label="Change password" title="Change password">
              <KeyRound size={20} />
            </Link>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
