import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { JOB_TYPES, cleanColours, formatDate, formatNumber } from '../lib/jobs'
import {
  ACTIVITIES,
  HELPERS,
  PRINT_SIDES,
  SECTIONS,
  UNIT_COUNT,
  applyAutoStarts,
  autoChanges,
  DOWNTIME_COLUMNS,
  WASTAGE_COLUMNS,
  downtimeGroupLabel,
  autoStartOf,
  changeoverRequired,
  changeoverTotals,
  defaultProductionDate,
  downtimeOverlaps,
  downtimePlacement,
  emptyDowntime,
  entryLabel,
  formatDuration,
  formatMoment,
  fromRow,
  isoToStamp,
  newEntryState,
  nowStamp,
  sectionOf,
  sideFamily,
  spanComplete,
  stampMs,
  stepTimes,
  time12,
  toPayload,
  wastageTotal,
} from '../lib/production'
import type {
  DowntimeDbRow,
  DowntimeGroup,
  WastageGroup,
  EntryRow,
  EntryState,
  FieldError,
  OrderOption,
  OrderStatus,
  Span,
  StepKey,
  Timeline,
} from '../lib/production'
import type { Machine } from '../lib/types'
import { plantDate } from '../lib/dates'
import { OrderPicker } from '../components/OrderPicker'
import { ScanButton } from '../components/ScanButton'
import { ReasonPicker } from '../components/DowntimeReasons'
import { reasonGroup, useReasons } from '../lib/downtime'
import { TimeCard } from '../components/TimeCard'
import { Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

interface Option {
  id: string
  name: string
  active: boolean
}

interface Meta {
  id: string
  entryNo: number | null
  status: 'new' | 'draft' | 'submitted'
  updatedAt: string | null
  createdBy: string | null
}

interface DraftInfo {
  id: string
  entry_no: number
  order_no: string | null
  job_name: string | null
  production_date: string
  shift: string | null
  updated_at: string
}

type SaveResult =
  | { ok: true; id: string; entry_no: number; status: 'draft' | 'submitted'; updated_at: string }
  | { ok: false; code: 'INVALID'; errors: FieldError[] }
  | { ok: false; code: 'STALE'; message: string }
  | { ok: false; code: 'DRAFT_EXISTS'; message: string; draft: DraftInfo }

// /production/entry/new and /production/entry/:id
export function ProductionEntryPage() {
  const { id } = useParams()
  return <EntryEditor key={id ?? 'new'} entryId={id ?? null} />
}

function useOptions(table: string) {
  const [rows, setRows] = useState<Option[]>([])
  useEffect(() => {
    supabase
      .from(table)
      .select('id, name, active')
      .order('name')
      .then(({ data }) => setRows((data ?? []) as Option[]))
  }, [table])
  return rows
}

// Active choices, plus the one already saved even if it was made inactive later.
const choices = (rows: Option[], current: string) => rows.filter((r) => r.active || r.id === current)

function EntryEditor({ entryId }: { entryId: string | null }) {
  const { can, profile } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()

  const [st, setSt] = useState<EntryState>(newEntryState)
  const [meta, setMeta] = useState<Meta>(() => ({
    id: entryId ?? crypto.randomUUID(),
    entryNo: null,
    status: 'new',
    updatedAt: null,
    createdBy: null,
  }))
  const [loading, setLoading] = useState(Boolean(entryId))
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState(0)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [status, setStatus] = useState<OrderStatus | null>(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [closeSide, setCloseSide] = useState(false)
  const [conflict, setConflict] = useState<DraftInfo | null>(null)
  const [stale, setStale] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const touch = useCallback(() => {
    dirtyRef.current = true
    setDirty(true)
  }, [])
  const markClean = () => {
    dirtyRef.current = false
    setDirty(false)
  }
  // Automatic draft saving.
  const [autoNote, setAutoNote] = useState<{ kind: 'ok' | 'busy' | 'error'; text: string } | null>(null)
  const inFlight = useRef<Promise<unknown> | null>(null)
  // Open drafts on other machines: one entry per machine at a time.
  const [machineDrafts, setMachineDrafts] = useState<(DraftInfo & { machine_id: string })[]>([])
  const [machineBlock, setMachineBlock] = useState<(DraftInfo & { machine_id: string }) | null>(null)

  const [machines, setMachines] = useState<Machine[]>([])
  const [myMachines, setMyMachines] = useState<string[] | null>(null)
  const [orders, setOrders] = useState<OrderOption[]>([])
  const operators = useOptions('operators')
  const supervisors = useOptions('supervisors')
  const qcs = useOptions('qc_executives')
  const coatings = useOptions('coatings')
  const papers = useOptions('paper_types')
  const downtimeReasons = useReasons<DowntimeGroup>('downtime_reasons')
  const wastageReasons = useReasons<WastageGroup>('wastage_reasons')
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  // Latest order status, for rules applied inside state updates.
  const statusRef = useRef<OrderStatus | null>(null)
  const readyRef = useRef<ReturnType<typeof isoToStamp> | null>(null)

  const editable =
    meta.status === 'submitted'
      ? can('production_entry', 'edit')
      : can('production_entry', 'create') || can('production_entry', 'edit')
  const readOnly = !editable

  // ---- Loading -----------------------------------------------------------------
  useEffect(() => {
    supabase
      .from('machines')
      .select('id, code, name, active, default_speed, sort_order')
      .order('sort_order')
      .order('code')
      .then(({ data }) => setMachines((data ?? []) as Machine[]))
    supabase.rpc('production_order_options').then(({ data }) => setOrders((data ?? []) as OrderOption[]))
  }, [])

  useEffect(() => {
    supabase
      .from('production_entries')
      .select('id, entry_no, machine_id, order_no, job_name, production_date, shift, updated_at')
      .eq('status', 'draft')
      .then(({ data }) => setMachineDrafts((data ?? []) as (DraftInfo & { machine_id: string })[]))
  }, [])

  useEffect(() => {
    if (!profile) return
    if (profile.role === 'super_admin' || profile.all_machines) return
    supabase
      .from('profile_machines')
      .select('machine_id')
      .eq('profile_id', profile.id)
      .then(({ data }) => setMyMachines((data ?? []).map((r: { machine_id: string }) => r.machine_id)))
  }, [profile])

  // Fills the automatic start times (each step starts when the previous one ended).
  // For a submitted entry the first step is never moved to a new machine-ready time.
  const withAuto = useCallback(
    (s: EntryState, submitted = meta.status === 'submitted') =>
      applyAutoStarts(
        s,
        submitted ? null : readyRef.current,
        changeoverRequired(s.print_side, s.continuing, statusRef.current?.is_first ?? true),
      ),
    [meta.status],
  )

  const timelineRequest = useRef(0)
  const fetchTimeline = useCallback(
    async (machineId: string, submitted: boolean) => {
      const ticket = ++timelineRequest.current
      if (!machineId) {
        setTimeline(null)
        readyRef.current = null
        return
      }
      const { data, error } = await supabase.rpc('machine_timeline', { p_machine_id: machineId, p_entry_id: meta.id })
      if (ticket !== timelineRequest.current) return
      if (error) {
        notify('error', friendlyError(error))
        return
      }
      const t = data as Timeline
      setTimeline(t)
      readyRef.current = t.ready_at ? isoToStamp(t.ready_at) : null
      setSt((cur) => withAuto(cur, submitted))
    },
    [meta.id, notify, withAuto],
  )

  const statusRequest = useRef(0)
  const fetchStatus = useCallback(
    async (orderNo: string, machineId: string): Promise<OrderStatus | null> => {
      const ticket = ++statusRequest.current
      setLookupBusy(true)
      const { data, error } = await supabase.rpc('production_order_status', {
        p_order_no: orderNo || null,
        p_machine_id: machineId || null,
        p_entry_id: meta.id,
      })
      if (ticket !== statusRequest.current) return null // a newer look-up replaced this one
      setLookupBusy(false)
      if (error) {
        notify('error', friendlyError(error))
        return null
      }
      setStatus(data as OrderStatus)
      statusRef.current = data as OrderStatus
      return data as OrderStatus
    },
    [meta.id, notify],
  )

  useEffect(() => {
    if (!entryId) return
    let alive = true
    Promise.all([
      supabase.from('production_entries').select('*').eq('id', entryId).maybeSingle(),
      supabase.from('production_entry_wastage').select('quantity, reason_id').eq('entry_id', entryId).order('line'),
      supabase
        .from('downtime_events')
        .select('start_at, end_at, reason_id, remarks')
        .eq('entry_id', entryId)
        .order('line'),
    ]).then(async ([entry, wastage, downtime]) => {
      if (!alive) return
      setLoading(false)
      if (entry.error || !entry.data) {
        setLoadError(entry.error ? friendlyError(entry.error) : 'This entry was not found, or you do not have access to it.')
        return
      }
      const row = entry.data as EntryRow
      setSt(
        fromRow(
          row,
          (wastage.data ?? []) as { quantity: number | null; reason_id: string | null }[],
          (downtime.data ?? []) as DowntimeDbRow[],
        ),
      )
      setMeta({ id: row.id, entryNo: row.entry_no, status: row.status, updatedAt: row.updated_at, createdBy: row.created_by })
      await fetchStatus(row.order_no ?? '', row.machine_id)
      if (alive) fetchTimeline(row.machine_id, row.status === 'submitted')
    })
    return () => {
      alive = false
    }
    // Loads once per entry; the look-ups only depend on the entry id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId])

  // Keep the open section's tab in view (the tab row scrolls on phones).
  useEffect(() => {
    document.querySelector('.section-tabs .active')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [tab])

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // ---- Changing values ------------------------------------------------------------
  // A field's red error goes away as soon as the user changes that field (the save
  // checks everything again). Sheet figures are checked together, so changing any
  // of them clears the Total Given Sheets balance error too.
  const clearErrors = useCallback((fields: string[]) => {
    const set = new Set(fields)
    if (['total_sheets', 'ok_sheets', 'separate_sheets', 'wastage'].some((f) => set.has(f))) set.add('total_sheets')
    if (set.has('planned_colours')) set.add('unit_colours')
    setErrors((list) => (list.some((e) => e.field && set.has(e.field)) ? list.filter((e) => !e.field || !set.has(e.field)) : list))
  }, [])

  const update = useCallback(
    (patch: Partial<EntryState>) => {
      setSt((s) => withAuto({ ...s, ...patch }))
      clearErrors(Object.keys(patch))
      touch()
    },
    [withAuto, touch, clearErrors],
  )

  const machineChoices = useMemo(
    () =>
      machines.filter(
        (m) => (m.active && (myMachines === null || myMachines.includes(m.id))) || m.id === st.machine_id,
      ),
    [machines, myMachines, st.machine_id],
  )

  const otherDraftOn = (machineId: string) => machineDrafts.find((d) => d.machine_id === machineId && d.id !== meta.id)

  function chooseMachine(machineId: string) {
    // One entry per machine at a time: a machine with an open draft is blocked.
    const open = machineId ? otherDraftOn(machineId) : undefined
    if (open) {
      setMachineBlock(open)
      return
    }
    const machine = machines.find((m) => m.id === machineId)
    update({
      machine_id: machineId,
      machine_speed: st.machine_speed || (machine ? String(machine.default_speed) : ''),
    })
    fetchStatus(st.order_no, machineId)
    fetchTimeline(machineId, meta.status === 'submitted')
  }

  async function chooseOrder(orderNo: string) {
    update({ order_no: orderNo })
    if (!orderNo) {
      setStatus(null)
      statusRef.current = null
      return
    }
    const s = await fetchStatus(orderNo, st.machine_id)
    if (!s) return
    const job = s.job ?? s.last_entry_job
    if (job) {
      clearErrors(['job_name', 'category', 'ups', 'job_type', 'paper_type_id', 'planned_quantity', 'cso_no', 'coating_id', 'print_side', 'planned_colours'])
    }
    setSt((cur) => {
      let next: EntryState = { ...cur, order_no: orderNo }
      if (job) {
        const planned = s.job?.sides.map((x) => x.print_side) ?? []
        next = {
          ...next,
          job_name: job.job_name ?? '',
          category: job.category ?? '',
          ups: job.ups == null ? '' : String(job.ups),
          job_type: job.job_type ?? '',
          paper_type_id: job.paper_type_id ?? '',
          planned_quantity: job.quantity == null ? '' : String(job.quantity),
          // A planned order's CSO Number and Coating come from Production Plan (locked).
          cso_no: job.cso_no ?? (s.job ? '' : cur.cso_no),
          coating_id: job.coating_id ?? (s.job ? '' : cur.coating_id),
          // A planned order with a single print side: select it straight away.
          print_side: s.job && planned.length === 1 ? planned[0] : s.job && !planned.includes(cur.print_side) ? '' : cur.print_side,
        }
      }
      return withAuto(sideColours(next, s, true))
    })
  }

  function chooseSide(side: string) {
    setSt((cur) => withAuto(sideColours({ ...cur, print_side: side }, statusRef.current, false)))
    clearErrors(['print_side', 'planned_colours'])
    touch()
  }

  // ---- Start times ----------------------------------------------------------------
  function setSpan(key: StepKey, span: Span) {
    setSt((cur) => {
      const old = cur[key]
      const startChanged = span.start.date !== old.start.date || span.start.time !== old.start.time
      const cleared = !span.start.date && !span.start.time && !span.end.date && !span.end.time
      let manual = cur.manual_starts
      if (cleared) manual = manual.filter((k) => k !== key)
      else if (startChanged && !manual.includes(key)) manual = [...manual, key]
      return withAuto({ ...cur, [key]: span, manual_starts: manual })
    })
    clearErrors([key])
    touch()
  }

  function resetStart(key: StepKey) {
    setSt((cur) => withAuto({ ...cur, manual_starts: cur.manual_starts.filter((k) => k !== key) }))
    clearErrors([key])
    touch()
  }

  const readyStamp = timeline?.ready_at && meta.status !== 'submitted' ? isoToStamp(timeline.ready_at) : null
  const autoFor = (key: StepKey, source: string) => ({
    manual: st.manual_starts.includes(key),
    source,
    value: autoStartOf(st, key, readyStamp),
    onReset: () => resetStart(key),
  })

  function chooseShift(shift: string) {
    const patch: Partial<EntryState> = { shift }
    // B shift after midnight still belongs to yesterday's production date.
    const today = plantDate()
    if (meta.status !== 'submitted' && (st.production_date === today || !st.production_date)) {
      patch.production_date = defaultProductionDate(shift)
    }
    update(patch)
  }

  // ---- Derived -----------------------------------------------------------------------
  const fieldErrors = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const e of errors) (map[e.field ?? '_'] ??= []).push(e.message)
    return map
  }, [errors])
  const errorOf = (field: string) => fieldErrors[field]?.join(' ')
  const sectionErrorCount = useMemo(() => {
    const counts = Array(SECTIONS.length).fill(0)
    for (const e of errors) counts[sectionOf(e.field)]++
    return counts
  }, [errors])

  const planned = cleanColours(st.planned_colours).colours
  const plannedRepeats = cleanColours(st.planned_colours).repeated
  const isFirst = status?.is_first ?? true
  const required = changeoverRequired(st.print_side, st.continuing, isFirst)
  const totals = changeoverTotals(st)
  const runTimes = stepTimes(st, 'run')
  const plannedJob = status?.job ?? null
  const coatingLocked = Boolean(plannedJob?.coating_id)
  const csoLocked = Boolean(plannedJob?.cso_no)
  // Worked out from the previous completed job on this machine; a submitted entry shows what was saved.
  const changes = autoChanges(st.unit_colours, st.coating_id, timeline?.previous ?? null)
  const shownColourChanges = meta.status === 'submitted' ? st.colour_changes : String(changes.colourChanges)
  const shownCoatingChanged =
    meta.status === 'submitted' ? st.coating_changed : changes.coatingChanged === null ? '' : changes.coatingChanged ? 'yes' : 'no'
  const plannedSides = plannedJob?.sides.map((x) => x.print_side) ?? []
  const wasteTotal = wastageTotal(st.wastage)
  const total = Number(st.total_sheets) || 0
  const accounted = (Number(st.ok_sheets) || 0) + (Number(st.separate_sheets) || 0) + wasteTotal
  const machine = machines.find((m) => m.id === st.machine_id)
  const sideInfo = status?.sides?.find((s) => s.side === st.print_side)
  const sideClosed = Boolean(st.print_side && status?.closed_sides?.includes(st.print_side))

  // ---- Saving --------------------------------------------------------------------------
  // Latest values for saves that run outside a render (automatic saving).
  const stRef = useRef(st)
  const metaRef = useRef(meta)
  useEffect(() => {
    stRef.current = st
    metaRef.current = meta
  })

  async function callSave(state: EntryState, submit: boolean, close: boolean, quiet = false): Promise<SaveResult | null> {
    const { entry, wastage, downtime } = toPayload(state)
    const args = {
      p_id: metaRef.current.id,
      p_save_id: crypto.randomUUID(),
      p_submit: submit,
      p_entry: entry,
      p_wastage: wastage,
      p_expected_updated_at: metaRef.current.updatedAt,
      p_close_side: close,
      p_downtime: downtime,
    }
    // Retry network failures with the same save id: the server applies it once.
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await supabase.rpc('save_production_entry', args)
      if (!error) return data as SaveResult
      const network = /fetch|network/i.test(error.message ?? '')
      if (!network || attempt >= 3) {
        if (quiet) setAutoNote({ kind: 'error', text: `Draft not saved: ${friendlyError(error, 'entry')}` })
        else notify('error', friendlyError(error, 'entry'))
        return null
      }
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }

  // After a draft is saved: remember its number/version, and give the page the
  // draft's own address (without reloading the form).
  function draftSaved(result: { id: string; entry_no: number; updated_at: string }) {
    const next = { ...metaRef.current, entryNo: result.entry_no, status: 'draft' as const, updatedAt: result.updated_at }
    metaRef.current = next
    setMeta(next)
    const path = `/production/entry/${result.id}`
    if (window.location.pathname !== path) window.history.replaceState(window.history.state, '', path)
  }

  // Saves the work as a draft without asking: when changing section, leaving the
  // page or switching browser tab, and after a pause in typing.
  async function autosave() {
    const m = metaRef.current
    const state = stRef.current
    if (!dirtyRef.current || m.status === 'submitted' || readOnly || !state.machine_id || otherDraftOn(state.machine_id)) return
    if (inFlight.current) return
    setAutoNote({ kind: 'busy', text: 'Saving draft…' })
    const job = callSave(state, false, false, true)
    inFlight.current = job
    const result = await job
    inFlight.current = null
    if (!result) return
    if (result.ok) {
      if (stRef.current === state) markClean()
      draftSaved(result)
      setAutoNote({ kind: 'ok', text: `Draft ${entryLabel(result.entry_no)} saved automatically at ${time12(nowStamp().time)}` })
    } else if (result.code === 'DRAFT_EXISTS') {
      setAutoNote(null)
      setConflict(result.draft)
    } else if (result.code === 'STALE') {
      setAutoNote(null)
      setStale(result.message)
    } else {
      setAutoNote({ kind: 'error', text: `Draft not saved yet: ${result.errors.map((e) => e.message).join(' ')}` })
    }
  }
  const autosaveRef = useRef(autosave)
  useEffect(() => {
    autosaveRef.current = autosave
  })

  // After a pause in typing, and when the browser tab is hidden or the page is left.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => autosaveRef.current(), 15000)
    return () => clearTimeout(t)
  }, [st, dirty])
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && autosaveRef.current()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      autosaveRef.current() // leaving the page inside the app
    }
  }, [])

  function goTab(i: number) {
    setTab(i)
    autosave()
  }

  async function save(submit: boolean, close = false) {
    if (lookupBusy || saving) return
    setSaving(true)
    setStale('')
    if (inFlight.current) await inFlight.current
    const state = stRef.current
    const result = await callSave(state, submit, close)
    setSaving(false)
    setConfirming(false)
    if (!result) return
    if (result.ok) {
      setErrors([])
      if (stRef.current === state || result.status === 'submitted') markClean()
      if (result.status === 'submitted') {
        notify('success', `Entry ${entryLabel(result.entry_no)} saved.`)
        navigate('/production/entry')
      } else {
        notify('success', `Draft ${entryLabel(result.entry_no)} saved.`)
        draftSaved(result)
        setAutoNote(null)
      }
      return
    }
    if (result.code === 'INVALID') {
      setErrors(result.errors)
      const first = Math.min(...result.errors.map((e) => sectionOf(e.field)))
      setTab(first)
      notify('error', `Please fix ${result.errors.length === 1 ? '1 item' : `${result.errors.length} items`} before saving.`)
    } else if (result.code === 'DRAFT_EXISTS') {
      setConflict(result.draft)
    } else if (result.code === 'STALE') {
      setStale(result.message)
    }
  }

  // ---- Rendering --------------------------------------------------------------------
  if (loading) return <p className="page-status">Loading…</p>
  if (loadError) {
    return (
      <section className="card">
        <h1>Production Entry</h1>
        <p className="notice error">{loadError}</p>
        <Link to="/production/entry" className="button">
          Back to entries
        </Link>
      </section>
    )
  }

  const title =
    meta.status === 'new' ? 'New Production Entry' : `Production Entry ${entryLabel(meta.entryNo)}`

  const sideNotice = (() => {
    if (!st.order_no || !st.print_side || !status) return null
    if (status.fully_closed && !(meta.status === 'submitted')) {
      return <p className="notice error">Production order {st.order_no} is fully closed. No more entries can be added.</p>
    }
    const pairOf: Record<string, string> = { 'F/S': 'B/S', 'B/S': 'F/S', 'B/B F': 'B/B B', 'B/B B': 'B/B F' }
    const lines: string[] = []
    if (sideClosed) lines.push(`${st.print_side} of this order is already closed.`)
    else if (sideInfo) lines.push(`${st.print_side} already has ${sideInfo.entries} submitted ${sideInfo.entries === 1 ? 'entry' : 'entries'}. Set Continuing Job to Yes if this continues it.`)
    const pair = pairOf[st.print_side]
    if (pair) {
      const p = status.sides?.find((s) => s.side === pair)
      lines.push(`${sideFamily(st.print_side)} are the two sides of one order.${p ? ` ${pair}: ${p.closed ? 'closed' : 'printed, still open'}.` : ''}`)
    }
    const other = status.sides?.find((s) => sideFamily(s.side) !== sideFamily(st.print_side))
    if (other) lines.push(`This order is already printed as ${other.side}; ${st.print_side} cannot be mixed with it.`)
    return lines.length ? <p className={`notice ${sideClosed || other ? 'warn' : 'info'}`}>{lines.join(' ')}</p> : null
  })()

  const sections: ReactNode[] = [
    // 1. Job Details
    <div key="job" className="form-grid">
      <Field label="Production Date *" error={errorOf('production_date')}>
        <input type="date" value={st.production_date} disabled={readOnly} onChange={(e) => update({ production_date: e.target.value })} />
      </Field>
      <Field label="Machine *" error={errorOf('machine_id')}>
        <select value={st.machine_id} disabled={readOnly} onChange={(e) => chooseMachine(e.target.value)}>
          <option value="">Select…</option>
          {machineChoices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.code}
              {m.name !== m.code ? ` · ${m.name}` : ''}
              {otherDraftOn(m.id) ? ' (draft open)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Shift *" error={errorOf('shift')}>
        <select value={st.shift} disabled={readOnly} onChange={(e) => chooseShift(e.target.value)}>
          <option value="">Select…</option>
          <option value="A">A (8:00 AM – 4:30 PM)</option>
          <option value="B">B (from 4:30 PM)</option>
        </select>
      </Field>
      <Field label="Production Order Number *" error={errorOf('order_no')} wide>
        <div className="with-scan">
          <OrderPicker value={st.order_no} options={orders} disabled={readOnly} invalid={Boolean(errorOf('order_no'))} onSelect={chooseOrder} />
          <ScanButton disabled={readOnly} onScan={(text) => chooseOrder(text.slice(0, 60))} />
        </div>
      </Field>
      <Field label="CSO Number *" error={errorOf('cso_no')}>
        <input
          value={st.cso_no}
          maxLength={60}
          disabled={readOnly || csoLocked}
          onChange={(e) => update({ cso_no: e.target.value })}
        />
        {csoLocked && <span className="hint">From Production Plan</span>}
      </Field>
      <Field label="Job Name *" error={errorOf('job_name')} wide>
        <input value={st.job_name} maxLength={150} disabled={readOnly} onChange={(e) => update({ job_name: e.target.value })} />
      </Field>
      <Field label="Category *" error={errorOf('category')}>
        <input value={st.category} maxLength={80} disabled={readOnly} onChange={(e) => update({ category: e.target.value })} list="categories" />
        <datalist id="categories">
          <option value="Commercial" />
          <option value="Carton" />
          <option value="Box" />
        </datalist>
      </Field>
      <Field label="Print Side *" error={errorOf('print_side')}>
        <select value={st.print_side} disabled={readOnly} onChange={(e) => chooseSide(e.target.value)}>
          <option value="">Select…</option>
          {PRINT_SIDES.map((s) =>
            plannedJob && !plannedSides.includes(s) ? (
              s === st.print_side ? (
                <option key={s} value={s}>
                  {s} (not planned)
                </option>
              ) : null
            ) : (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
        {plannedJob && <span className="hint">Planned sides: {plannedSides.join(', ') || 'none'}</span>}
      </Field>
      <Field label="Continuing Job? *" error={errorOf('continuing')}>
        <select value={st.continuing ? 'yes' : 'no'} disabled={readOnly} onChange={(e) => update({ continuing: e.target.value === 'yes' })}>
          <option value="no">No</option>
          <option value="yes">Yes, continues an earlier entry</option>
        </select>
      </Field>
      <Field label="UPS *" error={errorOf('ups')}>
        <input inputMode="numeric" value={st.ups} disabled={readOnly} onChange={(e) => update({ ups: digits(e.target.value) })} maxLength={4} />
      </Field>
      <Field label="Job Type *" error={errorOf('job_type')}>
        <select value={st.job_type} disabled={readOnly} onChange={(e) => update({ job_type: e.target.value })}>
          <option value="">Select…</option>
          {JOB_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Type of Paper *" error={errorOf('paper_type_id')}>
        <select value={st.paper_type_id} disabled={readOnly} onChange={(e) => update({ paper_type_id: e.target.value })}>
          <option value="">Select…</option>
          {choices(papers, st.paper_type_id).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Planned Quantity (Sheets)" error={errorOf('planned_quantity')}>
        <input inputMode="numeric" value={st.planned_quantity} disabled={readOnly} onChange={(e) => update({ planned_quantity: digits(e.target.value) })} maxLength={9} />
      </Field>

      <div className="span-all">
        {lookupBusy && <p className="notice info">Looking up the order…</p>}
        {!lookupBusy && st.order_no && status && (
          <p className="notice info">
            {status.job
              ? `Planned production order: details filled in from Production Plan (${formatNumber(status.job.quantity)} sheets planned).`
              : status.last_entry_job
                ? 'Not in Production Plan: details filled in from the last entry for this production order.'
                : 'New production order, not in Production Plan: enter the job details, CSO Number, coating and colours yourself.'}
            {status.sides && status.sides.length > 0 &&
              ` Produced so far: ${status.sides.map((s) => `${s.side} ${formatNumber(s.ok_sheets ?? 0)} OK${s.closed ? ' (closed)' : ''}`).join(' · ')}.`}
            {' '}Changes here do not change the Production Plan.
          </p>
        )}
        {sideNotice}
        {st.order_no && status?.previous_on_machine && !st.continuing && (
          <p className="notice info">
            This machine's last entry for this order was {entryLabel(status.previous_on_machine.entry_no)} (
            {status.previous_on_machine.print_side}, {formatDate(status.previous_on_machine.production_date)}, Shift{' '}
            {status.previous_on_machine.shift}). If you are continuing that job, set Continuing Job to Yes.
          </p>
        )}
        <p className="notice muted-notice">
          Shift A runs 8:00 AM – 4:30 PM; Shift B starts at 4:30 PM. B shift work after midnight keeps the previous day's
          Production Date. A job running from Shift A into Shift B is saved as a separate Shift B entry with Continuing Job =
          Yes.
        </p>
      </div>
    </div>,

    // 2. Worker Details
    <div key="workers" className="form-grid">
      <Field label="Operator Name *" error={errorOf('operator_id')}>
        <MasterSelect rows={operators} value={st.operator_id} disabled={readOnly} onChange={(v) => update({ operator_id: v })} />
      </Field>
      <Field label="Supervisor Name *" error={errorOf('supervisor_id')}>
        <MasterSelect rows={supervisors} value={st.supervisor_id} disabled={readOnly} onChange={(v) => update({ supervisor_id: v })} />
      </Field>
      <Field label="QC Executive *" error={errorOf('qc_executive_id')}>
        <MasterSelect rows={qcs} value={st.qc_executive_id} disabled={readOnly} onChange={(v) => update({ qc_executive_id: v })} />
      </Field>
      <Field label="No. of Helpers *" error={errorOf('helpers')}>
        <select value={st.helpers} disabled={readOnly} onChange={(e) => update({ helpers: e.target.value })}>
          <option value="">Select…</option>
          {HELPERS.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </Field>
    </div>,

    // 3. Unit-wise Colour Allocation
    <div key="colours" className="form-stack">
      {!st.print_side ? (
        <p className="notice info">Select the Print Side in Job Details first. The colours follow the order and its print side.</p>
      ) : plannedJob ? (
        <div className="colour-set">
          <p className="smallcaps">
            Planned colours for {st.print_side} · production order {st.order_no} (from Production Plan)
          </p>
          {planned.length ? (
            <div className="chips">
              {planned.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          ) : (
            <p className="notice warn">
              No colours are planned for {st.print_side} of this order. Choose a planned print side, or add {st.print_side} to
              the order in Production Plan.
            </p>
          )}
        </div>
      ) : (
        <fieldset className="colour-set">
          <legend>Colours for {st.print_side} (order not in Production Plan: enter them here)</legend>
          <div className="colour-grid">
            {st.planned_colours.map((c, i) => (
              <label key={i} className="field">
                <span>Colour {i + 1}</span>
                <input
                  value={c}
                  maxLength={40}
                  disabled={readOnly}
                  onChange={(e) => update({ planned_colours: st.planned_colours.map((x, j) => (j === i ? e.target.value : x)) })}
                />
              </label>
            ))}
          </div>
          {!readOnly && (
            <button type="button" className="small" onClick={() => update({ planned_colours: [...st.planned_colours, ''] })}>
              <Plus size={15} /> Add Colour
            </button>
          )}
          {plannedRepeats.length > 0 && <p className="notice warn">Entered more than once: {plannedRepeats.join(', ')}. Each colour is kept once.</p>}
          {errorOf('planned_colours') && <p className="field-error">{errorOf('planned_colours')}</p>}
        </fieldset>
      )}

      {planned.length > UNIT_COUNT && (
        <p className="notice warn">This job has {planned.length} colours, but only seven printing units are available.</p>
      )}
      {planned.length === 0 && <p className="notice info">Enter the job colours above to allocate them to units.</p>}
      <div className="unit-grid">
        {st.unit_colours.map((value, i) => {
          const usedElsewhere = new Set(st.unit_colours.filter((c, j) => j !== i && c).map((c) => c.toLowerCase()))
          const options = planned.filter((c) => !usedElsewhere.has(c.toLowerCase()))
          const unknown = value && !planned.some((c) => c.toLowerCase() === value.toLowerCase())
          return (
            <label key={i} className="field">
              <span>Unit {i + 1}</span>
              <select
                value={value}
                disabled={readOnly}
                onChange={(e) => update({ unit_colours: st.unit_colours.map((x, j) => (j === i ? e.target.value : x)) })}
              >
                <option value="">— Not used —</option>
                {unknown && <option value={value}>{value} (not in job colours)</option>}
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
      {errorOf('unit_colours') && <p className="field-error">{errorOf('unit_colours')}</p>}
      <div className="form-grid">
        <Field label="Coating *" error={errorOf('coating_id')}>
          <MasterSelect rows={coatings} value={st.coating_id} disabled={readOnly || coatingLocked} onChange={(v) => update({ coating_id: v })} />
          {coatingLocked && <span className="hint">From Production Plan</span>}
        </Field>
        <Field label="No. of Colour Changes (automatic)" error={errorOf('colour_changes')}>
          <input value={shownColourChanges} readOnly disabled aria-readonly="true" />
        </Field>
        <Field label="Coating Changed? (automatic)" error={errorOf('coating_changed')}>
          <input value={shownCoatingChanged === 'yes' ? 'Yes' : shownCoatingChanged === 'no' ? 'No' : '—'} readOnly disabled aria-readonly="true" />
        </Field>
      </div>
      {meta.status !== 'submitted' && (
        <p className="muted small">
          {!st.machine_id
            ? 'Select the machine to work out the colour and coating changes.'
            : timeline?.previous
              ? `Compared unit by unit with the previous job on this machine (${entryLabel(timeline.previous.entry_no)}, production order ${timeline.previous.order_no ?? '—'}${timeline.previous.coating ? `, coating ${timeline.previous.coating}` : ''}). An empty unit getting a colour, or a colour removed, also counts.`
              : 'No earlier job on this machine: every used unit counts as a colour change, and the coating counts as changed.'}
        </p>
      )}
    </div>,

    // 4. Changeover Time
    <div key="changeover" className="form-stack">
      <p className={`notice ${required ? 'warn' : 'info'}`}>
        {required
          ? 'Changeover is required for this entry: fill in Job Changeover, Registration and Colour Matching.'
          : st.print_side.startsWith('B/B')
            ? 'Changeover is optional: this is not the first B/B entry of this order. Any activity you start needs both Start and End.'
            : 'Changeover is optional for a continuing job. Any activity you start needs both Start and End.'}
      </p>
      <TimelinePanel timeline={timeline} machineCode={machine?.code} submitted={meta.status === 'submitted'} />
      <div className="time-cards">
        {ACTIVITIES.map((a, i) => {
          const t = stepTimes(st, a.key)
          return (
            <TimeCard
              key={a.key}
              title={a.label}
              span={st[a.key]}
              required={required}
              disabled={readOnly}
              error={errorOf(a.key)}
              downtime={t.downtime}
              auto={autoFor(a.key, i === 0 ? 'machine ready time' : `${ACTIVITIES[i - 1].label} end`)}
              onChange={(s) => setSpan(a.key, s)}
            />
          )
        })}
      </div>
      <div className="totals">
        <div>
          <span>Total Gross Changeover</span>
          <b>{formatDuration(totals.gross)}</b>
        </div>
        <div>
          <span>Downtime inside changeover</span>
          <b>{totals.gross === null ? '—' : formatDuration((totals.gross ?? 0) - (totals.net ?? 0))}</b>
        </div>
        <div>
          <span>Total Net Changeover</span>
          <b>{formatDuration(totals.net)}</b>
        </div>
      </div>
      <p className="muted small">
        Steps run one after another: Job Changeover → Registration → Colour Matching → Production. Each start fills in
        automatically from the previous end; you can change it, and reset it to the automatic time. Net time = gross time −
        downtime inside that step (overlapping downtime is counted once).
      </p>
    </div>,

    // 5. Run Time
    <div key="run" className="form-stack">
      <TimeCard
        title="Production Time"
        span={st.run}
        required
        disabled={readOnly}
        error={errorOf('run')}
        downtime={runTimes.downtime}
        auto={autoFor('run', required || spanComplete(st.colour_matching) ? 'Colour Matching end' : 'previous step end')}
        onChange={(s) => setSpan('run', s)}
      />
      <p className="muted small">Production starts when Colour Matching ends (or when the machine was ready, if there is no changeover).</p>
    </div>,

    // 6. Downtime
    <div key="downtime" className="form-stack">
      <p className="notice info">
        Record each downtime during this job: during or between the changeover steps, or during production. Click a reason,
        then enter the start and end time. Downtime between two jobs is recorded under Production → Downtime instead.
      </p>
      {st.downtime.length === 0 && <p className="empty">No downtime recorded for this job.</p>}
      {st.downtime.map((d, i) => {
        const minutes = spanComplete(d.span) ? (stampMs(d.span.end)! - stampMs(d.span.start)!) / 60000 : null
        const where = downtimePlacement(st, d)
        const group = downtimeGroupLabel(reasonGroup(downtimeReasons, d.reason_id))
        const setRow = (patch: Partial<typeof d>) => update({ downtime: st.downtime.map((x, j) => (j === i ? { ...x, ...patch } : x)) })
        return (
          <div key={i} className="downtime-row">
            <div className="downtime-head">
              <b>
                Downtime {i + 1}
                {group ? ` · ${group}` : ''}
              </b>
              {!readOnly && (
                <button
                  type="button"
                  className="icon-button danger-text"
                  aria-label={`Remove downtime ${i + 1}`}
                  title="Remove"
                  onClick={() => update({ downtime: st.downtime.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={17} />
                </button>
              )}
            </div>
            <div className="field">
              <span>Reason * (click one)</span>
              <ReasonPicker
                groups={DOWNTIME_COLUMNS}
                reasons={downtimeReasons}
                selected={[d.reason_id]}
                disabled={readOnly}
                label={`Reason for downtime ${i + 1}`}
                onToggle={(id) => setRow({ reason_id: id })}
              />
            </div>
            <TimeCard
              title={group ? `Downtime – ${group}` : 'Downtime'}
              span={d.span}
              disabled={readOnly}
              onChange={(span) => setRow({ span })}
            >
              {where && <p className="muted small">Inside: {where}</p>}
              {minutes !== null && minutes > 0 && !where && (
                <p className="warn-text small">This is outside the job's steps. Check the times.</p>
              )}
            </TimeCard>
            <label className="field">
              <span>Remarks</span>
              <input value={d.remarks} maxLength={500} disabled={readOnly} onChange={(e) => setRow({ remarks: e.target.value })} />
            </label>
          </div>
        )
      })}
      {!readOnly && (
        <div className="actions">
          <button type="button" className="small" onClick={() => update({ downtime: [...st.downtime, emptyDowntime()] })}>
            <Plus size={15} /> Add downtime
          </button>
        </div>
      )}
      {downtimeOverlaps(st.downtime) && (
        <p className="notice warn">Two downtime rows overlap. A machine can have only one downtime at a time: change the times.</p>
      )}
      {errorOf('downtime') && <p className="field-error">{errorOf('downtime')}</p>}
      <div className="totals">
        <div>
          <span>Changeover gross / net</span>
          <b>
            {formatDuration(totals.gross)} / {formatDuration(totals.net)}
          </b>
        </div>
        <div>
          <span>Production gross / net</span>
          <b>
            {formatDuration(runTimes.gross)} / {formatDuration(runTimes.net)}
          </b>
        </div>
      </div>
    </div>,

    // 7. Production Details
    <div key="production" className="form-stack">
      <div className="form-grid">
        <Field label="Machine Speed (Sheets/Hour) *" error={errorOf('machine_speed')}>
          <input inputMode="numeric" value={st.machine_speed} disabled={readOnly} onChange={(e) => update({ machine_speed: digits(e.target.value) })} maxLength={6} />
          {machine && !readOnly && st.machine_speed !== String(machine.default_speed) && (
            <span className="hint">Default for {machine.code}: {formatNumber(machine.default_speed)}</span>
          )}
        </Field>
        <Field label="Total Given Sheets *" error={errorOf('total_sheets')}>
          <input inputMode="numeric" value={st.total_sheets} disabled={readOnly} onChange={(e) => update({ total_sheets: digits(e.target.value) })} maxLength={8} />
        </Field>
        <Field label="OK Sheets *" error={errorOf('ok_sheets')}>
          <input inputMode="numeric" value={st.ok_sheets} disabled={readOnly} onChange={(e) => update({ ok_sheets: digits(e.target.value) })} maxLength={8} />
        </Field>
        <Field label="Separate Sheets" error={errorOf('separate_sheets')}>
          <input inputMode="numeric" value={st.separate_sheets} disabled={readOnly} onChange={(e) => update({ separate_sheets: digits(e.target.value) })} maxLength={8} />
        </Field>
      </div>

      <fieldset className={`colour-set${errorOf('wastage') ? ' invalid' : ''}`}>
        <legend>Wastage</legend>
        <p className="muted small">
          Click every reason that caused wastage (click again to remove it), then enter the wastage sheets for each one below.
        </p>
        <ReasonPicker
          groups={WASTAGE_COLUMNS}
          reasons={wastageReasons}
          selected={st.wastage.map((w) => w.reason_id).filter(Boolean)}
          multiple
          disabled={readOnly}
          label="Wastage reasons"
          onToggle={(id) =>
            update({
              wastage: st.wastage.some((w) => w.reason_id === id)
                ? st.wastage.filter((w) => w.reason_id !== id)
                : [...st.wastage, { quantity: '', reason_id: id }],
            })
          }
        />
        {st.wastage.length === 0 ? (
          <p className="empty">No wastage reason selected.</p>
        ) : (
          <div className="wastage-boxes">
            {st.wastage.map((w, i) => {
              const name = wastageReasons.find((r) => r.id === w.reason_id)?.name ?? (w.reason_id ? 'Reason' : 'Reason not chosen')
              return (
                <div key={w.reason_id || `blank-${i}`} className="wastage-box">
                  <label className="field">
                    <span>
                      {i + 1}. {name} *
                    </span>
                    <input
                      inputMode="numeric"
                      value={w.quantity}
                      disabled={readOnly}
                      maxLength={8}
                      placeholder="Wastage sheets"
                      onChange={(e) => update({ wastage: st.wastage.map((x, j) => (j === i ? { ...x, quantity: digits(e.target.value) } : x)) })}
                    />
                  </label>
                  {!readOnly && (
                    <button
                      type="button"
                      className="icon-button danger-text"
                      aria-label={`Remove ${name}`}
                      title="Remove"
                      onClick={() => update({ wastage: st.wastage.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {st.wastage.length > 0 && (
          <p className="muted small">
            Total wastage: <b>{formatNumber(wasteTotal)}</b> sheets
          </p>
        )}
        {errorOf('wastage') && <p className="field-error">{errorOf('wastage')}</p>}
      </fieldset>

      <div className={`reconcile ${total && total === accounted ? 'ok' : total ? 'bad' : ''}`}>
        {total && total === accounted ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        <span>
          Total Given <b>{formatNumber(total)}</b> · OK + Separate + Wastage <b>{formatNumber(accounted)}</b>
          {total ? (total === accounted ? ' · Balanced' : ` · Difference ${formatNumber(total - accounted)}`) : ''}
        </span>
      </div>
      <p className="muted small">Total Given Sheets must equal OK + Separate + all wastage exactly.</p>

      <Field label="Remarks" error={errorOf('remarks')}>
        <textarea rows={3} maxLength={1000} value={st.remarks} disabled={readOnly} onChange={(e) => update({ remarks: e.target.value })} />
      </Field>
    </div>,
  ]

  const otherErrors = fieldErrors['_']

  return (
    <>
      <div className="pagehead">
        <div>
          <Link to="/production/entry" className="back-link">
            <ArrowLeft size={16} /> Production entries
          </Link>
          <h1>
            {title}{' '}
            {meta.status === 'submitted' && <span className="badge green">Submitted</span>}
            {meta.status === 'draft' && <span className="badge amber">Draft</span>}
          </h1>
          <p className="muted">
            {readOnly ? 'View only' : 'Fill in the sections. Save Draft keeps your work; Save Entry submits it.'}
          </p>
        </div>
      </div>

      {stale && (
        <p className="notice error">
          {stale}{' '}
          <button type="button" className="small" onClick={() => globalThis.location.reload()}>
            Reload entry
          </button>
        </p>
      )}
      {otherErrors && <p className="notice error">{otherErrors.join(' ')}</p>}

      <div className="section-tabs" role="tablist">
        {SECTIONS.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={tab === i}
            className={tab === i ? 'active' : ''}
            onClick={() => goTab(i)}
          >
            <span className="tab-no">{i + 1}</span> {label}
            {sectionErrorCount[i] > 0 && <span className="tab-errors">{sectionErrorCount[i]}</span>}
          </button>
        ))}
      </div>

      <section className="card entry-card">
        <h2>
          {tab + 1}. {SECTIONS[tab]}
        </h2>
        {sections[tab]}
      </section>

      <div className="entry-footer">
        <div className="actions">
          <button type="button" disabled={tab === 0} onClick={() => goTab(tab - 1)} aria-label="Previous section">
            <ArrowLeft size={16} /> <span className="hide-sm">Previous</span>
          </button>
          <button type="button" disabled={tab === SECTIONS.length - 1} onClick={() => goTab(tab + 1)} aria-label="Next section">
            <span className="hide-sm">Next</span> <ArrowRight size={16} />
          </button>
        </div>
        {autoNote && (
          <span className={`auto-save ${autoNote.kind}`} role="status">
            {autoNote.text}
          </span>
        )}
        {!readOnly && (
          <div className="actions">
            {meta.status !== 'submitted' && (
              <button type="button" onClick={() => save(false)} disabled={saving || lookupBusy}>
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={saving || lookupBusy}
              onClick={() => {
                setCloseSide(false)
                setConfirming(true)
              }}
            >
              {meta.status === 'submitted' ? 'Save Changes' : 'Save Entry'}
            </button>
          </div>
        )}
      </div>

      {confirming && (
        <Modal
          title={meta.status === 'submitted' ? 'Save changes to this entry?' : 'Submit this production entry?'}
          onClose={() => setConfirming(false)}
          width={480}
          footer={
            <>
              <button type="button" onClick={() => setConfirming(false)} disabled={saving}>
                Go back
              </button>
              <button type="button" className="primary" onClick={() => save(true, closeSide)} disabled={saving}>
                {saving ? 'Saving…' : meta.status === 'submitted' ? 'Save Changes' : 'Submit Entry'}
              </button>
            </>
          }
        >
          <dl className="summary-list">
            <dt>Production Order</dt>
            <dd>
              {st.order_no || '—'} · {st.job_name || '—'}
            </dd>
            <dt>CSO Number</dt>
            <dd>{st.cso_no || '—'}</dd>
            <dt>Machine / Shift</dt>
            <dd>
              {machine?.code ?? '—'} · Shift {st.shift || '—'} · {formatDate(st.production_date)}
            </dd>
            <dt>Print Side</dt>
            <dd>
              {st.print_side || '—'}
              {st.continuing ? ' (continuing)' : ''}
            </dd>
            <dt>Sheets</dt>
            <dd>
              Given {formatNumber(total)} · OK {formatNumber(Number(st.ok_sheets) || 0)} · Wastage {formatNumber(wasteTotal)}
            </dd>
            <dt>Production Time</dt>
            <dd>{spanComplete(st.run) ? formatDuration(Math.max(0, minutesOf(st.run))) : '—'}</dd>
          </dl>
          {st.order_no && st.print_side && !sideClosed && (
            <label className="check">
              <input type="checkbox" checked={closeSide} onChange={(e) => setCloseSide(e.target.checked)} />
              <span>
                {st.print_side} of production order {st.order_no} is finished. Close it (no more entries for this side).
              </span>
            </label>
          )}
          <p className="muted small">Leave it open if the job continues in the next shift. You can close a side later from the entry list.</p>
        </Modal>
      )}

      {machineBlock && (
        <Modal
          title="This machine already has an open entry"
          onClose={() => setMachineBlock(null)}
          width={480}
          footer={
            <>
              <button type="button" onClick={() => setMachineBlock(null)}>
                Choose another machine
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const id = machineBlock.id
                  setMachineBlock(null)
                  markClean()
                  navigate(`/production/entry/${id}`)
                }}
              >
                Open that draft
              </button>
            </>
          }
        >
          <p>
            <b>{machines.find((m) => m.id === machineBlock.machine_id)?.code}</b> has draft <b>{entryLabel(machineBlock.entry_no)}</b>
            {machineBlock.order_no ? ` · production order ${machineBlock.order_no}` : ''}
            {machineBlock.job_name ? ` · ${machineBlock.job_name}` : ''}
          </p>
          <p className="muted">
            {formatDate(machineBlock.production_date)}
            {machineBlock.shift ? ` · Shift ${machineBlock.shift}` : ''} · last saved {formatMoment(machineBlock.updated_at)}
          </p>
          <p className="notice warn">
            Only one entry per machine at a time. Finish (submit) or delete that draft before starting a new entry on this
            machine.
          </p>
        </Modal>
      )}

      {conflict && (
        <Modal
          title="This machine already has a draft"
          onClose={() => setConflict(null)}
          width={480}
          footer={
            <>
              <button type="button" onClick={() => setConflict(null)}>
                Stay here
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setConflict(null)
                  markClean()
                  navigate(`/production/entry/${conflict.id}`)
                }}
              >
                Open that draft
              </button>
            </>
          }
        >
          <p>
            <b>{entryLabel(conflict.entry_no)}</b> · {conflict.order_no || 'production order not entered yet'}
            {conflict.job_name ? ` · ${conflict.job_name}` : ''}
          </p>
          <p className="muted">
            {formatDate(conflict.production_date)}
            {conflict.shift ? ` · Shift ${conflict.shift}` : ''} · last saved {formatMoment(conflict.updated_at)}
          </p>
          <p className="muted small">
            One draft per machine: finish (submit) or delete that draft first. Your changes here are not saved yet.
          </p>
        </Modal>
      )}
    </>
  )
}

const digits = (v: string) => v.replace(/[^0-9]/g, '')

// The colours the units can use: the plan's slot for the chosen print side (planned
// orders), or the colours typed for an unplanned order. Unit choices that are no
// longer valid are cleared.
function sideColours(st: EntryState, status: OrderStatus | null, orderChanged: boolean): EntryState {
  let colours: string[] | null = null
  if (status?.job) colours = status.job.sides.find((x) => x.print_side === st.print_side)?.colours ?? []
  else if (orderChanged) colours = status?.last_entry_job?.sides.find((x) => x.print_side === st.print_side)?.colours ?? []
  const list = colours ?? cleanColours(st.planned_colours).colours
  const keys = new Set(list.map((c) => c.toLowerCase()))
  // Units are chosen by the operator; only choices that no longer fit are cleared.
  const units = st.unit_colours.map((u) => (u && keys.has(u.toLowerCase()) ? u : ''))
  return {
    ...st,
    planned_colours: colours ? Array.from({ length: Math.max(7, colours.length) }, (_, i) => colours[i] ?? '') : st.planned_colours,
    unit_colours: units,
  }
}
const minutesOf = (s: Span) => {
  const a = Date.parse(`${s.start.date}T${s.start.time}:00+05:30`)
  const b = Date.parse(`${s.end.date}T${s.end.time}:00+05:30`)
  return Math.round((b - a) / 60000)
}

function Field({ label, error, wide, children }: { label: string; error?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`field ${wide ? 'span-2' : ''} ${error ? 'invalid' : ''}`}>
      <span>{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  )
}

function MasterSelect({ rows, value, disabled, onChange }: { rows: Option[]; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const list = choices(rows, value)
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{list.length ? 'Select…' : 'None yet: add them under Master'}</option>
      {list.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.active ? '' : ' (inactive)'}
        </option>
      ))}
    </select>
  )
}

function TimelinePanel({ timeline, machineCode, submitted }: { timeline: Timeline | null; machineCode?: string; submitted: boolean }) {
  if (!machineCode) return <p className="notice info">Select the machine in Job Details to load its timeline.</p>
  if (!timeline) return <p className="notice info">Loading the machine timeline…</p>
  const prev = timeline.previous
  return (
    <div className="timeline-panel">
      <p className="smallcaps">Machine timeline · {machineCode}</p>
      {prev ? (
        <p>
          Previous completed job: <b>{entryLabel(prev.entry_no)}</b> · production order {prev.order_no} {prev.print_side ? `(${prev.print_side})` : ''} ·
          production ended <b>{formatMoment(prev.run_end)}</b>
        </p>
      ) : (
        <p>
          No earlier completed job on this machine. This entry starts its timeline: enter the Job Changeover start yourself.
        </p>
      )}
      {timeline.downtime.map((d) => (
        <p key={d.id}>
          Downtime{d.kind ? ` (${downtimeGroupLabel(d.kind)})` : ''} between jobs: {formatMoment(d.start_at)} – {formatMoment(d.end_at)} ({formatDuration(d.minutes)}
          {d.reason ? `, ${d.reason}` : ''})
        </p>
      ))}
      {timeline.ready_at && (
        <p>
          Machine ready from <b>{formatMoment(timeline.ready_at)}</b>
          {submitted ? '' : ' → used as the Job Changeover start'}
        </p>
      )}
      {timeline.open_downtime.map((d) => (
        <p key={d.id} className="warn-text">
          Open downtime{d.kind ? ` (${downtimeGroupLabel(d.kind)})` : ''} since {formatMoment(d.start_at)}: the machine is still recorded as down.
          Close it under Production → Downtime.
        </p>
      ))}
    </div>
  )
}
