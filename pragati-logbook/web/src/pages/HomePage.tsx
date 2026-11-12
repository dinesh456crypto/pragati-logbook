import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'
import type { Machine } from '../lib/types'

// Landing page and connectivity check: lists the machines this user may use.
// RLS returns every active machine to admins and only assigned ones to operators.
export function HomePage() {
  const { profile } = useAuth()
  const [machines, setMachines] = useState<Machine[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('machines')
      .select('id, code, name, active')
      .eq('active', true)
      .order('code')
      .then(({ data, error: e }) => {
        if (e) setError(e.message)
        else setMachines(data as Machine[])
      })
  }, [])

  return (
    <section className="card">
      <h1>Welcome, {profile?.full_name}</h1>
      <p className="muted">
        Signed in as {profile?.username} ({profile?.role === 'admin' ? 'Administrator' : 'Operator'}).
      </p>
      <h2>Your machines</h2>
      {error && <p className="notice">Could not load machines: {error}</p>}
      {!error && machines === null && <p className="muted">Loading…</p>}
      {machines?.length === 0 && (
        <p className="muted">
          No machines assigned yet.{' '}
          {profile?.role === 'admin' ? <Link to="/masters">Add machines in Master lists.</Link> : 'Ask the administrator.'}
        </p>
      )}
      {!!machines?.length && (
        <ul className="chips">
          {machines.map((m) => (
            <li key={m.id} className="chip">
              {m.code}
              {m.name ? ` · ${m.name}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
