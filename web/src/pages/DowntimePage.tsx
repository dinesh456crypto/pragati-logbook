import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate } from '../lib/jobs'
import { DOWNTIME_GROUPS, entryLabel, formatDuration, formatMoment, isoToStamp, nowStamp, spanMinutes, stampToIso } from '../lib/production'
import type { DowntimeGroup, Span } from '../lib/production'
import type { Machine } from '../lib/types'
import { TimeCard } from '../components/TimeCard'
import { ConfirmDialog, Modal } from '../components/Modal'
import { useToast } from '../components/Toast'
import { DowntimeReasonPicker } from '../components/DowntimeReasons'
import { useDowntimeReasons } from '../lib/downtime'

const PAGE_SIZE = 15

interface EventRow {
  id: string
  kind: DowntimeGroup | null
  machine_id: string
  entry_id: string | null
  start_at: string | null
  end_at: string | null
  minutes: number | null
  reason_id: string | null
  remarks: string | null
  production_date: string | null
  shift: string | null
  updated_at: string
  machines: { code: string } | null
  downtime_reasons: { name: string; category: DowntimeGroup } | null
  production_entries: { id: string; entry_no: number; order_no: string | null } | null
}

const COLUMNS =
  'id, kind, machine_id, entry_id, start_at, end_at, minutes, reason_id, remarks, production_date, shift, updated_at, machines(code), downtime_reasons(name, category), production_entries(id, entry_no, order_no)'

