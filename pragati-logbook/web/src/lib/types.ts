export type Role = 'admin' | 'operator'

export interface Profile {
  id: string
  username: string
  full_name: string
  role: Role
  active: boolean
  must_change_password: boolean
}

export interface Machine {
  id: string
  code: string
  name: string | null
  active: boolean
}
