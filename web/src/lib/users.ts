// User Management: list rows, permission presets, and the admin-users Edge Function.
import { supabase } from './supabase'
import type { Resource, Role } from './types'

export interface UserRow {
  id: string
  username: string
  full_name: string
  role: Role
  active: boolean
  all_machines: boolean
  must_change_password: boolean
  created_at: string
  updated_at: string
  last_sign_in_at: string | null
  machine_codes: string[]
  permission_count: number
}

export interface ResourceRow {
  key: Resource
  module: string
  label: string
  sort_order: number
}

export const RIGHTS = ['view', 'create', 'edit', 'delete'] as const
export type Right = (typeof RIGHTS)[number]
export type Grant = Record<Right, boolean>
export type Matrix = Partial<Record<Resource, Grant>>

export const EDITABLE_ROLES: Exclude<Role, 'super_admin'>[] = ['manager', 'supervisor', 'operator', 'office_user']

const g = (rights: string): Grant => ({
  view: rights.includes('v'),
  create: rights.includes('c'),
  edit: rights.includes('e'),
  delete: rights.includes('d'),
})

// Starting permissions for each role; the Super Admin can change any box afterwards.
export const ROLE_PRESETS: Record<Exclude<Role, 'super_admin'>, Matrix> = {
  manager: {
    dashboard: g('v'),
    production_entry: g('vced'),
    downtime: g('vced'),
    production_log: g('v'),
    production_plan: g('vced'),
    masters: g('vce'),
    users: g('v'),
    ink_formula: g('vced'),
    wastage: g('vced'),
  },
  supervisor: {
    dashboard: g('v'),
    production_entry: g('vce'),
    downtime: g('vce'),
    production_log: g('v'),
    production_plan: g('v'),
    masters: g('v'),
    ink_formula: g('v'),
    wastage: g('vce'),
  },
  operator: {
    dashboard: g('v'),
    production_entry: g('vce'),
    downtime: g('vc'),
  },
  office_user: {
    dashboard: g('v'),
    production_log: g('v'),
    production_plan: g('vce'),
    masters: g('v'),
    ink_formula: g('vce'),
    wastage: g('vce'),
  },
}

export const emptyGrant = (): Grant => ({ view: false, create: false, edit: false, delete: false })

// Create, Edit and Delete need View: ticking one ticks View, unticking View clears the rest.
export function setRight(grant: Grant | undefined, right: Right, on: boolean): Grant {
  const next = { ...(grant ?? emptyGrant()), [right]: on }
  if (right === 'view' && !on) return emptyGrant()
  if (right !== 'view' && on) next.view = true
  return next
}

export const matrixToPayload = (resources: ResourceRow[], m: Matrix) =>
  resources.map((r) => ({ resource: r.key, ...(m[r.key] ?? emptyGrant()) })).filter((x) => x.view)

export const grantText = (gr: Grant | undefined) =>
  gr?.view ? RIGHTS.filter((r) => gr[r]).map((r) => r[0].toUpperCase() + r.slice(1)).join(', ') : 'No access'

export const USERNAME_RULE = 'Username must be 3–40 characters: small letters, numbers, dots, underscores or hyphens, starting with a letter or number.'

interface AdminBody {
  action: 'create' | 'update' | 'set_active' | 'reset_password' | 'delete'
  id?: string
  username?: string
  fullName?: string
  role?: Role
  active?: boolean
  allMachines?: boolean
  machineIds?: string[]
  permissions?: ({ resource: Resource } & Grant)[] | null
  password?: string
}

// Calls the admin-users Edge Function and turns its errors into plain messages.
export async function callAdmin(body: AdminBody): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body })
  if (!error) return data
  let message = error.message
  const context = (error as { context?: unknown }).context
  if (context instanceof Response) {
    try {
      const parsed = (await context.clone().json()) as { error?: string; message?: string }
      message = parsed.error ?? parsed.message ?? message
    } catch {
      /* not JSON */
    }
    if (context.status === 404) message = 'The user service is not installed on the server yet. Ask the developer to deploy the admin-users function.'
  } else if (/fetch|network|send a request/i.test(message)) {
    message = 'Cannot reach the server. Check the internet connection and try again.'
  }
  throw new Error(message)
}
