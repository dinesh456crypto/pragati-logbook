// Downtime reasons (Masters → Downtime Reasons), grouped Man | Machine | Material | Others.
import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { DowntimeGroup } from './production'

export interface DowntimeReason {
  id: string
  name: string
  category: DowntimeGroup
  active: boolean
}

export function useDowntimeReasons(): DowntimeReason[] {
  const [rows, setRows] = useState<DowntimeReason[]>([])
  useEffect(() => {
    supabase
      .from('downtime_reasons')
      .select('id, name, category, active')
      .order('name')
      .then(({ data }) => setRows((data ?? []) as DowntimeReason[]))
  }, [])
  return rows
}

export const reasonGroup = (reasons: DowntimeReason[], id: string | null | undefined) =>
  reasons.find((r) => r.id === id)?.category ?? null
