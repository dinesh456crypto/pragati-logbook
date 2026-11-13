import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, LogOut } from 'lucide-react'
import { NAV, findNav } from '../lib/nav'
import { useAuth } from '../lib/auth'
import { Brand } from './Brand'

interface Props {
  collapsed: boolean // desktop: icons only
  mobileOpen: boolean // phone/tablet: drawer visible
  onNavigate: () => void
}

export function Sidebar({ collapsed, mobileOpen, onNavigate }: Props) {
  const { can, signOut } = useAuth()
  const location = useLocation()
  const [peek, setPeek] = useState(false) // collapsed sidebar expands while hovered
  const current = findNav(location.pathname)
  const currentModule = current?.module.label ?? ''
  const [openModule, setOpenModule] = useState(currentModule || 'Dashboard')
  const [shownModule, setShownModule] = useState(currentModule)

  // When the page changes, open the module that contains it.
  if (currentModule !== shownModule) {
    setShownModule(currentModule)
    if (currentModule) setOpenModule(currentModule)
  }

  const modules = NAV.map((m) => ({ ...m, items: m.items.filter((i) => can(i.resource, i.action)) })).filter(
    (m) => m.items.length > 0,
  )
  const showLabels = !collapsed || peek || mobileOpen

  return (
    <>
      <div className={`drawer-backdrop ${mobileOpen ? 'show' : ''}`} onClick={onNavigate} aria-hidden="true" />
      <aside
        className={`sidebar ${collapsed ? 'collapsed' : ''} ${peek ? 'peek' : ''} ${mobileOpen ? 'open' : ''}`}
        onMouseEnter={() => collapsed && setPeek(true)}
        onMouseLeave={() => setPeek(false)}
        aria-label="Main navigation"
      >
        <Brand compact={!showLabels} />
        <nav className="nav">
          {modules.map((m) => {
            const Icon = m.icon
            const single = m.items.length === 1 && m.label === 'Dashboard'
            const active = current?.module.label === m.label
            const expanded = showLabels && openModule === m.label
            if (single) {
              return (
                <NavLink
                  key={m.label}
                  to={m.items[0].path}
                  className={`nav-head ${active ? 'active' : ''}`}
                  title={m.label}
                  onClick={onNavigate}
                >
                  <Icon size={20} />
                  {showLabels && <span>{m.label}</span>}
                </NavLink>
              )
            }
            return (
              <div key={m.label} className="nav-group">
                <button
                  type="button"
                  className={`nav-head ${active ? 'active' : ''}`}
                  title={m.label}
                  aria-expanded={expanded}
                  onClick={() => setOpenModule(openModule === m.label ? '' : m.label)}
                >
                  <Icon size={20} />
                  {showLabels && (
                    <>
                      <span>{m.label}</span>
                      <ChevronDown size={16} className={`chev ${expanded ? 'up' : ''}`} />
                    </>
                  )}
                </button>
                {expanded && (
                  <div className="nav-sub">
                    {m.items.map((i) => (
                      <NavLink
                        key={i.path}
                        to={i.path}
                        end
                        className={current?.item.path === i.path ? 'active' : ''}
                        onClick={onNavigate}
                      >
                        {i.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
        <button type="button" className="nav-head logout" onClick={signOut} title="Logout">
          <LogOut size={20} />
          {showLabels && <span>Logout</span>}
        </button>
      </aside>
    </>
  )
}
