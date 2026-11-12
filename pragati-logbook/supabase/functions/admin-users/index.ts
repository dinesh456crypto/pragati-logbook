// Admin-only user management. Creating auth users and setting passwords needs
// the service-role key, so it runs here on the server and never in the browser.
// Profile fields and machine access are written by admin_upsert_user() using the
// caller's own session, so the database re-checks that the caller is an admin.
import { createClient } from 'npm:@supabase/supabase-js@2'

const LOGIN_DOMAIN = 'pragati.internal' // keep in sync with web/src/lib/username.ts
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/
const BANNED_FOR = '876000h' // ~100 years: how Supabase disables sign-in

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Payload {
  action: 'create' | 'update'
  id?: string
  username?: string
  fullName: string
  role: 'admin' | 'operator'
  active: boolean
  machineIds: string[]
  password?: string
}

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function checkPassword(p: string) {
  const bytes = new TextEncoder().encode(p).length
  if (p.length < 12 || bytes > 72) throw new Error('Use a password with 12–72 characters.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' })

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') ?? ''

  // Client acting as the signed-in caller (RLS and is_admin() apply).
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  // Privileged client for Supabase Auth admin calls only.
  const service = createClient(url, serviceKey, { auth: { persistSession: false } })

  try {
    const { data: who, error: whoError } = await asCaller.auth.getUser()
    if (whoError || !who.user) return reply(401, { error: 'Please sign in again.' })
    const { data: isAdmin } = await asCaller.rpc('is_admin')
    if (!isAdmin) return reply(403, { error: 'Administrator access is required.' })

    const body = (await req.json()) as Payload
    if (!body || !['create', 'update'].includes(body.action)) throw new Error('Invalid request.')
    if (!Array.isArray(body.machineIds)) throw new Error('Invalid machine list.')
    if (body.password) checkPassword(body.password)

    let userId = body.id ?? ''
    let createdNow = false

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
      userId = data.user.id
      createdNow = true
    } else {
      if (!userId) throw new Error('Missing user id.')
      const { data: existing } = await asCaller.from('profiles').select('username').eq('id', userId).single()
      if (!existing) throw new Error('User not found.')
      body.username = existing.username
      const changes: Record<string, unknown> = { ban_duration: body.active ? 'none' : BANNED_FOR }
      if (body.password) changes.password = body.password
      const { error } = await service.auth.admin.updateUserById(userId, changes)
      if (error) throw new Error(error.message)
    }

    const { data: profile, error: rpcError } = await asCaller.rpc('admin_upsert_user', {
      p_id: userId,
      p_username: body.username,
      p_full_name: body.fullName,
      p_role: body.role,
      p_active: body.active,
      p_machine_ids: body.machineIds,
      // A new or reset password is temporary and must be changed at next sign-in.
      p_must_change_password: body.password ? true : null,
    })

    if (rpcError) {
      // Don't leave an auth user without a profile behind.
      if (createdNow) await service.auth.admin.deleteUser(userId)
      throw new Error(rpcError.message)
    }

    // A disabled user is banned in Auth (no new sign-ins or token refreshes) and
    // loses data access at once, because every RLS policy checks profiles.active.
    return reply(200, { ok: true, profile })
  } catch (err) {
    return reply(400, { error: (err as Error).message || 'Request failed.' })
  }
})
