// Turns database errors into messages a shop-floor user can act on.
interface DbError {
  code?: string
  message?: string
  details?: string
}

export function friendlyError(err: unknown, what = 'record'): string {
  const e = (err ?? {}) as DbError
  switch (e.code) {
    case '23505':
      return `This ${what} already exists. Use a different name.`
    case '23503':
      return `This ${what} is used in other records, so it cannot be deleted. Mark it Inactive instead.`
    case '42501':
      return 'You do not have permission to do this.'
    case '23514':
      return 'Some values are not allowed. Check the fields and try again.'
    case 'PGRST301':
    case 'PGRST303':
      return 'Your session has expired. Please sign in again.'
  }
  if (e.message?.includes('row-level security')) return 'You do not have permission to do this.'
  if (e.message?.toLowerCase().includes('failed to fetch')) return 'No connection. Check the network and try again.'
  return e.message || 'Something went wrong. Please try again.'
}
