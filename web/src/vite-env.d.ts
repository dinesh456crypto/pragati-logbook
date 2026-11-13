/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_SUPABASE_DIRECT?: string // '1' = call Supabase directly (tests)
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
