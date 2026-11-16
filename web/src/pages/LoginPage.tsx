import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { isValidUsername } from '../lib/username'
import { COMPANY } from '../components/Brand'
import { PasswordInput } from '../components/PasswordInput'

export function LoginPage() {
  const { session, profile, loading, error, signIn } = useAuth()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  if (!loading && session && profile) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isValidUsername(username)) {
      setNotice(
        username.includes('@')
          ? 'Enter your username (for example: dinesh), not an email address.'
          : 'Usernames are 3–40 letters or numbers, without spaces (for example: dinesh).',
      )
      return
    }
    setBusy(true)
    setNotice('Signing in…')
    try {
      await signIn(username, password)
      setNotice('')
    } catch (err) {
      setNotice((err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <img src="/logo-full.png" alt="Pragati" width={220} height={108} />
          <div>
            <strong>{COMPANY}</strong>
            <span>Production Logbook</span>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Use the account provided by your administrator.</p>
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          Sign in
        </button>
        <p className="notice-text" role="status">
          {notice || error}
        </p>
      </form>
      <p className="auth-foot">© {new Date().getFullYear()} {COMPANY}</p>
    </div>
  )
}
