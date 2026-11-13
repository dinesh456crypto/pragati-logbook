import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy web/.env.example to web/.env.local and fill both in.',
  )
}

// The publishable key is safe in the browser: every table is protected by
// Row Level Security policies in supabase/migrations.
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
})
