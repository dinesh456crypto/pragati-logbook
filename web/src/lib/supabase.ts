import { createClient } from '@supabase/supabase-js'

const projectUrl = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!projectUrl || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy web/.env.example to web/.env.local and fill both in.',
  )
}

// On the live site the browser reaches Supabase through this site's own
// /supabase path (see worker/index.js), because some internet providers block
// *.supabase.co. Local development talks to the project directly.
const direct = import.meta.env.DEV || import.meta.env.VITE_SUPABASE_DIRECT === '1'
const url = direct ? projectUrl : `${window.location.origin}/supabase`

// Keep the saved sign-in under the project's name, whichever address is used.
const storageKey = `sb-${new URL(projectUrl).hostname.split('.')[0]}-auth-token`

// The publishable key is safe in the browser: every table is protected by
// Row Level Security policies in supabase/migrations.
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey },
})
