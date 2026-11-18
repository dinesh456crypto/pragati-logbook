import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, FileDown, FileUp, Pencil, Plus, Search, Trash2 } from 'lucide-react'
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
import type { Machine } from '../lib/types'
import { matchMaster, parseQrJob, scannedOrderNo } from '../lib/qr'
import type { QrJob } from '../lib/qr'
import { ConfirmDialog, Modal } from '../components/Modal'
import { ScanButton } from '../components/ScanButton'
import { JobBulkUpload } from '../components/JobBulkUpload'
import { buildTemplate, saveBlob } from '../lib/jobUpload'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

interface PaperType {
  id: string
  name: string
  active: boolean
}
type Coating = PaperType

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
  const [coatings, setCoatings] = useState<Coating[]>([])
  const [machines, setMachines] = useState<Machine[]>([])
  const [machineFilter, setMachineFilter] = useState('')
  // The dashboard's "New Job" button opens the form straight away (?new=1).
  const [open, setOpen] = useState<{ job: Job | null; mode: 'view' | 'edit'; orderNo?: string; qr?: QrJob | null; qrDiff?: string[] } | null>(() =>
    params.get('new') === '1' && canCreate ? { job: null, mode: 'edit' } : null,
  )
  const [deleting, setDeleting] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [templateBusy, setTemplateBusy] = useState(false)

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
    if (machineFilter) q = q.eq('machine_id', machineFilter)
    if (query) {
      const p = searchPattern(query)
      q = q.or(`order_no.ilike.${p},cso_no.ilike.${p},job_name.ilike.${p},category.ilike.${p}`)
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
  }, [page, from, to, machineFilter, query, reload, rangeError])

  useEffect(() => {
    supabase
      .from('paper_types')
      .select('id, name, active')
      .order('name')
      .then(({ data }) => setPapers((data ?? []) as PaperType[]))
    supabase
      .from('coatings')
      .select('id, name, active')
      .order('name')
      .then(({ data }) => setCoatings((data ?? []) as Coating[]))
    supabase
      .from('machines')
      .select('id, code, name, active, default_speed, sort_order')
      .order('sort_order')
      .order('code')
      .then(({ data }) => setMachines((data ?? []) as Machine[]))
  }, [])

  // A scanned job card QR (or plain barcode) opens that job, or starts a new job filled
  // in from the QR (only the number, for a plain barcode).
  async function openScanned(text: string) {
    const qr = parseQrJob(text)
    const orderNo = tidy(scannedOrderNo(text, qr))
    if (!orderNo) return
    const { data, error } = await supabase
      .from('production_jobs')
      .select(JOB_COLUMNS)
      .ilike('order_no', orderNo.replace(/[\\%_]/g, (c) => `\\${c}`))
      .limit(1)
    if (error) return notify('error', friendlyError(error))
    const found = (data ?? [])[0] as unknown as Job | undefined
    if (found) setOpen({ job: found, mode: 'view', qrDiff: qr ? qrDifferences(qr, found, machines, papers, coatings) : [] })
    else if (canCreate) setOpen({ job: null, mode: 'edit', orderNo, qr })
    else notify('error', `Production order ${orderNo} is not in Job Details.`)
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const filtersOn = Boolean(typed || from || to || machineFilter)

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
          ? `Production order ${deleting.order_no} is already used in production or ink records, so it cannot be deleted.`
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

  const headers = ['S.No', 'Date', 'Machine', 'Prod. Order No', 'CSO No', 'Job Name', 'Category', 'Print Sides', 'UPS', 'Job Type', 'Paper Type', 'Coating', 'Qty (Sheets)', '']

  // The template's Machine, Type of Paper and Coating lists are the masters at download time.
  async function downloadTemplate() {
    setTemplateBusy(true)
    try {
      const [paperRes, coatingRes, machineRes] = await Promise.all([
        supabase.from('paper_types').select('name').eq('active', true).order('name'),
        supabase.from('coatings').select('name').eq('active', true).order('name'),
        supabase.from('machines').select('code').eq('active', true).order('sort_order').order('code'),
      ])
      const error = paperRes.error ?? coatingRes.error ?? machineRes.error
      if (error) throw new Error(friendlyError(error))
      const names = (d: unknown) => ((d ?? []) as { name: string }[]).map((p) => p.name)
      const codes = ((machineRes.data ?? []) as { code: string }[]).map((m) => m.code)
      const blob = await buildTemplate(names(paperRes.data), names(coatingRes.data), codes)
      saveBlob(blob, 'Pragati Job Details Bulk Upload Template.xlsx')
    } catch (err) {
      notify('error', `Could not create the template: ${(err as Error).message}`)
    } finally {
      setTemplateBusy(false)
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Job Details</h1>
          <p className="muted">Planned printing jobs · the source for Production Entry and Ink Formula</p>
        </div>
        <div className="actions">
          <ScanButton label="Scan Order" onScan={openScanned} />
          {canCreate && (
            <>
            <button type="button" onClick={downloadTemplate} disabled={templateBusy}>
              <FileDown size={18} /> {templateBusy ? 'Preparing…' : 'Download Template'}
            </button>
            <button type="button" onClick={() => setUploading(true)}>
              <FileUp size={18} /> Bulk Upload
            </button>
            <button type="button" className="primary" onClick={() => setOpen({ job: null, mode: 'edit' })}>
              <Plus size={18} /> Create New Job
            </button>
            </>
          )}
        </div>
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
              placeholder="Search Production Order, CSO, Job Name or Category"
              aria-label="Search"
            />
          </label>
          <select
            value={machineFilter}
            onChange={(e) => {
              setMachineFilter(e.target.value)
              setPage(1)
            }}
            aria-label="Machine filter"
          >
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
              </option>
            ))}
          </select>
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
                setMachineFilter('')
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
                    <td>{j.machines?.code ?? <span className="muted">—</span>}</td>
                    <td>
                      <b>{j.order_no}</b>
                    </td>
                    <td>{j.cso_no}</td>
                    <td className="wrap">{j.job_name}</td>
                    <td>{j.category}</td>
                    <td>{sortedSides(j).map((x) => x.print_side).join(', ')}</td>
                    <td className="num">{j.ups}</td>
                    <td>{j.job_type}</td>
                    <td>{j.paper_types?.name}</td>
                    <td>{j.coatings?.name}</td>
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
          coatings={coatings}
          machines={machines}
          initialOrderNo={open.orderNo}
          qr={open.qr ?? null}
          qrDiff={open.qrDiff ?? []}
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

      {uploading && (
        <JobBulkUpload
          onClose={() => setUploading(false)}
          onTemplate={downloadTemplate}
          templateBusy={templateBusy}
          onImported={(count) => {
            setUploading(false)
            notify('success', `${count} job${count === 1 ? '' : 's'} imported.`)
            setPage(1)
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
  coatings: Coating[]
  machines: Machine[]
  initialOrderNo?: string
  qr?: QrJob | null // a scanned job card: fills the new job
  qrDiff?: string[] // a scanned job card that differs from this planned job
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

function JobForm({ job, readOnly, canEdit, papers, coatings, machines, initialOrderNo, qr, qrDiff = [], onEdit, onClose, onSaved }: FormProps) {
  // A new job started from a scanned job card QR begins with its values.
  const [init] = useState(() => (!job && qr ? qrValues(qr, machines, papers, coatings) : null))
  const [qrNotes, setQrNotes] = useState<string[]>(init?.notes ?? [])
  const [date, setDate] = useState(job?.plan_date ?? init?.plan_date ?? plantDate())
  const [machineId, setMachineId] = useState(job?.machine_id ?? init?.machine_id ?? '')
  const [orderNo, setOrderNo] = useState(job?.order_no ?? initialOrderNo ?? '')
  const [csoNo, setCsoNo] = useState(job?.cso_no ?? init?.cso_no ?? '')
  const [coatingId, setCoatingId] = useState(job?.coating_id ?? init?.coating_id ?? '')
  const [jobName, setJobName] = useState(job?.job_name ?? init?.job_name ?? '')
  const [category, setCategory] = useState(job?.category ?? init?.category ?? '')
  const [ups, setUps] = useState(job ? String(job.ups) : (init?.ups ?? ''))
  const [jobType, setJobType] = useState<string>(job?.job_type ?? init?.job_type ?? '')
  const [paperId, setPaperId] = useState(job?.paper_type_id ?? init?.paper_type_id ?? '')
  const [quantity, setQuantity] = useState(job ? String(job.quantity) : (init?.quantity ?? ''))
  const [slots, setSlots] = useState<Slot[]>(() =>
    job && job.production_job_sides?.length
      ? sortedSides(job)
          // B/B F and B/B B share one slot: show it once.
          .filter((x, i, all) => !isBB(x.print_side) || all.findIndex((y) => isBB(y.print_side)) === i)
          .map((x) => newSlot(x.print_side, x.colours))
      : init?.slots.length
        ? init.slots.map((x) => newSlot(x.print_side, x.colours))
        : [newSlot()],
  )

  // Scanning inside the form: a plain barcode fills the number; a job card QR also
  // fills every field that is still empty (what was typed is kept).
  function applyScan(text: string) {
    const q = parseQrJob(text)
    setOrderNo(tidy(scannedOrderNo(text, q)))
    if (!q) return
    const v = qrValues(q, machines, papers, coatings)
    if (v.plan_date && !job) setDate(v.plan_date)
    if (v.machine_id && !machineId) setMachineId(v.machine_id)
    if (v.cso_no && !csoNo.trim()) setCsoNo(v.cso_no)
    if (v.coating_id && !coatingId) setCoatingId(v.coating_id)
    if (v.job_name && !jobName.trim()) setJobName(v.job_name)
    if (v.category && !category.trim()) setCategory(v.category)
    if (v.ups && !ups.trim()) setUps(v.ups)
    if (v.job_type && !jobType) setJobType(v.job_type)
    if (v.paper_type_id && !paperId) setPaperId(v.paper_type_id)
    if (v.quantity && !quantity.trim()) setQuantity(v.quantity)
    const blankSlots = slots.every((x) => !x.print_side && x.colours.every((c) => !c.trim()))
    if (v.slots.length && blankSlots) setSlots(v.slots.map((x) => newSlot(x.print_side, x.colours)))
    setQrNotes(v.notes)
  }
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
  const machineOptions = useMemo(
    () => machines.filter((m) => m.active || m.id === job?.machine_id),
    [machines, job?.machine_id],
  )
  const coatingOptions = useMemo(
    () => coatings.filter((c) => c.active || c.id === job?.coating_id),
    [coatings, job?.coating_id],
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
      cso_no: tidy(csoNo),
      coating_id: coatingId || null,
      machine_id: machineId || null,
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
        {initialOrderNo && !job && (
          <p className="notice info">
            Scanned production order {initialOrderNo} is not planned yet:{' '}
            {qr ? 'the details from the QR are filled in. Check them, fill in what is empty, and save.' : 'fill in the new job.'}
          </p>
        )}
        {qrNotes.length > 0 && !readOnly && (
          <div className="notice warn">
            <b>From the QR, please check:</b>
            <ul className="error-list">
              {qrNotes.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {qrDiff.length > 0 && (
          <div className="notice warn">
            <b>The scanned QR does not match this planned job.</b> The plan is kept as it is; edit the job if the QR is right.
            <ul className="error-list">
              {qrDiff.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span>Date *</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={readOnly} />
          </label>
          <label className="field">
            <span>Machine *</span>
            <select value={machineId} onChange={(e) => setMachineId(e.target.value)} disabled={readOnly}>
              <option value="">Select…</option>
              {machineOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code}
                  {m.name !== m.code ? ` · ${m.name}` : ''}
                  {m.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Production Order Number *</span>
            <div className="with-scan">
              <input
                value={orderNo}
                onChange={(e) => setOrderNo(e.target.value)}
                maxLength={60}
                disabled={readOnly}
                autoFocus={!readOnly && !job && !initialOrderNo}
                aria-label="Production Order Number"
              />
              {!readOnly && <ScanButton label="" onScan={applyScan} />}
            </div>
          </div>
          <label className="field">
            <span>CSO Number *</span>
            <input value={csoNo} onChange={(e) => setCsoNo(e.target.value)} maxLength={60} disabled={readOnly} />
          </label>
          <label className="field span-2">
            <span>Job Name *</span>
            <input value={jobName} onChange={(e) => setJobName(e.target.value)} maxLength={150} disabled={readOnly} />
          </label>
          <label className="field">
            <span>Category *</span>
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
            <span>Coating *</span>
            <select value={coatingId} onChange={(e) => setCoatingId(e.target.value)} disabled={readOnly}>
              <option value="">{coatingOptions.length ? 'Select…' : 'No coatings: add them under Master'}</option>
              {coatingOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? '' : ' (inactive)'}
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

// ---- Job card QR ---------------------------------------------------------------------

interface QrValues {
  plan_date?: string
  machine_id?: string
  cso_no?: string
  coating_id?: string
  job_name?: string
  category?: string
  ups?: string
  job_type?: string
  paper_type_id?: string
  quantity?: string
  slots: { print_side: string; colours: string[] }[]
  notes: string[] // values that could not be used
}

// The form values for a scanned QR. Machine, paper and coating must be active in the
// masters; anything else stays empty with a note.
function qrValues(q: QrJob, machines: Machine[], papers: PaperType[], coatings: Coating[]): QrValues {
  const notes: string[] = []
  const pick = <T extends { id: string; name: string; active: boolean; code?: string }>(rows: T[], value: string | undefined, label: string) => {
    if (!value) return undefined
    const hit = matchMaster(rows, value)
    if (!hit) notes.push(`${label} "${value}" is not in the ${label} master: choose it.`)
    else if (!hit.active) notes.push(`${label} "${value}" is inactive: choose another.`)
    return hit?.active ? hit.id : undefined
  }
  const jobType = q.job_type ? JOB_TYPES.find((t) => t.toLowerCase().replace(/[^a-z]/g, '') === q.job_type!.toLowerCase().replace(/[^a-z]/g, '')) : undefined
  if (q.job_type && !jobType) notes.push(`Job Type "${q.job_type}" is not NPD, NEW or Re-Print: choose it.`)
  if (q.print_side && q.sides.length === 0) notes.push(`Print Side "${q.print_side}" is not O/S, F/S, B/S, F/S + B/S or B/B: add the print sides.`)
  return {
    plan_date: q.plan_date,
    machine_id: pick(machines, q.machine, 'Machine'),
    cso_no: q.cso_no,
    coating_id: pick(coatings, q.coating, 'Coating'),
    job_name: q.job_name,
    category: q.category,
    ups: q.ups,
    job_type: jobType,
    paper_type_id: pick(papers, q.paper, 'Type of Paper'),
    quantity: q.quantity,
    // B/B F and B/B B are one slot in the form.
    slots: q.sides.filter((x) => x.print_side !== 'B/B B').map((x) => ({ print_side: x.print_side, colours: x.colours })),
    notes,
  }
}

// What a scanned QR says differently from a planned job (only values the QR has).
function qrDifferences(q: QrJob, job: Job, machines: Machine[], papers: PaperType[], coatings: Coating[]): string[] {
  const out: string[] = []
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').toLowerCase().replace(/\s+/g, ' ').trim() === (b ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const diff = (label: string, qrValue: string | undefined, planValue: string | null | undefined) => {
    if (qrValue && !same(qrValue, planValue)) out.push(`${label}: QR ${qrValue}, plan ${planValue || '—'}`)
  }
  diff('Date', q.plan_date ? formatDate(q.plan_date) : undefined, formatDate(job.plan_date))
  diff('Machine', q.machine, machines.find((m) => m.id === job.machine_id)?.code)
  diff('CSO Number', q.cso_no, job.cso_no)
  diff('Job Name', q.job_name, job.job_name)
  diff('Category', q.category, job.category)
  diff('UPS', q.ups, String(job.ups))
  diff('Job Type', q.job_type, job.job_type)
  diff('Type of Paper', q.paper, papers.find((p) => p.id === job.paper_type_id)?.name)
  diff('Coating', q.coating, coatings.find((c) => c.id === job.coating_id)?.name)
  diff('Quantity', q.quantity, String(job.quantity))
  const planSides = sortedSides(job)
  for (const side of q.sides) {
    const plan = planSides.find((x) => x.print_side === side.print_side)
    if (side.print_side === 'B/B B' && planSides.some((x) => x.print_side === 'B/B F')) continue
    if (!plan) out.push(`Print side ${side.print_side}: in the QR, not in the plan`)
    else if (!same(side.colours.join(','), plan.colours.join(','))) out.push(`${side.print_side} colours: QR ${side.colours.join(', ') || '—'}, plan ${plan.colours.join(', ')}`)
  }
  return out
}
