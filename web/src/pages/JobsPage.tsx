import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Eye, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { plantDate } from '../lib/dates'
import { friendlyError } from '../lib/errors'
import { JOB_COLUMNS, JOB_TYPES, MAX_COLOURS, cleanColours, formatDate, formatNumber, searchPattern, tidy } from '../lib/jobs'
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

  const headers = ['S.No', 'Date', 'Order No', 'Job Name', 'Category', 'UPS', 'Job Type', 'Paper Type', 'Qty (Sheets)', '']

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

const padColours = (list: string[]) => Array.from({ length: MAX_COLOURS }, (_, i) => list[i] ?? '')

function JobForm({ job, readOnly, canEdit, papers, onEdit, onClose, onSaved }: FormProps) {
  const [date, setDate] = useState(job?.plan_date ?? plantDate())
  const [orderNo, setOrderNo] = useState(job?.order_no ?? '')
  const [jobName, setJobName] = useState(job?.job_name ?? '')
  const [category, setCategory] = useState(job?.category ?? '')
  const [ups, setUps] = useState(job ? String(job.ups) : '')
  const [jobType, setJobType] = useState<string>(job?.job_type ?? '')
  const [paperId, setPaperId] = useState(job?.paper_type_id ?? '')
  const [quantity, setQuantity] = useState(job ? String(job.quantity) : '')
  const [colours, setColours] = useState(() => padColours(job?.colours ?? []))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const { repeated } = useMemo(() => cleanColours(colours), [colours])
  const repeatedKeys = useMemo(() => new Set(repeated.map((c) => c.toLowerCase())), [repeated])
  // Active paper types, plus the job's own paper type even if it was made inactive later.
  const paperOptions = useMemo(
    () => papers.filter((p) => p.active || p.id === job?.paper_type_id),
    [papers, job?.paper_type_id],
  )

  const setColour = useCallback((index: number, value: string) => {
    setColours((list) => list.map((c, i) => (i === index ? value : c)))
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
      colours: cleanColours(colours).colours,
    }
    if (!values.plan_date) return setError('Date is required.')
    if (!values.order_no) return setError('Order Number is required.')
    if (!values.job_name) return setError('Job Name is required.')
    if (!ups.trim() || !Number.isInteger(values.ups) || values.ups <= 0) return setError('UPS must be a whole number above zero.')
    if (!values.job_type) return setError('Select a Job Type.')
    if (!values.paper_type_id) return setError('Select a Type of Paper.')
    if (!quantity.trim() || !Number.isInteger(values.quantity) || values.quantity <= 0) {
      return setError('Quantity must be a whole number of sheets above zero.')
    }

    setBusy(true)
    setError('')
    const result = job
      ? await supabase.from('production_jobs').update(values).eq('id', job.id).select('id')
      : await supabase.from('production_jobs').insert(values).select('id')
    setBusy(false)
    if (result.error) {
      return setError(
        result.error.code === '23505'
          ? `Order Number ${values.order_no} already exists. Each order can be planned only once.`
          : friendlyError(result.error, 'job'),
      )
    }
    if (!result.data?.length) return setError('You do not have permission to do this.')
    onSaved(values.order_no, !job)
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

        <fieldset className="colour-set">
          <legend>Colours (up to 9, e.g. C, M, Y, K, PMS 185, Varnish; leave unused boxes empty)</legend>
          <div className="colour-grid">
            {colours.map((c, i) => (
              <label key={i} className={`field ${repeatedKeys.has(tidy(c).toLowerCase()) && tidy(c) ? 'dup' : ''}`}>
                <span>Colour {i + 1}</span>
                <input
                  value={c}
                  onChange={(e) => setColour(i, e.target.value)}
                  maxLength={40}
                  disabled={readOnly}
                />
              </label>
            ))}
          </div>
          {repeated.length > 0 && !readOnly && (
            <p className="notice warn">
              Entered more than once: <b>{repeated.join(', ')}</b>. Each colour will be saved only once.
            </p>
          )}
        </fieldset>

        {job && (
          <p className="muted small">
            Created {new Date(job.created_at).toLocaleString('en-IN')} · Last modified {new Date(job.updated_at).toLocaleString('en-IN')}
          </p>
        )}
        {error && <p className="notice error">{error}</p>}
      </form>
    </Modal>
  )
}
