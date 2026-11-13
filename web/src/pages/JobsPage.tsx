import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { plantDate } from '../lib/dates'
import { friendlyError } from '../lib/errors'
import {
  JOB_COLUMNS,
  JOB_TYPES,
  PLAN_SIDES,
  SLOT_START_COLOURS,
  cleanColours,
  formatDate,
  formatNumber,
  searchPattern,
  sideGroup,
  sortedSides,
  tidy,
} from '../lib/jobs'
import type { Job } from '../lib/jobs'
import { ConfirmDialog, Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

interface PaperType {
  id: string
  name: string
  active: boolean
}

// Job Details: the list of planned jobs. Newest plan date first.
export function JobsPage() {
  const { can } = useAuth()
  const notify = useToast()
  const [params, setParams] = useSearchParams()
  const canCreate = can('production_plan', 'create')
  const canEdit = can('production_plan', 'edit')
  const canDelete = can('production_plan', 'delete')

  const [rows, setRows] = useState<Job[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [papers, setPapers] = useState<PaperType[]>([])
  // The dashboard's "New Job" button opens the form straight away (?new=1).
  const [open, setOpen] = useState<{ job: Job | null; mode: 'view' | 'edit' } | null>(() =>
    params.get('new') === '1' && canCreate ? { job: null, mode: 'edit' } : null,
  )
  const [deleting, setDeleting] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (params.has('new')) setParams({}, { replace: true })
  }, [params, setParams])

  // Search waits until typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setQuery(tidy(typed)), 300)
    return () => clearTimeout(t)
  }, [typed])

  const rangeError = from && to && from > to ? 'From Date cannot be after To Date.' : ''

  useEffect(() => {
    if (rangeError) return
    let alive = true
    let q = supabase
      .from('production_jobs')
      .select(JOB_COLUMNS, { count: 'exact' })
      .order('plan_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id')
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (from) q = q.gte('plan_date', from)
    if (to) q = q.lte('plan_date', to)
    if (query) {
      const p = searchPattern(query)
      q = q.or(`order_no.ilike.${p},job_name.ilike.${p},category.ilike.${p}`)
    }
    q.then(({ data, count, error }) => {
      if (!alive) return
      if (error) setLoadError(friendlyError(error))
      else {
        setRows((data ?? []) as unknown as Job[])
        setTotal(count ?? 0)
        setLoadError('')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [page, from, to, query, reload, rangeError])

  useEffect(() => {
    supabase
      .from('paper_types')
      .select('id, name, active')
      .order('name')
      .then(({ data }) => setPapers((data ?? []) as PaperType[]))
  }, [])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtersOn = Boolean(typed || from || to)

  function refresh() {
    setReload((n) => n + 1)
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    const { data, error } = await supabase.from('production_jobs').delete().eq('id', deleting.id).select('id')
    setBusy(false)
    setDeleting(null)
    if (error) {
      notify(
        'error',
        error.code === '23503'
          ? `Order ${deleting.order_no} is already used in production or ink records, so it cannot be deleted.`
          : friendlyError(error, 'job'),
      )
    } else if (!data?.length) {
      notify('error', 'You do not have permission to do this.')
    } else {
      notify('success', `Job ${deleting.order_no} deleted.`)
      if (rows.length === 1 && page > 1) setPage(page - 1)
      else refresh()
    }
  }

  const headers = ['S.No', 'Date', 'Order No', 'Job Name', 'Category', 'Print Sides', 'UPS', 'Job Type', 'Paper Type', 'Qty (Sheets)', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Job Details</h1>
          <p className="muted">Planned printing jobs · the source for Production Entry and Ink Formula</p>
        </div>
        {canCreate && (
          <button type="button" className="primary" onClick={() => setOpen({ job: null, mode: 'edit' })}>
            <Plus size={18} /> Create New Job
          </button>
        )}
      </div>

      <section className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
                setPage(1)
              }}
              placeholder="Search Order No, Job Name or Category"
              aria-label="Search"
            />
          </label>
          <label className="inline-field">
            <span>From</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value)
                setPage(1)
              }}
              aria-label="From Date"
            />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value)
                setPage(1)
              }}
              aria-label="To Date"
            />
          </label>
          {filtersOn && (
            <button
              type="button"
              onClick={() => {
                setTyped('')
                setQuery('')
                setFrom('')
                setTo('')
                setPage(1)
              }}
            >
              Clear
            </button>
          )}
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
                    {filtersOn ? 'No matching jobs.' : 'No jobs planned yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((j, i) => (
                  <tr key={j.id} className="clickable" onClick={() => setOpen({ job: j, mode: 'view' })}>
                    <td>{(page - 1) * PAGE_SIZE + i + 1}</td>
                    <td>{formatDate(j.plan_date)}</td>
                    <td>
                      <b>{j.order_no}</b>
                    </td>
                    <td className="wrap">{j.job_name}</td>
                    <td>{j.category}</td>
                    <td>{sortedSides(j).map((x) => x.print_side).join(', ')}</td>
                    <td className="num">{j.ups}</td>
                    <td>{j.job_type}</td>
                    <td>{j.paper_types?.name}</td>
                    <td className="num">{formatNumber(j.quantity)}</td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setOpen({ job: j, mode: 'view' })}
                        title="View"
                        aria-label={`View ${j.order_no}`}
                      >
                        <Eye size={17} />
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => setOpen({ job: j, mode: 'edit' })}
                          title="Edit"
                          aria-label={`Edit ${j.order_no}`}
                        >
                          <Pencil size={17} />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          className="icon-button danger-text"
                          onClick={() => setDeleting(j)}
                          title="Delete"
                          aria-label={`Delete ${j.order_no}`}
                        >
                          <Trash2 size={17} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <span className="muted small">
            {total
              ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`
              : 'Showing 0 jobs'}
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
      </section>

      {open && (
        <JobForm
          job={open.job}
          readOnly={open.mode === 'view' || (open.job ? !canEdit : !canCreate)}
          canEdit={canEdit}
          papers={papers}
          onEdit={() => setOpen({ job: open.job, mode: 'edit' })}
          onClose={() => setOpen(null)}
          onSaved={(orderNo, isNew) => {
            notify('success', `Job ${orderNo} ${isNew ? 'created' : 'saved'}.`)
            setOpen(null)
            if (isNew) setPage(1)
            refresh()
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete job?"
          message={
            <>
              <b>
                {deleting.order_no} · {deleting.job_name}
              </b>{' '}
              will be removed permanently. A job already used in production or ink records cannot be deleted.
            </>
          }
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
  job: Job | null
  readOnly: boolean
  canEdit: boolean
  papers: PaperType[]
  onEdit: () => void
  onClose: () => void
  onSaved: (orderNo: string, isNew: boolean) => void
}

interface Slot {
  key: number
  print_side: string
  colours: string[]
}

let slotKey = 0
const isBB = (side: string) => side === 'B/B F' || side === 'B/B B'

const newSlot = (print_side = '', colours: string[] = []): Slot => ({
  key: ++slotKey,
  print_side,
  colours: Array.from({ length: Math.max(SLOT_START_COLOURS, colours.length) }, (_, i) => colours[i] ?? ''),
})

type SaveReply =
  | { ok: true; id: string; updated_at: string }
  | { ok: false; code: 'INVALID'; errors: { field: string; message: string }[] }
  | { ok: false; code: 'STALE'; message: string }

function JobForm({ job, readOnly, canEdit, papers, onEdit, onClose, onSaved }: FormProps) {
  const [date, setDate] = useState(job?.plan_date ?? plantDate())
  const [orderNo, setOrderNo] = useState(job?.order_no ?? '')
  const [jobName, setJobName] = useState(job?.job_name ?? '')
  const [category, setCategory] = useState(job?.category ?? '')
  const [ups, setUps] = useState(job ? String(job.ups) : '')
  const [jobType, setJobType] = useState<string>(job?.job_type ?? '')
  const [paperId, setPaperId] = useState(job?.paper_type_id ?? '')
  const [quantity, setQuantity] = useState(job ? String(job.quantity) : '')
  const [slots, setSlots] = useState<Slot[]>(() =>
    job && job.production_job_sides?.length
      ? sortedSides(job)
          // B/B F and B/B B share one slot: show it once.
          .filter((x, i, all) => !isBB(x.print_side) || all.findIndex((y) => isBB(y.print_side)) === i)
          .map((x) => newSlot(x.print_side, x.colours))
      : [newSlot()],
  )
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const errorBox = useRef<HTMLDivElement>(null)
  // Show the full list of problems where the user is looking.
  useEffect(() => {
    if (errors.length) errorBox.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [errors])

  // Active paper types, plus the job's own paper type even if it was made inactive later.
  const paperOptions = useMemo(
    () => papers.filter((p) => p.active || p.id === job?.paper_type_id),
    [papers, job?.paper_type_id],
  )
  const usedSides = slots.map((x) => x.print_side).filter(Boolean)
  const group = usedSides.map(sideGroup).find(Boolean) ?? ''

  const setSlot = useCallback((key: number, patch: Partial<Slot>) => {
    setSlots((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (readOnly) return
    const values = {
      plan_date: date,
      order_no: tidy(orderNo),
      job_name: tidy(jobName),
      category: tidy(category) || null,
      ups: Number(ups),
      job_type: jobType,
      paper_type_id: paperId,
      quantity: Number(quantity),
    }
    const sides = slots.map((x) => ({ print_side: x.print_side, colours: cleanColours(x.colours).colours }))
    // Every rule is checked on the server, which lists all problems at once.
    setBusy(true)
    setErrors([])
    const { data, error } = await supabase.rpc('save_production_job', {
      p_id: job?.id ?? null,
      p_job: { ...values, ups: ups.trim() ? values.ups : null, quantity: quantity.trim() ? values.quantity : null },
      p_sides: sides,
      p_expected_updated_at: job?.updated_at ?? null,
    })
    setBusy(false)
    if (error) return setErrors([friendlyError(error, 'job')])
    const reply = data as SaveReply
    if (reply.ok) return onSaved(values.order_no, !job)
    if (reply.code === 'INVALID') return setErrors(reply.errors.map((x) => x.message))
    setErrors([reply.message])
  }

  const title = readOnly ? `Job ${job?.order_no ?? ''}` : job ? `Edit job ${job.order_no}` : 'Create new job'
  const intOnly = (v: string) => v.replace(/[^0-9]/g, '')

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={820}
      footer={
        readOnly ? (
          <>
            <button type="button" onClick={onClose}>
              Close
            </button>
            {job && canEdit && (
              // A separate key keeps React from turning this same button into Save mid-click.
              <button key="edit" type="button" className="primary" onClick={onEdit}>
                <Pencil size={16} /> Edit
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button key="save" type="submit" form="job-form" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )
      }
    >
      <form id="job-form" className="form-stack" onSubmit={submit} noValidate>
        <div className="form-grid">
          <label className="field">
            <span>Date *</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} />
          </label>
          <label className="field">
            <span>Order Number *</span>
            <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} maxLength={60} disabled={readOnly} autoFocus={!readOnly && !job} />
          </label>
          <label className="field span-2">
            <span>Job Name *</span>
            <input value={jobName} onChange={(e) => setJobName(e.target.value)} maxLength={150} disabled={readOnly} />
          </label>
          <label className="field">
            <span>Category</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} disabled={readOnly} />
          </label>
          <label className="field">
            <span>UPS *</span>
            <input inputMode="numeric" value={ups} onChange={(e) => setUps(intOnly(e.target.value))} maxLength={4} disabled={readOnly} />
          </label>
          <label className="field">
            <span>Job Type *</span>
            <select value={jobType} onChange={(e) => setJobType(e.target.value)} disabled={readOnly}>
              <option value="">Select…</option>
              {JOB_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Type of Paper *</span>
            <select value={paperId} onChange={(e) => setPaperId(e.target.value)} disabled={readOnly}>
              <option value="">{paperOptions.length ? 'Select…' : 'No paper types: add them under Master'}</option>
              {paperOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Quantity (Sheets) *</span>
            <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(intOnly(e.target.value))} maxLength={9} disabled={readOnly} />
          </label>
        </div>

        <div className="slots">
          <div className="slots-head">
            <h3>Print sides and colours</h3>
            <span className="muted small">One slot per print side. Production Entry shows only the colours of the side being printed.</span>
          </div>
          {slots.map((slot, n) => {
            const { repeated } = cleanColours(slot.colours)
            const dupKeys = new Set(repeated.map((c) => c.toLowerCase()))
            const sameSide = slot.print_side && usedSides.filter((x) => x === slot.print_side).length > 1
            return (
              <fieldset key={slot.key} className="colour-set slot">
                <legend>Print side slot {n + 1}</legend>
                <div className="slot-top">
                  <label className={`field ${sameSide ? 'invalid' : ''}`}>
                    <span>Print Side *</span>
                    <select value={slot.print_side} disabled={readOnly} onChange={(e) => setSlot(slot.key, { print_side: e.target.value })}>
                      <option value="">Select…</option>
                      {PLAN_SIDES.map((x) => (
                        <option
                          key={x}
                          value={x}
                          disabled={
                            x !== slot.print_side &&
                            (usedSides.includes(x) ||
                              (isBB(x) && slots.some((o) => o.key !== slot.key && isBB(o.print_side))) ||
                              (group !== '' && sideGroup(x) !== group && slots.length > 1))
                          }
                        >
                          {isBB(x) ? `${x} (covers B/B F + B/B B)` : x}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!readOnly && slots.length > 1 && (
                    <button
                      type="button"
                      className="small danger-text"
                      onClick={() => setSlots((list) => list.filter((x) => x.key !== slot.key))}
                      aria-label={`Remove print side slot ${n + 1}`}
                    >
                      <Trash2 size={15} /> Remove side
                    </button>
                  )}
                </div>
                {isBB(slot.print_side) && (
                  <p className="notice info">
                    B/B F and B/B B are printed together: this slot plans both sides, with the same colours.
                  </p>
                )}
                <div className="colour-grid">
                  {slot.colours.map((c, i) => (
                    <label key={i} className={`field ${dupKeys.has(tidy(c).toLowerCase()) && tidy(c) ? 'dup' : ''}`}>
                      <span>Colour {i + 1}</span>
                      <input
                        value={c}
                        maxLength={40}
                        disabled={readOnly}
                        onChange={(e) => setSlot(slot.key, { colours: slot.colours.map((x, j) => (j === i ? e.target.value : x)) })}
                      />
                    </label>
                  ))}
                </div>
                {!readOnly && (
                  <button type="button" className="small" onClick={() => setSlot(slot.key, { colours: [...slot.colours, ''] })}>
                    <Plus size={15} /> Add Colour
                  </button>
                )}
                {repeated.length > 0 && !readOnly && (
                  <p className="notice warn">
                    Entered more than once: <b>{repeated.join(', ')}</b>. Each colour is saved once.
                  </p>
                )}
              </fieldset>
            )
          })}
          {!readOnly && !slots.some((x) => isBB(x.print_side) || x.print_side === 'O/S') && slots.length < 2 && (
            <button type="button" onClick={() => setSlots((list) => [...list, newSlot()])}>
              <Plus size={16} /> Add Print Side
            </button>
          )}
        </div>

        {job && (
          <p className="muted small">
            Created {new Date(job.created_at).toLocaleString('en-IN')} · Last modified {new Date(job.updated_at).toLocaleString('en-IN')}
          </p>
        )}
        {errors.length > 0 && (
          <div className="notice error" ref={errorBox} role="alert">
            <b>Please fix {errors.length === 1 ? 'this' : `these ${errors.length} items`} and save again:</b>
            <ul className="error-list">
              {[...new Set(errors)].map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  )
}
