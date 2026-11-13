export type Role = 'super_admin' | 'manager' | 'supervisor' | 'operator' | 'office_user'

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  manager: 'Manager',
  supervisor: 'Supervisor',
  operator: 'Operator',
  office_user: 'Office User',
}

// Keep in sync with public.permission_resources.
export type Resource =
  | 'dashboard'
  | 'production_entry'
  | 'bdt'
  | 'odt'
  | 'production_log'
  | 'production_plan'
  | 'masters'
  | 'users'
  | 'ink_formula'
  | 'wastage'

export type Action = 'view' | 'create' | 'edit' | 'delete'

export interface PermissionRow {
  resource: Resource
  can_view: boolean
  can_create: boolean
  can_edit: boolean
  can_delete: boolean
}

export interface Profile {
  id: string
  username: string
  full_name: string
  role: Role
  active: boolean
  all_machines: boolean
  must_change_password: boolean
}

export interface Machine {
  id: string
  code: string
  name: string
  active: boolean
  default_speed: number
  sort_order: number
}
