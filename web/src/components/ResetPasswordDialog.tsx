import { useState } from 'react'
import { Modal } from './Modal'
import { PasswordInput } from './PasswordInput'
import { callAdmin } from '../lib/users'
import { PASSWORD_MAX, PASSWORD_MIN } from '../lib/username'

interface Props {
  user: { id: string; full_name: string; username: string }
  onClose: () => void
  onDone: (message: string) => void
}

// Sets a temporary password; the user must change it at their next sign-in.
export function ResetPasswordDialog({ user, onClose, onDone }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return setError(`Use ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`)
    if (password !== confirm) return setError('The two passwords do not match.')
    setBusy(true)
    setError('')
    try {
      await callAdmin({ action: 'reset_password', id: user.id, password })
      onDone(`New temporary password set for ${user.full_name}. They must change it when they next sign in.`)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Reset password · ${user.full_name}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Set Password'}
          </button>
        </>
      }
    >
      <p className="muted">
        Username <b>{user.username}</b>. Give the new password to the user in person; they will be asked to choose their own at the next
        sign-in.
      </p>
      <label className="field">
        <span>New temporary password *</span>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" maxLength={PASSWORD_MAX} />
      </label>
      <label className="field">
        <span>Confirm password *</span>
        <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={PASSWORD_MAX} />
      </label>
      <p className="muted small">At least {PASSWORD_MIN} characters.</p>
      {error && <p className="notice error">{error}</p>}
    </Modal>
  )
}