// /production/downtime: every downtime record (Man, Machine, Material, Others).
// Downtime between jobs is recorded here; downtime during a job belongs to its entry.
export function DowntimePage() {
  const { can } = useAuth()
  const notify = useToast()
  const canCreate = can('downtime', 'create')
  const canEdit = can('downtime', 'edit')
  const canDelete = can('downtime', 'delete')

  const [rows, setRows] = useState<EventRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [filters, setFilters] = useState({ machine: '', group: '', scope: '', from: '', to: '' })
  const [machines, setMachines] = useState<Machine[]>([])
  const [editing, setEditing] = useState<EventRow | 'new' | null>(null)
  const [deleting, setDeleting] = useState<EventRow | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase
      .from('machines')
      .select('id, code, name, active, default_speed, sort_order')
      .order('sort_order')
      .order('code')
      .then(({ data }) => setMachines((data ?? []) as Machine[]))
  }, [])

  const rangeError = filters.from && filters.to && filters.from > filters.to ? 'From Date cannot be after To Date.' : ''

  useEffect(() => {
    if (rangeError) return
    let alive = true
    let q = supabase
      .from('downtime_events')
      .select(COLUMNS, { count: 'exact' })
      .order('start_at', { ascending: false, nullsFirst: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (filters.machine) q = q.eq('machine_id', filters.machine)
    if (filters.group) q = q.eq('kind', filters.group)
    if (filters.scope === 'between') q = q.is('entry_id', null)
    if (filters.scope === 'job') q = q.not('entry_id', 'is', null)
    if (filters.from) q = q.gte('production_date', filters.from)
    if (filters.to) q = q.lte('production_date', filters.to)
    q.then(({ data, count, error }) => {
      if (!alive) return
      if (error) setLoadError(friendlyError(error))
      else {
        setRows((data ?? []) as unknown as EventRow[])
        setTotal(count ?? 0)
        setLoadError('')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [page, filters, reload, rangeError])

  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    const { data, error } = await supabase.from('downtime_events').delete().eq('id', deleting.id).select('id')
    setBusy(false)
    setDeleting(null)
    if (error) notify('error', friendlyError(error, 'record'))
    else if (!data?.length) notify('error', 'You do not have permission to delete this record.')
    else {
      notify('success', 'Downtime record deleted.')
      setReload((n) => n + 1)
    }
  }

  const headers = ['S.No', 'Date', 'Shift', 'Machine', 'Start', 'End', 'Duration', 'Type', 'Reason', 'Job', 'Remarks', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Downtime</h1>
          <p className="muted">
            Downtime between jobs is recorded here. Downtime during a job is recorded in that job's Production Entry.
          </p>
        </div>
        {canCreate && (
          <button type="button" className="primary" onClick={() => setEditing('new')}>
            <Plus size={18} /> Record downtime between jobs
          </button>
        )}
      </div>

      <section className="card">
        <div className="toolbar">
          <select value={filters.machine} onChange={(e) => setFilter('machine', e.target.value)} aria-label="Machine filter">
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
              </option>
            ))}
          </select>
          <select value={filters.group} onChange={(e) => setFilter('group', e.target.value)} aria-label="Type filter">
            <option value="">All types</option>
            {DOWNTIME_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select value={filters.scope} onChange={(e) => setFilter('scope', e.target.value)} aria-label="Where filter">
            <option value="">During jobs and between jobs</option>
            <option value="between">Between jobs only</option>
            <option value="job">During jobs only</option>
          </select>
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} aria-label="From Date" />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} aria-label="To Date" />
          </label>
        </div>
        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    No downtime records.
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const between = !r.entry_id
                  return (
                    <tr key={r.id}>
                      <td>{(page - 1) * PAGE_SIZE + i + 1}</td>
                      <td>{formatDate(r.production_date)}</td>
                      <td>{r.shift}</td>
                      <td>{r.machines?.code}</td>
                      <td>{formatMoment(r.start_at)}</td>
                      <td>{r.end_at ? formatMoment(r.end_at) : <span className="badge amber">Still down</span>}</td>
                      <td>{formatDuration(r.minutes)}</td>
                      <td>{r.kind ?? r.downtime_reasons?.category}</td>
                      <td>{r.downtime_reasons?.name}</td>
                      <td>
                        {between ? (
                          <span className="muted">Between jobs</span>
                        ) : (
                          <Link to={`/production/entry/${r.entry_id}`}>
                            {entryLabel(r.production_entries?.entry_no)} {r.production_entries?.order_no}
                          </Link>
                        )}
                      </td>
                      <td className="wrap">{r.remarks}</td>
                      <td className="row-actions">
                        {between && canEdit && (
                          <button type="button" className="icon-button" title="Edit" aria-label="Edit" onClick={() => setEditing(r)}>
                            <Pencil size={17} />
                          </button>
                        )}
                        {between && canDelete && (
                          <button
                            type="button"
                            className="icon-button danger-text"
                            title="Delete"
                            aria-label="Delete"
                            onClick={() => setDeleting(r)}
                          >
                            <Trash2 size={17} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted small">
            {total ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}` : 'Showing 0 records'}
          </span>
          <div className="actions">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>
        <p className="muted small">
          Downtime between jobs moves the machine's ready time: the next job's Job Changeover starts when it ends.
        </p>
      </section>

      {editing && (
        <OutsideForm
          row={editing === 'new' ? null : editing}
          machines={machines}
          onClose={() => setEditing(null)}
          onSaved={() => {
            notify('success', 'Downtime saved.')
            setEditing(null)
            setReload((n) => n + 1)
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this downtime record?"
          message={`${deleting.machines?.code} · ${formatMoment(deleting.start_at)}. It will be removed permanently.`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}

interface FormProps {
  row: EventRow | null
  machines: Machine[]
  onClose: () => void
  onSaved: () => void
}

function OutsideForm({ row, machines, onClose, onSaved }: FormProps) {
  const { profile } = useAuth()
  const [machineId, setMachineId] = useState(row?.machine_id ?? '')
  const [span, setSpan] = useState<Span>(() =>
    row ? { start: isoToStamp(row.start_at), end: isoToStamp(row.end_at) } : { start: nowStamp(), end: { date: '', time: '' } },
  )
  const [reasonId, setReasonId] = useState(row?.reason_id ?? '')
  const [remarks, setRemarks] = useState(row?.remarks ?? '')
  const reasons = useDowntimeReasons()
  const [myMachines, setMyMachines] = useState<string[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!profile || profile.role === 'super_admin' || profile.all_machines) return
    supabase
      .from('profile_machines')
      .select('machine_id')
      .eq('profile_id', profile.id)
      .then(({ data }) => setMyMachines((data ?? []).map((r: { machine_id: string }) => r.machine_id)))
  }, [profile])

  const machineChoices = useMemo(
    () => machines.filter((m) => (m.active && (myMachines === null || myMachines.includes(m.id))) || m.id === machineId),
    [machines, myMachines, machineId],
  )
  const minutes = spanMinutes(span)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const problems: string[] = []
    if (!machineId) problems.push('Select a machine.')
    if (!span.start.date || !span.start.time) problems.push('Enter the Start date and time.')
    if (Boolean(span.end.date) !== Boolean(span.end.time)) problems.push('Enter both the End date and time, or leave both empty.')
    if (minutes !== null && minutes < 0) problems.push('End is before Start.')
    if (!reasonId) problems.push('Select a downtime reason.')
    if (problems.length) return setErrors(problems)
    setBusy(true)
    setErrors([])
    const { data, error } = await supabase.rpc('save_outside_downtime', {
      p_id: row?.id ?? null,
      p_event: {
        machine_id: machineId,
        start_at: stampToIso(span.start),
        end_at: stampToIso(span.end),
        reason_id: reasonId,
        remarks,
      },
      p_expected_updated_at: row?.updated_at ?? null,
    })
    setBusy(false)
    if (error) return setErrors([friendlyError(error, 'record')])
    const reply = data as { ok: boolean; errors?: { message: string }[]; message?: string }
    if (reply.ok) return onSaved()
    setErrors(reply.errors?.map((x) => x.message) ?? [reply.message ?? 'Could not save.'])
  }

  return (
    <Modal
      title={`${row ? 'Edit' : 'Record'} downtime between jobs`}
      onClose={onClose}
      width={760}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="downtime-form" className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="downtime-form" className="form-stack" onSubmit={submit} noValidate>
        <div className="form-grid two">
          <label className="field">
            <span>Machine *</span>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">Select…</option>
              {machineChoices.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Reason * (click one)</span>
          <DowntimeReasonPicker reasons={reasons} value={reasonId} onChange={setReasonId} />
        </div>
        <TimeCard title="Downtime" span={span} onChange={setSpan} />
        <p className="muted small">Leave End empty while the machine is still down, and fill it in when it is working again.</p>
        <label className="field">
          <span>Remarks</span>
          <textarea rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>
        {errors.length > 0 && (
          <div className="notice error">
            {errors.map((x) => (
              <div key={x}>{x}</div>
            ))}
          </div>
        )}
      </form>
    </Modal>
  )
}
