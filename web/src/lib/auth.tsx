import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { usernameToEmail } from './username'
import type { Action, PermissionRow, Profile, Resource } from './types'

interface AuthState {
  loading: boolean
  session: Session | null
  profile: Profile | null
  isSuperAdmin: boolean
  can: (resource: Resource, action?: Action) => boolean
  error: string
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  retry: () => void
  changePassword: (current: string, next: string) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

interface Access {
  profile: Profile
  permissions: PermissionRow[]
}

// A problem loading the account. "fatal" ones (no profile, disabled) sign the user
// out; others (no network, a server hiccup) keep the user signed in and are retried.
class AccessError extends Error {
  fatal: boolean
  constructor(message: string, fatal: boolean) {
    super(message)
    this.fatal = fatal
  }
}
const OFFLINE = 'Cannot reach the server. Check the internet connection and try again.'

// Signed out after this long without any use of the app (tap, click, key, scroll).
const IDLE_LIMIT_MS = 60 * 60 * 1000
const ACTIVITY_KEY = 'pragati-last-activity'
const IDLE_MESSAGE = 'You were signed out after 1 hour without activity. Please sign in again.'
const readActivity = () => {
  try {
    return Number(localStorage.getItem(ACTIVITY_KEY)) || 0
  } catch {
    return 0
  }
}
const writeActivity = (at: number) => {
  try {
    localStorage.setItem(ACTIVITY_KEY, String(at))
  } catch {
    /* storage unavailable: the in-memory time is still used */
  }
}

// Loads the profile and the effective permissions decided by the database.
// The browser only uses these to show or hide screens; the database enforces them.
async function fetchAccess(userId: string): Promise<Access> {
  const [{ data: profile, error }, { data: permissions, error: permError }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, username, full_name, role, active, all_machines, must_change_password')
      .eq('id', userId)
      .single(),
    supabase.rpc('my_permissions'),
  ])
  // PGRST116: no profile row for this login.
  if (error && error.code !== 'PGRST116') throw new AccessError(OFFLINE, false)
  if (!profile) throw new AccessError('Your account is not set up yet. Contact the administrator.', true)
  if (!profile.active) throw new AccessError('Your account is disabled. Contact the administrator.', true)
  if (permError) throw new AccessError(OFFLINE, false)
  return { profile: profile as Profile, permissions: (permissions ?? []) as PermissionRow[] }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [error, setError] = useState('')
  const accessRef = useRef<Access | null>(null)
  const sessionRef = useRef<Session | null>(null)

  // The browser also reports "signed in" each time the app comes back to the
  // screen; for the same user that only refreshes the permissions in the background,
  // and a dropped connection at that moment never signs anyone out.
  const load = useCallback(async (next: Session | null) => {
    setSession(next)
    sessionRef.current = next
    if (!next) {
      accessRef.current = null
      setAccess(null)
      setLoading(false)
      return
    }
    const sameUser = accessRef.current?.profile.id === next.user.id
    const tries = sameUser ? 1 : 2
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const fresh = await fetchAccess(next.user.id)
        accessRef.current = fresh
        setAccess(fresh)
        setError('')
        break
      } catch (err) {
        const e = err as AccessError
        if (e.fatal) {
          accessRef.current = null
          setAccess(null)
          setError(e.message)
          await supabase.auth.signOut({ scope: 'local' })
          break
        }
        if (sameUser) break // keep working with what is already loaded
        if (attempt < tries) await new Promise((res) => setTimeout(res, 1500 * attempt))
        else setError(e.message) // still signed in: the screen offers "Try again"
      }
    }
    setLoading(false)
  }, [])

  const retry = useCallback(() => {
    setLoading(true)
    supabase.auth.getSession().then(({ data }) => load(data.session))
  }, [load])

  useEffect(() => {
    // Opening the app after more than an hour without use: sign in again.
    supabase.auth.getSession().then(async ({ data }) => {
      const last = readActivity()
      if (data.session && last && Date.now() - last > IDLE_LIMIT_MS) {
        setError(IDLE_MESSAGE)
        await supabase.auth.signOut({ scope: 'local' })
        load(null)
        return
      }
      if (data.session) writeActivity(Date.now())
      load(data.session)
    })
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      // Token refreshes keep the same user; only reload on real changes.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer: calling Supabase inside this callback can deadlock the client.
        setTimeout(() => load(next), 0)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [load])

  // Sign out after one hour without any activity (not one hour after signing in).
  // The last activity time is shared by all tabs of the app.
  useEffect(() => {
    if (!session) return
    let lastWrite = 0
    const mark = () => {
      const now = Date.now()
      if (now - lastWrite > 15000) {
        lastWrite = now
        writeActivity(now)
      }
    }
    const expired = () => {
      const last = readActivity()
      return last > 0 && Date.now() - last > IDLE_LIMIT_MS
    }
    const check = () => {
      if (!expired() || !sessionRef.current) return
      setError(IDLE_MESSAGE)
      supabase.auth.signOut({ scope: 'local' })
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      check() // first: was the app left unused for an hour?
      mark()
    }
    mark()
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const
    for (const ev of events) window.addEventListener(ev, mark, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(check, 30000)
    return () => {
      for (const ev of events) window.removeEventListener(ev, mark, { capture: true })
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(timer)
    }
  }, [session])

  const signIn = useCallback(async (username: string, password: string) => {
    setError('')
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    })
    if (!authError) writeActivity(Date.now())
    if (authError) {
      // A failed connection is not a wrong password.
      const offline = authError.status === 0 || /fetch|network/i.test(authError.message) || authError.name === 'AuthRetryableFetchError'
      throw new Error(offline ? 'Cannot reach the server. Check the internet connection and try again.' : 'Invalid username or password.')
    }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const profile = access?.profile ?? null

  const changePassword = useCallback(
    async (current: string, next: string) => {
      if (!profile) throw new Error('Please sign in again.')
      if (current === next) throw new Error('Choose a different new password.')
      // Confirm the current password before changing it.
      const check = await supabase.auth.signInWithPassword({
        email: usernameToEmail(profile.username),
        password: current,
      })
      if (check.error) throw new Error('Current password is incorrect.')
      const { error: updateError } = await supabase.auth.updateUser({ password: next })
      if (updateError) throw new Error(updateError.message)
      const { error: rpcError } = await supabase.rpc('mark_password_changed')
      if (rpcError) throw new Error(rpcError.message)
      const fresh = await fetchAccess(profile.id)
      accessRef.current = fresh
      setAccess(fresh)
    },
    [profile],
  )

  const can = useCallback(
    (resource: Resource, action: Action = 'view') => {
      const row = access?.permissions.find((p) => p.resource === resource)
      if (!row) return false
      return row.can_view && (action === 'view' || row[`can_${action}`])
    },
    [access],
  )

  const value = useMemo(
    () => ({
      loading,
      session,
      profile,
      isSuperAdmin: profile?.role === 'super_admin',
      can,
      error,
      signIn,
      signOut,
      retry,
      changePassword,
    }),
    [loading, session, profile, can, error, signIn, signOut, retry, changePassword],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
