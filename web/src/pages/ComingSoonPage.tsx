import { useLocation } from 'react-router-dom'
import { Construction } from 'lucide-react'
import { findNav } from '../lib/nav'

export function ComingSoonPage() {
  const { pathname } = useLocation()
  const nav = findNav(pathname)
  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{nav?.item.label ?? 'Coming soon'}</h1>
          <p className="muted">{nav?.module.label}</p>
        </div>
      </div>
      <section className="card empty-state">
        <Construction size={36} aria-hidden="true" />
        <h2>Built in phase {nav?.item.phase ?? '—'}</h2>
        <p className="muted">This screen is part of a later build phase. Its menu entry and access permission are already in place.</p>
      </section>
    </>
  )
}
