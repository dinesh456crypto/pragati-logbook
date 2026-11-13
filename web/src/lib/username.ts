// Operators sign in with a username, not an email. Supabase Auth is
// email-based, so each username maps to an internal address that never
// receives mail. Keep this domain in sync with supabase/functions/admin-users.
export const LOGIN_DOMAIN = 'pragati.internal'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/

// Accepts "dinesh", " Dinesh " and the internal login form "dinesh@pragati.internal".
export function normaliseUsername(value: string): string {
  const v = value.trim().toLowerCase()
  const suffix = `@${LOGIN_DOMAIN}`
  return v.endsWith(suffix) ? v.slice(0, -suffix.length) : v
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normaliseUsername(value))
}

export function usernameToEmail(value: string): string {
  return `${normaliseUsername(value)}@${LOGIN_DOMAIN}`
}

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 72
