// Downtime and wastage reasons (Masters), each with a category. (File name kept from when it held only downtime.)
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export interface Reason<G extends string = string> {
  id: string
  name: string
  category: G
  active: boolean
}

export function useReasons<G extends string = string>(table: 'downtime_reasons' | 'wastage_reasons'): Reason<G>[] {
  const [rows, setRows] = useState<Reason<G>[]>([])
  useEffect(() => {
    supabase
      .from(table)
      .select('id, name, category, active')
      .order('name')
      .then(({ data }) => setRows((data ?? []) as Reason<G>[]))
  }, [table])
  return rows
}

export const reasonGroup = (reasons: Reason[], id: string | null | undefined) => reasons.find((r) => r.id === id)?.category ?? null
