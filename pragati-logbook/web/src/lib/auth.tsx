import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { usernameToEmail } from './username'
import type { Profile } from './types'

interface AuthState {
  loading: boolean
  session: Session | null
  profile: Profile | null
  error: string
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
  reloadProfile: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, full_name, role, active, must_change_password')
    .eq('id', userId)
    .single()
  if (error || !data) throw new Error('Your account is not set up yet. Contact the administrator.')
  if (!data.active) throw new Error('Your account is disabled. Contact the administrator.')
  return data as Profile
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (next: Session | null) => {
    setSession(next)
    if (!next) {
      setProfile(null)
      setLoading(false)
      return
    }
    try {
      setProfile(await fetchProfile(next.user.id))
      setError('')
    } catch (err) {
      setProfile(null)
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
    if (authError) throw new Error('Invalid username or password.')
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

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
      setProfile(await fetchProfile(profile.id))
    },
    [profile],
  )

  const reloadProfile = useCallback(async () => {
    if (session) setProfile(await fetchProfile(session.user.id))
  }, [session])

  const value = useMemo(
    () => ({ loading, session, profile, error, signIn, signOut, changePassword, reloadProfile }),
    [loading, session, profile, error, signIn, signOut, changePassword, reloadProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
