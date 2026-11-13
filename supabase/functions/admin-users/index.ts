// User management: create, edit, activate/deactivate, reset password, delete.
// Creating login accounts and setting passwords needs the secret key, so it runs
// here on the server and never in the browser. Profile, machine access and
// permissions are saved by admin_save_user() using the caller's own session, so
// the database re-checks the caller's Users permission and Super Admin rules.
import { createClient } from 'npm:@supabase/supabase-js@2'

const LOGIN_DOMAIN = 'pragati.internal' // keep in sync with web/src/lib/username.ts
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/
const BANNED_FOR = '876000h' // ~100 years: how Supabase disables sign-in

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface PermissionRow {
  resource: string
  view: boolean
  create: boolean
  edit: boolean
  delete: boolean
}

type Action = 'create' | 'update' | 'set_active' | 'reset_password' | 'delete'

interface Payload {
  action: Action
  id?: string
  username?: string
  fullName: string
  role: 'super_admin' | 'manager' | 'supervisor' | 'operator' | 'office_user'
  active: boolean
  allMachines: boolean
  machineIds: string[]
  permissions?: PermissionRow[] | null // Super Admin only; omit to leave unchanged
  password?: string
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// Supabase injects its current API keys as JSON dictionaries keyed by name.
// Falls back to the legacy anon/service_role variables, deprecated end of 2026.
function defaultKey(name: string): string | undefined {
  try {
    const keys = JSON.parse(Deno.env.get(name) ?? '{}') as Record<string, string>
    return keys.default ?? Object.values(keys)[0]
  } catch {
    return undefined
  }
}

function checkPassword(p: string) {
  const bytes = new TextEncoder().encode(p).length
  if (p.length < 12 || bytes > 72) throw new Error('Use a password with 12–72 characters.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' })

  const url = Deno.env.get('SUPABASE_URL')!
  const publishableKey = defaultKey('SUPABASE_PUBLISHABLE_KEYS') ?? Deno.env.get('SUPABASE_ANON_KEY')
  const secretKey = defaultKey('SUPABASE_SECRET_KEYS') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!publishableKey || !secretKey) return reply(500, { error: 'Server keys are not configured.' })
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return reply(401, { error: 'Please sign in again.' })

  // Client acting as the signed-in caller (RLS and permission checks apply).
  const asCaller = createClient(url, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  })
  // Privileged client for Supabase Auth admin calls only.
  const service = createClient(url, secretKey, { auth: { persistSession: false } })

  try {
    const { data: who, error: whoError } = await asCaller.auth.getUser(token)
    if (whoError || !who.user) return reply(401, { error: 'Please sign in again.' })

    const body = (await req.json()) as Payload
    const actions: Action[] = ['create', 'update', 'set_active', 'reset_password', 'delete']
    if (!body || !actions.includes(body.action)) throw new Error('Invalid request.')
    if (body.password) checkPassword(body.password)

    const need = body.action === 'create' ? 'create' : body.action === 'delete' ? 'delete' : 'edit'
    const { data: allowed } = await asCaller.rpc('has_perm', { p_resource: 'users', p_action: need })
    if (!allowed) return reply(403, { error: `You do not have permission to ${need} users.` })

    // Activate / deactivate: the database checks the rules, then the login is (un)banned.
    if (body.action === 'set_active') {
      if (!body.id) throw new Error('Missing user id.')
      const { data: profile, error: rpcError } = await asCaller.rpc('admin_set_user_active', { p_id: body.id, p_active: !!body.active })
      if (rpcError) throw new Error(rpcError.message)
      const { error } = await service.auth.admin.updateUserById(body.id, { ban_duration: body.active ? 'none' : BANNED_FOR })
      if (error) throw new Error(`Status saved, but the login could not be updated: ${error.message}`)
      return reply(200, { ok: true, profile })
    }

    // Password reset: a temporary password the user must change at next sign-in.
    if (body.action === 'reset_password') {
      if (!body.id) throw new Error('Missing user id.')
      if (!body.password) throw new Error('Enter the new temporary password.')
      const { data: profile, error: rpcError } = await asCaller.rpc('admin_mark_password_reset', { p_id: body.id })
      if (rpcError) throw new Error(rpcError.message)
      const { error } = await service.auth.admin.updateUserById(body.id, { password: body.password })
      if (error) throw new Error(`The password could not be changed: ${error.message}`)
      return reply(200, { ok: true, profile })
    }

    // Delete: only users without any records (the database refuses otherwise).
    if (body.action === 'delete') {
      if (!body.id) throw new Error('Missing user id.')
      const { error: rpcError } = await asCaller.rpc('admin_delete_user', { p_id: body.id })
      if (rpcError) throw new Error(rpcError.message)
      const { error } = await service.auth.admin.deleteUser(body.id)
      if (error) throw new Error(`The user was removed, but the login could not be deleted: ${error.message}`)
      return reply(200, { ok: true })
    }

    if (!Array.isArray(body.machineIds)) throw new Error('Invalid machine list.')

    const save = (id: string, username: string) =>
      asCaller.rpc('admin_save_user', {
        p_id: id,
        p_username: username,
        p_full_name: body.fullName,
        p_role: body.role,
        p_active: body.active,
        p_all_machines: body.allMachines,
        p_machine_ids: body.machineIds,
        p_permissions: body.permissions ?? null,
        // A new or reset password is temporary and must be changed at next sign-in.
        p_must_change_password: body.password ? true : null,
      })

    if (body.action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase()
      if (!USERNAME.test(username)) {
        throw new Error('Username must be 3–40 letters, numbers, dots, underscores or hyphens.')
      }
      if (!body.password) throw new Error('Set a temporary password for the new user.')
      const { data, error } = await service.auth.admin.createUser({
        email: `${username}@${LOGIN_DOMAIN}`,
        password: body.password,
        email_confirm: true,
        user_metadata: { username },
      })
      if (error || !data.user) {
        throw new Error(error?.message.includes('already') ? 'That username is already taken.' : error?.message)
      }
      const { data: profile, error: rpcError } = await save(data.user.id, username)
      if (rpcError) {
        await service.auth.admin.deleteUser(data.user.id) // don't leave a login without a profile
        throw new Error(rpcError.message)
      }
      if (!body.active) await service.auth.admin.updateUserById(data.user.id, { ban_duration: BANNED_FOR })
      return reply(200, { ok: true, profile })
    }

    // Update: the database checks the rules first, then Auth is changed.
    if (!body.id) throw new Error('Missing user id.')
    const { data: existing } = await asCaller.from('profiles').select('username').eq('id', body.id).single()
    if (!existing) throw new Error('User not found.')
    const { data: profile, error: rpcError } = await save(body.id, existing.username)
    if (rpcError) throw new Error(rpcError.message)

    const changes: Record<string, unknown> = { ban_duration: body.active ? 'none' : BANNED_FOR }
    if (body.password) changes.password = body.password
    const { error } = await service.auth.admin.updateUserById(body.id, changes)
    if (error) throw new Error(`Profile saved, but the login could not be updated: ${error.message}`)

    // A disabled user is banned in Auth (no new sign-ins or token refreshes) and
    // loses data access at once, because every permission check requires profiles.active.
    return reply(200, { ok: true, profile })
  } catch (err) {
    return reply(400, { error: (err as Error).message || 'Request failed.' })
  }
})
