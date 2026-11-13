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
  changeoverRequired,
  changeoverWindow,
  compareStamps,
  defaultProductionDate,
  entryLabel,
  formatDuration,
  formatMoment,
  fromRow,
  isoToStamp,
  newEntryState,
  sectionOf,
  sideFamily,
  spanComplete,
  stampFilled,
  time12,
  toPayload,
  wastageTotal,
} from '../lib/production'
import type { EntryRow, EntryState, FieldError, OrderOption, OrderStatus, Span } from '../lib/production'
import type { Machine } from '../lib/types'
import { plantDate } from '../lib/dates'
import { OrderPicker } from '../components/OrderPicker'
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

  const [machines, setMachines] = useState<Machine[]>([])
  const [myMachines, setMyMachines] = useState<string[] | null>(null)
  const [orders, setOrders] = useState<OrderOption[]>([])
  const operators = useOptions('operators')
  const supervisors = useOptions('supervisors')
  const qcs = useOptions('qc_executives')
  const coatings = useOptions('coatings')
  const papers = useOptions('paper_types')
  const reasons = useOptions('wastage_reasons')

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
    if (!profile) return
    if (profile.role === 'super_admin' || profile.all_machines) return
    supabase
      .from('profile_machines')
      .select('machine_id')
      .eq('profile_id', profile.id)
      .then(({ data }) => setMyMachines((data ?? []).map((r: { machine_id: string }) => r.machine_id)))
  }, [profile])

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
    ]).then(([entry, wastage]) => {
      if (!alive) return
      setLoading(false)
      if (entry.error || !entry.data) {
        setLoadError(entry.error ? friendlyError(entry.error) : 'This entry was not found, or you do not have access to it.')
        return
      }
      const row = entry.data as EntryRow
      setSt(fromRow(row, (wastage.data ?? []) as { quantity: number | null; reason_id: string | null }[]))
      setMeta({ id: row.id, entryNo: row.entry_no, status: row.status, updatedAt: row.updated_at, createdBy: row.created_by })
      fetchStatus(row.order_no ?? '', row.machine_id)
    })
    return () => {
      alive = false
    }
  }, [entryId, fetchStatus])

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
  const update = useCallback((patch: Partial<EntryState>) => {
    setSt((s) => ({ ...s, ...patch }))
    setDirty(true)
  }, [])

  const machineChoices = useMemo(
    () =>
      machines.filter(
        (m) => (m.active && (myMachines === null || myMachines.includes(m.id))) || m.id === st.machine_id,
      ),
    [machines, myMachines, st.machine_id],
  )

  function chooseMachine(machineId: string) {
    const machine = machines.find((m) => m.id === machineId)
    update({
      machine_id: machineId,
      machine_speed: st.machine_speed || (machine ? String(machine.default_speed) : ''),
    })
    fetchStatus(st.order_no, machineId)
  }

  async function chooseOrder(orderNo: string) {
    update({ order_no: orderNo })
    if (!orderNo) {
      setStatus(null)
      return
    }
    const s = await fetchStatus(orderNo, st.machine_id)
    const job = s?.job ?? s?.last_entry_job
    if (!job) return
    const colours = job.colours ?? []
    setSt((cur) => ({
      ...cur,
      order_no: orderNo,
      job_name: job.job_name ?? '',
      category: job.category ?? '',
      ups: job.ups == null ? '' : String(job.ups),
      job_type: job.job_type ?? '',
      paper_type_id: job.paper_type_id ?? '',
      planned_quantity: job.quantity == null ? '' : String(job.quantity),
      planned_colours: Array.from({ length: 9 }, (_, i) => colours[i] ?? ''),
      // Fill Units 1–7 in order when nothing is allocated yet.
      unit_colours: cur.unit_colours.some(Boolean)
        ? cur.unit_colours
        : Array.from({ length: UNIT_COUNT }, (_, i) => colours[i] ?? ''),
    }))
  }

  function chooseShift(shift: string) {
    const patch: Partial<EntryState> = { shift }
    // B shift after midnight still belongs to yesterday's production date.
    const today = plantDate()
    if (meta.status !== 'submitted' && (st.production_date === today || !st.production_date)) {
      patch.production_date = defaultProductionDate(shift)
    }
    update(patch)
  }

  function setSpan(key: 'make_ready' | 'registration' | 'colour_matching' | 'run', span: Span) {
    setSt((cur) => {
      const next = { ...cur, [key]: span }
      // Production starts where the changeover ends: fill it in while it is empty or
      // still following the changeover end (a different time typed by hand is kept).
      if (key !== 'run') {
        const before = changeoverWindow(cur)
        const after = changeoverWindow(next)
        const following = !stampFilled(cur.run.start) || (before && compareStamps(cur.run.start, before.end) === 0)
        if (after && following && (!before || compareStamps(after.end, before.end) !== 0)) {
          next.run = { ...cur.run, start: { ...after.end } }
        }
      }
      return next
    })
    setDirty(true)
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
  const coWindow = changeoverWindow(st)
  const wasteTotal = wastageTotal(st.wastage)
  const total = Number(st.total_sheets) || 0
  const accounted = (Number(st.ok_sheets) || 0) + (Number(st.separate_sheets) || 0) + wasteTotal
  const machine = machines.find((m) => m.id === st.machine_id)
  const sideInfo = status?.sides?.find((s) => s.side === st.print_side)
  const sideClosed = Boolean(st.print_side && status?.closed_sides?.includes(st.print_side))

  // ---- Saving --------------------------------------------------------------------------
  async function callSave(submit: boolean, close: boolean): Promise<SaveResult | null> {
    const { entry, wastage } = toPayload(st)
    const args = {
      p_id: meta.id,
      p_save_id: crypto.randomUUID(),
      p_submit: submit,
      p_entry: entry,
      p_wastage: wastage,
      p_expected_updated_at: meta.updatedAt,
      p_close_side: close,
    }
    // Retry network failures with the same save id: the server applies it once.
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await supabase.rpc('save_production_entry', args)
      if (!error) return data as SaveResult
      const network = /fetch|network/i.test(error.message ?? '')
      if (!network || attempt >= 3) {
        notify('error', friendlyError(error, 'entry'))
        return null
      }
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }

  async function save(submit: boolean, close = false) {
    if (lookupBusy || saving) return
    setSaving(true)
    setStale('')
    const result = await callSave(submit, close)
    setSaving(false)
    setConfirming(false)
    if (!result) return
    if (result.ok) {
      setErrors([])
      setDirty(false)
      if (result.status === 'submitted') {
        notify('success', `Entry ${entryLabel(result.entry_no)} saved.`)
        navigate('/production/entry')
      } else {
        notify('success', `Draft ${entryLabel(result.entry_no)} saved.`)
        if (meta.status === 'new') navigate(`/production/entry/${result.id}`, { replace: true })
        else setMeta((m) => ({ ...m, entryNo: result.entry_no, status: result.status, updatedAt: result.updated_at }))
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
      return <p className="notice error">Order {st.order_no} is fully closed. No more entries can be added.</p>
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
      <Field label="Order Number *" error={errorOf('order_no')} wide>
        <OrderPicker value={st.order_no} options={orders} disabled={readOnly} invalid={Boolean(errorOf('order_no'))} onSelect={chooseOrder} />
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
        <select value={st.print_side} disabled={readOnly} onChange={(e) => update({ print_side: e.target.value })}>
          <option value="">Select…</option>
          {PRINT_SIDES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
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
              ? `Planned order: details filled in from Production Plan (${formatNumber(status.job.quantity)} sheets planned).`
              : status.last_entry_job
                ? 'Not in Production Plan: details filled in from the last entry for this order.'
                : 'New order, not in Production Plan: enter the job details and colours yourself.'}
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
      <fieldset className="colour-set">
        <legend>Job colours {status?.job ? '(from Production Plan, editable for this entry)' : '(enter the colours for this job)'}</legend>
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
        {plannedRepeats.length > 0 && <p className="notice warn">Entered more than once: {plannedRepeats.join(', ')}. Each colour is kept once.</p>}
        {errorOf('planned_colours') && <p className="field-error">{errorOf('planned_colours')}</p>}
      </fieldset>

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
          <MasterSelect rows={coatings} value={st.coating_id} disabled={readOnly} onChange={(v) => update({ coating_id: v })} />
        </Field>
        <Field label="No. of Colour Changes *" error={errorOf('colour_changes')}>
          <select value={st.colour_changes} disabled={readOnly} onChange={(e) => update({ colour_changes: e.target.value })}>
            <option value="">Select…</option>
            {Array.from({ length: 8 }, (_, n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Coating Changed? *" error={errorOf('coating_changed')}>
          <select value={st.coating_changed} disabled={readOnly} onChange={(e) => update({ coating_changed: e.target.value })}>
            <option value="">Select…</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </div>
    </div>,

    // 4. Changeover Time
    <div key="changeover" className="form-stack">
      <p className={`notice ${required ? 'warn' : 'info'}`}>
        {required
          ? 'Changeover is required for this entry: fill in Make Ready, Registration and Colour Matching.'
          : st.print_side.startsWith('B/B')
            ? 'Changeover is optional: this is not the first B/B entry of this order. Any activity you start needs both Start and End.'
            : 'Changeover is optional for a continuing job. Any activity you start needs both Start and End.'}
      </p>
      {status?.machine_free_since && (
        <p className="notice info">
          This machine was free from <b>{formatMoment(status.machine_free_since)}</b> (end of its last submitted entry).
          {!readOnly && !stampFilled(st.make_ready.start) && (
            <>
              {' '}
              <button
                type="button"
                className="small"
                onClick={() => setSpan('make_ready', { ...st.make_ready, start: isoToStamp(status.machine_free_since) })}
              >
                Start Make Ready at that time
              </button>
            </>
          )}
        </p>
      )}
      <div className="time-cards">
        {ACTIVITIES.map((a) => (
          <TimeCard
            key={a.key}
            title={a.label}
            span={st[a.key]}
            required={required}
            disabled={readOnly}
            error={errorOf(a.key)}
            onChange={(s) => setSpan(a.key, s)}
          />
        ))}
      </div>
      <p className="muted small">
        Machine changeover time:{' '}
        <b>{coWindow ? `${formatDuration(coWindow.minutes)} (${time12(coWindow.start.time)} to ${time12(coWindow.end.time)})` : '—'}</b>
        . Activities can overlap, so this is the time from the earliest start to the latest end, not the sum.
      </p>
    </div>,

    // 5. Run Time
    <div key="run" className="form-stack">
      <TimeCard title="Production Time" span={st.run} required disabled={readOnly} error={errorOf('run')} onChange={(s) => setSpan('run', s)}>
        {!readOnly && coWindow && compareStamps(st.run.start, coWindow.end) !== 0 && (
          <button type="button" className="small" onClick={() => setSpan('run', { ...st.run, start: { ...coWindow.end } })}>
            Start at changeover end ({time12(coWindow.end.time)})
          </button>
        )}
      </TimeCard>
      <p className="muted small">Production starts when the changeover ends. It cannot start earlier.</p>
    </div>,

    // 6. Production Details
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

      <fieldset className="colour-set">
        <legend>Wastage</legend>
        {st.wastage.map((w, i) => (
          <div key={i} className="wastage-row">
            <label className="field">
              <span>Wastage Sheets</span>
              <input
                inputMode="numeric"
                value={w.quantity}
                disabled={readOnly}
                maxLength={8}
                onChange={(e) => update({ wastage: st.wastage.map((x, j) => (j === i ? { ...x, quantity: digits(e.target.value) } : x)) })}
              />
            </label>
            <label className="field">
              <span>Wastage Reason{w.quantity ? ' *' : ''}</span>
              <select
                value={w.reason_id}
                disabled={readOnly}
                onChange={(e) => update({ wastage: st.wastage.map((x, j) => (j === i ? { ...x, reason_id: e.target.value } : x)) })}
              >
                <option value="">Select…</option>
                {choices(reasons, w.reason_id).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {!readOnly && (
              <button
                type="button"
                className="icon-button danger-text"
                aria-label={`Remove wastage row ${i + 1}`}
                title="Remove row"
                onClick={() =>
                  update({ wastage: st.wastage.length > 1 ? st.wastage.filter((_, j) => j !== i) : [{ quantity: '', reason_id: '' }] })
                }
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
        ))}
        {!readOnly && st.wastage.length < 20 && (
          <button type="button" className="small" onClick={() => update({ wastage: [...st.wastage, { quantity: '', reason_id: '' }] })}>
            <Plus size={15} /> Add wastage row
          </button>
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
      <p className="muted small">Total Given Sheets must equal OK + Separate + all wastage rows exactly.</p>

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
            {readOnly ? 'View only' : 'Fill in the six sections. Save Draft keeps your work; Save Entry submits it.'}
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
            onClick={() => setTab(i)}
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
          <button type="button" disabled={tab === 0} onClick={() => setTab(tab - 1)} aria-label="Previous section">
            <ArrowLeft size={16} /> <span className="hide-sm">Previous</span>
          </button>
          <button type="button" disabled={tab === SECTIONS.length - 1} onClick={() => setTab(tab + 1)} aria-label="Next section">
            <span className="hide-sm">Next</span> <ArrowRight size={16} />
          </button>
        </div>
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
            <dt>Order</dt>
            <dd>
              {st.order_no || '—'} · {st.job_name || '—'}
            </dd>
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
                {st.print_side} of order {st.order_no} is finished. Close it (no more entries for this side).
              </span>
            </label>
          )}
          <p className="muted small">Leave it open if the job continues in the next shift. You can close a side later from the entry list.</p>
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
                  setDirty(false)
                  navigate(`/production/entry/${conflict.id}`)
                }}
              >
                Open that draft
              </button>
            </>
          }
        >
          <p>
            <b>{entryLabel(conflict.entry_no)}</b> · {conflict.order_no || 'order not entered yet'}
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
