import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { PASSWORD_MAX, PASSWORD_MIN } from '../lib/username'
import { PasswordInput } from '../components/PasswordInput'

export function ChangePasswordPage() {
  const { profile, changePassword, signOut } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const forced = !!profile?.must_change_password

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
      setNotice(`Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`)
      return
    }
    if (next !== confirm) {
      setNotice('New passwords do not match.')
      return
    }
    setBusy(true)
    try {
      await changePassword(current, next)
      navigate('/', { replace: true })
    } catch (err) {
      setNotice((err as Error).message)
    } finally {
      setBusy(false)
      setCurrent('')
      setNext('')
      setConfirm('')
    }
  }

  return (
    <form className="card auth-card" onSubmit={submit}>
      <h1>Change password</h1>
      <p className="muted">
        Use at least {PASSWORD_MIN} characters.
        {forced ? ' Your temporary password must be changed before you continue.' : ''}
      </p>
      <label className="field">
        <span>Current password</span>
        <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>New password</span>
        <PasswordInput
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={PASSWORD_MAX}
          required
        />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
      </label>
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          Change password
        </button>
        <button type="button" onClick={() => (forced ? signOut() : navigate(-1))}>
          {forced ? 'Sign out' : 'Cancel'}
        </button>
      </div>
      <p className="notice-text" role="status">
        {notice}
      </p>
    </form>
  )
}
