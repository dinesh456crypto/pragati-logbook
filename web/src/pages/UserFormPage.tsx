import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, KeyRound, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatMoment } from '../lib/production'
import { ROLE_LABELS } from '../lib/types'
import type { Machine, Role } from '../lib/types'
import { isValidUsername, normaliseUsername, PASSWORD_MAX, PASSWORD_MIN } from '../lib/username'
import { EDITABLE_ROLES, ROLE_PRESETS, USERNAME_RULE, callAdmin, matrixToPayload } from '../lib/users'
import type { Grant, Matrix, ResourceRow } from '../lib/users'
import { PasswordInput } from '../components/PasswordInput'
import { PermissionMatrix } from '../components/PermissionMatrix'
import { ResetPasswordDialog } from '../components/ResetPasswordDialog'
import { useToast } from '../components/Toast'

interface Loaded {
  id: string
  username: string
  full_name: string
  role: Role
  active: boolean
  all_machines: boolean
  must_change_password: boolean
  created_at: string
  updated_at: string
}

// User Account Creation (/users/new) and Edit User (/users/:id).
export function UserFormPage() {
  const { id } = useParams()
  const { hash } = useLocation()
  const navigate = useNavigate()
  const notify = useToast()
  const { profile: me, isSuperAdmin } = useAuth()
  const editing = Boolean(id)

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(editing)
  const [loadError, setLoadError] = useState('')
  const [machines, setMachines] = useState<Machine[]>([])
  const [resources, setResources] = useState<ResourceRow[]>([])

  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [active, setActive] = useState(true)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [allMachines, setAllMachines] = useState(true)
  const [machineIds, setMachineIds] = useState<string[]>([])
  const [matrix, setMatrix] = useState<Matrix>(ROLE_PRESETS.operator)
  const [matrixTouched, setMatrixTouched] = useState(false)

  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [resetting, setResetting] = useState(false)

  const targetIsSuper = loaded?.role === 'super_admin'
  const isSelf = loaded?.id === me?.id
  const canSetPermissions = isSuperAdmin && !targetIsSuper

  useEffect(() => {
    let alive = true
    Promise.all([
      supabase.from('machines').select('id, code, name, active, default_speed, sort_order').order('sort_order').order('code'),
      supabase.from('permission_resources').select('key, module, label, sort_order').order('sort_order'),
    ]).then(([m, r]) => {
      if (!alive) return
      setMachines((m.data ?? []) as Machine[])
      setResources((r.data ?? []) as ResourceRow[])
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!id) return
    let alive = true
    Promise.all([
      supabase
        .from('profiles')
        .select('id, username, full_name, role, active, all_machines, must_change_password, created_at, updated_at')
        .eq('id', id)
        .maybeSingle(),
      supabase.from('profile_machines').select('machine_id').eq('profile_id', id),
      supabase.from('user_permissions').select('resource, can_view, can_create, can_edit, can_delete').eq('profile_id', id),
    ]).then(([p, pm, up]) => {
      if (!alive) return
      setLoading(false)
      if (p.error || !p.data) return setLoadError(p.error ? friendlyError(p.error) : 'This user was not found.')
      const u = p.data as Loaded
      setLoaded(u)
      setFullName(u.full_name)
      setUsername(u.username)
      setRole(u.role)
      setActive(u.active)
      setAllMachines(u.all_machines)
      setMachineIds(((pm.data ?? []) as { machine_id: string }[]).map((x) => x.machine_id))
      const m: Matrix = {}
      for (const row of (up.data ?? []) as { resource: ResourceRow['key']; can_view: boolean; can_create: boolean; can_edit: boolean; can_delete: boolean }[]) {
        m[row.resource] = { view: row.can_view, create: row.can_create, edit: row.can_edit, delete: row.can_delete }
      }
      setMatrix(m)
      setMatrixTouched(true)
    })
    return () => {
      alive = false
    }
  }, [id])

  useEffect(() => {
    if (hash === '#permissions' && !loading) document.getElementById('permissions')?.scrollIntoView({ behavior: 'smooth' })
  }, [hash, loading])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const touch = () => setDirty(true)
  const activeMachines = machines.filter((m) => m.active || machineIds.includes(m.id))
  const granted = useMemo(() => Object.values(matrix).filter((x): x is Grant => !!x?.view).length, [matrix])

  function chooseRole(next: Role) {
    setRole(next)
    touch()
    // A new user starts with the role's usual permissions until the boxes are changed by hand.
    if (!editing && !matrixTouched && next !== 'super_admin') setMatrix(ROLE_PRESETS[next])
  }

  function validate(): string[] {
    const list: string[] = []
    if (!fullName.trim()) list.push('Enter the Name.')
    else if (fullName.trim().length > 100) list.push('Name can be at most 100 characters.')
    if (!editing) {
      if (!isValidUsername(username)) list.push(USERNAME_RULE)
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) list.push(`Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`)
      else if (password !== confirm) list.push('Password and Confirm Password do not match.')
    }
    if (!targetIsSuper && !allMachines && machineIds.filter((mid) => machines.find((m) => m.id === mid)?.active).length === 0) {
      list.push('Choose at least one machine, or All machines.')
    }
    return list
  }

  async function save() {
    const problems = validate()
    setErrors(problems)
    if (problems.length) {
      setTimeout(() => document.querySelector('.user-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
      return
    }
    setSaving(true)
    try {
      const common = {
        fullName: fullName.trim(),
        role,
        active: targetIsSuper ? true : active,
        allMachines: targetIsSuper ? true : allMachines,
        machineIds: allMachines ? [] : machineIds.filter((mid) => machines.find((m) => m.id === mid)?.active),
        permissions: canSetPermissions ? matrixToPayload(resources, matrix) : null,
      }
      if (editing && loaded) {
        await callAdmin({ action: 'update', id: loaded.id, ...common })
        notify('success', `${common.fullName} saved.`)
      } else {
        await callAdmin({ action: 'create', username: normaliseUsername(username), password, ...common })
        notify('success', `User ${normaliseUsername(username)} created. They must change the temporary password at first sign-in.`)
      }
      setDirty(false)
      navigate('/users')
    } catch (err) {
      setErrors([(err as Error).message])
      setTimeout(() => document.querySelector('.user-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="page-status">Loading…</p>
  if (loadError) {
    return (
      <section className="card">
        <p className="notice error">{loadError}</p>
        <Link to="/users" className="button">
          Back to List of Users
        </Link>
      </section>
    )
  }
  if (targetIsSuper && !isSelf) {
    return (
      <section className="card">
        <p className="notice info">The Super Admin account can only be changed by the Super Admin.</p>
        <Link to="/users" className="button">
          Back to List of Users
        </Link>
      </section>
    )
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <Link to="/users" className="back-link">
            <ArrowLeft size={16} /> List of Users
          </Link>
          <h1>{editing ? `Edit User · ${loaded?.full_name}` : 'User Account Creation'}</h1>
          <p className="muted">
            {editing && loaded
              ? `Created ${formatMoment(loaded.created_at)} · last changed ${formatMoment(loaded.updated_at)}`
              : 'The user signs in with the username and this temporary password, then sets their own password.'}
          </p>
        </div>
        {editing && loaded && !isSelf && (
          <div className="actions">
            <button type="button" onClick={() => setResetting(true)}>
              <KeyRound size={17} /> Reset Password
            </button>
          </div>
        )}
      </div>

      <section className="card">
        <h2>Account Details</h2>
        <div className="form-grid">
          <label className="field">
            <span>Name *</span>
            <input value={fullName} maxLength={100} onChange={(e) => (setFullName(e.target.value), touch())} autoComplete="off" />
          </label>
          <label className="field">
            <span>Username *</span>
            <input
              value={username}
              maxLength={40}
              disabled={editing}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => (setUsername(e.target.value.toLowerCase().replace(/\s/g, '')), touch())}
            />
            {!editing && <small className="muted">Small letters, numbers, dot, _ or -. Cannot be changed later.</small>}
          </label>
          {!editing && (
            <>
              <label className="field">
                <span>Password *</span>
                <PasswordInput value={password} maxLength={PASSWORD_MAX} autoComplete="new-password" onChange={(e) => (setPassword(e.target.value), touch())} />
                <small className="muted">At least {PASSWORD_MIN} characters. Temporary: changed at first sign-in.</small>
              </label>
              <label className="field">
                <span>Confirm Password *</span>
                <PasswordInput value={confirm} maxLength={PASSWORD_MAX} autoComplete="new-password" onChange={(e) => (setConfirm(e.target.value), touch())} />
              </label>
            </>
          )}
          <label className="field">
            <span>Role *</span>
            {targetIsSuper ? (
              <input value={ROLE_LABELS.super_admin} disabled />
            ) : (
              <select value={role} onChange={(e) => chooseRole(e.target.value as Role)}>
                {EDITABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="field">
            <span>Account Status *</span>
            <div className="segmented" role="radiogroup" aria-label="Account Status">
              {[true, false].map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={active === v}
                  className={active === v ? 'on' : ''}
                  disabled={targetIsSuper || isSelf}
                  onClick={() => (setActive(v), touch())}
                >
                  {v ? 'Active' : 'Inactive'}
                </button>
              ))}
            </div>
            {!active && <small className="muted">Inactive users cannot sign in.</small>}
          </div>
        </div>
        {editing && loaded?.must_change_password && <p className="notice info">This user has not yet changed their temporary password.</p>}
      </section>

      <section className="card">
        <h2>Machine Access</h2>
        <p className="muted small">Production Entry, BDT and ODT only offer the machines a user may use.</p>
        {targetIsSuper ? (
          <p>The Super Admin can use all machines.</p>
        ) : (
          <>
            <div className="segmented" role="radiogroup" aria-label="Machine access">
              <button type="button" role="radio" aria-checked={allMachines} className={allMachines ? 'on' : ''} onClick={() => (setAllMachines(true), touch())}>
                All machines
              </button>
              <button type="button" role="radio" aria-checked={!allMachines} className={!allMachines ? 'on' : ''} onClick={() => (setAllMachines(false), touch())}>
                Selected machines
              </button>
            </div>
            {!allMachines && (
              <div className="machine-checks">
                {activeMachines.length === 0 && <p className="muted">No machines found.</p>}
                {activeMachines.map((m) => (
                  <label key={m.id} className="check machine-check">
                    <input
                      type="checkbox"
                      checked={machineIds.includes(m.id)}
                      onChange={(e) => {
                        setMachineIds((list) => (e.target.checked ? [...list, m.id] : list.filter((x) => x !== m.id)))
                        touch()
                      }}
                    />
                    <span>
                      {m.code}
                      {m.name && m.name !== m.code ? ` · ${m.name}` : ''}
                      {!m.active && <span className="badge grey small-badge">Inactive · will be removed</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="card" id="permissions">
        <div className="section-head">
          <h2>
            <ShieldCheck size={20} /> Permissions
          </h2>
          {canSetPermissions && role !== 'super_admin' && (
            <button
              type="button"
              className="small"
              onClick={() => {
                setMatrix(ROLE_PRESETS[role as Exclude<Role, 'super_admin'>])
                setMatrixTouched(false)
                touch()
              }}
            >
              <RotateCcw size={15} /> Use {ROLE_LABELS[role]} defaults
            </button>
          )}
        </div>
        {targetIsSuper ? (
          <p>The Super Admin has every permission.</p>
        ) : canSetPermissions ? (
          <>
            <p className="muted small">
              View opens the screen. Create, Edit and Delete each include View. {granted} screen{granted === 1 ? '' : 's'} allowed.
            </p>
            <PermissionMatrix
              resources={resources}
              value={matrix}
              onChange={(next) => {
                setMatrix(next)
                setMatrixTouched(true)
                touch()
              }}
            />
          </>
        ) : (
          <>
            <p className="notice info">
              Only the Super Admin can change permissions.{!editing && ' A new user has no access until the Super Admin assigns it.'}
            </p>
            {editing && <PermissionMatrix resources={resources} value={matrix} onChange={() => undefined} disabled />}
          </>
        )}
      </section>

      {errors.length > 0 && (
        <div className="notice error user-errors" role="alert">
          <b>Please fix {errors.length === 1 ? 'this' : `these ${errors.length} items`} and save again:</b>
          <ul className="error-list">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="entry-footer">
        <button type="button" onClick={() => navigate('/users')} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={save} disabled={saving}>
          <Save size={17} /> {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create User'}
        </button>
      </div>

      {resetting && loaded && (
        <ResetPasswordDialog
          user={loaded}
          onClose={() => setResetting(false)}
          onDone={(message) => {
            setResetting(false)
            notify('success', message)
            setLoaded({ ...loaded, must_change_password: true })
          }}
        />
      )}
    </>
  )
}
