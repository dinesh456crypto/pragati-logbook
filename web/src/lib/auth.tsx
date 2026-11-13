import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
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
  changePassword: (current: string, next: string) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

interface Access {
  profile: Profile
  permissions: PermissionRow[]
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
  if (error || !profile) throw new Error('Your account is not set up yet. Contact the administrator.')
  if (!profile.active) throw new Error('Your account is disabled. Contact the administrator.')
  if (permError) throw new Error('Could not load your permissions. Please try again.')
  return { profile: profile as Profile, permissions: (permissions ?? []) as PermissionRow[] }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (next: Session | null) => {
    setSession(next)
    if (!next) {
      setAccess(null)
      setLoading(false)
      return
    }
    try {
      setAccess(await fetchAccess(next.user.id))
      setError('')
    } catch (err) {
      setAccess(null)
      setError((err as Error).message)
      await supabase.auth.signOut()
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => load(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      // Token refreshes keep the same user; only reload on real changes.
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        // Defer: calling Supabase inside this callback can deadlock the client.
        setTimeout(() => load(next), 0)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [load])

  const signIn = useCallback(async (username: string, password: string) => {
    setError('')
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    })
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
      setAccess(await fetchAccess(profile.id))
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
      changePassword,
    }),
    [loading, session, profile, can, error, signIn, signOut, changePassword],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
