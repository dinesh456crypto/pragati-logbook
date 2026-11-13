import {
  CalendarRange,
  Database,
  Droplets,
  Factory,
  LayoutDashboard,
  UsersRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Action, Resource } from './types'

export interface NavItem {
  label: string
  path: string
  resource: Resource
  action?: Action // permission needed to see the item (default: view)
  phase: number // build phase that delivers this screen
}

export interface NavModule {
  label: string
  icon: LucideIcon
  items: NavItem[]
}

const master = (label: string, slug: string): NavItem => ({
  label,
  path: `/masters/${slug}`,
  resource: 'masters',
  phase: 2,
})

export const NAV: NavModule[] = [
  {
    label: 'Dashboard',
    icon: LayoutDashboard,
    items: [{ label: 'Overview', path: '/dashboard', resource: 'dashboard', phase: 1 }],
  },
  {
    label: 'Production',
    icon: Factory,
    items: [
      { label: 'Production Entry', path: '/production/entry', resource: 'production_entry', phase: 4 },
      { label: 'BDT – Breakdown Time', path: '/production/bdt', resource: 'bdt', phase: 5 },
      { label: 'ODT – Other Downtime', path: '/production/odt', resource: 'odt', phase: 5 },
      { label: 'Production Log Summary', path: '/production/log', resource: 'production_log', phase: 6 },
    ],
  },
  {
    label: 'Production Plan',
    icon: CalendarRange,
    items: [{ label: 'Job Details', path: '/plan/jobs', resource: 'production_plan', phase: 3 }],
  },
  {
    label: 'Master',
    icon: Database,
    items: [
      master('Machines', 'machines'),
      master('Operators', 'operators'),
      master('Supervisors', 'supervisors'),
      master('QC Executives', 'qc-executives'),
      master('Units', 'units'),
      master('Paper Type', 'paper-types'),
      master('Coating', 'coatings'),
      master('Wastage Reasons', 'wastage-reasons'),
      master('BDT Reasons', 'bdt-reasons'),
      master('ODT Reasons', 'odt-reasons'),
    ],
  },
  {
    label: 'User Management',
    icon: UsersRound,
    items: [
      { label: 'User Account Creation', path: '/users/new', resource: 'users', action: 'create', phase: 7 },
      { label: 'List of Users', path: '/users', resource: 'users', phase: 7 },
    ],
  },
  {
    label: 'Ink Formula Management',
    icon: Droplets,
    items: [
      { label: 'Ink Formula Entry', path: '/ink/entry', resource: 'ink_formula', phase: 8 },
      { label: 'Ink Formula Job Summary', path: '/ink/summary', resource: 'ink_formula', phase: 8 },
    ],
  },
]

export function findNav(pathname: string): { module: NavModule; item: NavItem } | null {
  for (const module of NAV) {
    const item = module.items.find((i) => i.path === pathname)
    if (item) return { module, item }
  }
  return null
}
