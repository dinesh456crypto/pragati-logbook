import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Save } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate } from '../lib/jobs'
import { formatMoment } from '../lib/production'
import type { OrderOption } from '../lib/production'
import { RECORD_COLUMNS, formulaLabel, isStandardColour, sideText } from '../lib/ink'
import type { InkColour, InkRecord } from '../lib/ink'
import { OrderPicker } from '../components/OrderPicker'
import { useToast } from '../components/Toast'

interface PlanJob {
  id: string
  order_no: string
  job_name: string
  category: string | null
  plan_date: string
  paper_type: string | null
}

interface Row {
  colour: string
  sides: string[]
  formula: string
  status: 'plan' | 'new' | 'gone' // in the plan / added to the plan since / no longer in the plan
}

type SaveReply =
  | { ok: true; id: string; record_no: number; revision: number; updated_at: string; unchanged?: boolean }
  | { ok: false; code: 'INVALID'; errors: { message: string }[] }
  | { ok: false; code: 'STALE'; message: string }
  | { ok: false; code: 'EXISTS'; id: string; record_no: number; message: string }

// Ink Formula Entry: pick a planned order, enter a formula for each of its colours.
// ?id=<record> opens a saved record; ?order=<order no> starts from an order.
export function InkEntryPage() {
  const [params] = useSearchParams()
  const id = params.get('id')
  return <InkEditor key={id ?? 'new'} recordId={id} startOrder={params.get('order') ?? ''} />
}

function InkEditor({ recordId, startOrder }: { recordId: string | null; startOrder: string }) {
  const { can } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<PlanJob[]>([])
  const [live, setLive] = useState<Map<string, { id: string; record_no: number }>>(new Map())
  const [orderNo, setOrderNo] = useState('')
  const [job, setJob] = useState<PlanJob | null>(null)
  const [record, setRecord] = useState<InkRecord | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  // C, M, Y, K of the order: shown for information, no formula needed.
  const [standard, setStandard] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const editable = record ? can('ink_formula', 'edit') && !record.archived : can('ink_formula', 'create')

  useEffect(() => {
    Promise.all([
      supabase
        .from('production_jobs')
        .select('id, order_no, job_name, category, plan_date, paper_types(name)')
        .order('plan_date', { ascending: false }),
      supabase.from('ink_formula_records').select('id, record_no, order_key').eq('archived', false),
    ]).then(([j, r]) => {
      setJobs(
        ((j.data ?? []) as unknown as (Omit<PlanJob, 'paper_type'> & { paper_types: { name: string } | null })[]).map((x) => ({
          ...x,
          paper_type: x.paper_types?.name ?? null,
        })),
      )
      setLive(new Map(((r.data ?? []) as { id: string; record_no: number; order_key: string }[]).map((x) => [x.order_key, x])))
    })
  }, [])

  const options: OrderOption[] = useMemo(
    () =>
      jobs.map((j) => {
        const rec = live.get(j.order_no.trim().toLowerCase())
        return {
          order_no: j.order_no,
          job_name: j.job_name,
          plan_date: j.plan_date,
          planned: true,
          sides_used: [],
          sides_closed: [],
          note: rec ? `has formula ${formulaLabel(rec.record_no)}` : undefined,
        }
      }),
    [jobs, live],
  )

  // Loads a saved record, merged with the plan's colours as they are now.
  const openRecord = useCallback(
    async (id: string) => {
      setLoading(true)
      const [r, c] = await Promise.all([
        supabase.from('ink_formula_records').select(RECORD_COLUMNS).eq('id', id).maybeSingle(),
        supabase.from('ink_formula_colours').select('colour, sides, formula').eq('record_id', id).order('line'),
      ])
      if (r.error || !r.data) {
        setLoading(false)
        notify('error', r.error ? friendlyError(r.error) : 'This formula record was not found.')
        return
      }
      const rec = r.data as InkRecord
      const saved = (c.data ?? []) as InkColour[]
      let plan: { colour: string; sides: string[] }[] = []
      let std: string[] = []
      if (rec.job_id) {
        const p = await supabase.rpc('order_plan_colours', { p_job_id: rec.job_id })
        const all = (p.data ?? []) as { colour: string; sides: string[] }[]
        plan = all.filter((x) => !isStandardColour(x.colour))
        std = all.filter((x) => isStandardColour(x.colour)).map((x) => x.colour)
      }
      const planKeys = new Set(plan.map((x) => x.colour.toLowerCase()))
      const savedKeys = new Set(saved.map((x) => x.colour.toLowerCase()))
      setRecord(rec)
      setOrderNo(rec.order_no)
      setJob({
        id: rec.job_id ?? '',
        order_no: rec.order_no,
        job_name: rec.job_name ?? '',
        category: rec.category,
        plan_date: rec.plan_date ?? '',
        paper_type: rec.paper_type,
      })
      setStandard(std)
      setRows([
        ...saved.filter((x) => !isStandardColour(x.colour)).map((x) => ({
          colour: x.colour,
          sides: x.sides,
          formula: x.formula ?? '',
          status: (rec.job_id && !planKeys.has(x.colour.toLowerCase()) ? 'gone' : 'plan') as Row['status'],
        })),
        ...plan.filter((x) => !savedKeys.has(x.colour.toLowerCase())).map((x) => ({ ...x, formula: '', status: 'new' as const })),
      ])
      setNote('')
      setErrors([])
      setDirty(false)
      setLoading(false)
    },
    [notify],
  )

  async function chooseOrder(value: string) {
    setOrderNo(value)
    setErrors([])
    const j = jobs.find((x) => x.order_no.toLowerCase() === value.trim().toLowerCase())
    if (!j) {
      setJob(null)
      setRows([])
      setStandard([])
      setRecord(null)
      return
    }
    const rec = live.get(j.order_no.trim().toLowerCase())
    if (rec) {
      navigate(`/ink/entry?id=${rec.id}`, { replace: true })
      return
    }
    setLoading(true)
    const { data, error } = await supabase.rpc('order_plan_colours', { p_job_id: j.id })
    setLoading(false)
    if (error) return notify('error', friendlyError(error))
    const all = (data ?? []) as { colour: string; sides: string[] }[]
    setJob(j)
    setRecord(null)
    setStandard(all.filter((x) => isStandardColour(x.colour)).map((x) => x.colour))
    setRows(all.filter((x) => !isStandardColour(x.colour)).map((x) => ({ ...x, formula: '', status: 'plan' })))
    setDirty(false)
  }

  // Open a record, or start from an order in the address.
  useEffect(() => {
    if (recordId) openRecord(recordId)
  }, [recordId, openRecord])
  useEffect(() => {
    if (!recordId && startOrder && jobs.length) chooseOrder(startOrder)
    // Runs once the plan list has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.length])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function save() {
    if (!job) return
    setSaving(true)
    setErrors([])
    const { data, error } = await supabase.rpc('save_ink_formula', {
      p_id: record?.id ?? null,
      p_order_no: job.order_no,
      p_colours: rows.map((r) => ({ colour: r.colour, formula: r.formula })),
      p_note: note || null,
      p_expected_updated_at: record?.updated_at ?? null,
    })
    setSaving(false)
    if (error) return setErrors([friendlyError(error, 'formula')])
    const reply = data as SaveReply
    if (reply.ok) {
      setDirty(false)
      notify(
        'success',
        reply.unchanged
          ? 'Nothing changed, so no new revision was made.'
          : `Formula ${formulaLabel(reply.record_no)} saved (revision ${reply.revision}).`,
      )
      navigate(`/ink/summary/${reply.id}`)
      return
    }
    if (reply.code === 'INVALID') setErrors(reply.errors.map((e) => e.message))
    else if (reply.code === 'EXISTS') setErrors([reply.message])
    else setErrors([reply.message])
  }

  const filled = rows.filter((r) => r.formula.trim()).length

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{record ? `Ink Formula ${formulaLabel(record.record_no)}` : 'Ink Formula Entry'}</h1>
          <p className="muted">
            {record
              ? `Revision ${record.revision} · last changed ${formatMoment(record.updated_at)}${record.updated_by_name ? ` by ${record.updated_by_name}` : ''}`
              : 'Select an order from Production Plan, then enter the ink formula for each colour.'}
          </p>
        </div>
        {record && (
          <Link to={`/ink/summary/${record.id}`} className="button">
            View formula and history
          </Link>
        )}
      </div>

      <section className="card">
        <div className="form-grid">
          <label className="field span-2">
            <span>Order Number *</span>
            <OrderPicker
              value={orderNo}
              options={options}
              allowNew={false}
              disabled={Boolean(record) || saving}
              placeholder="Search by Order Number or Job Name"
              onSelect={chooseOrder}
            />
          </label>
          <div className="field">
            <span>Job Name</span>
            <p className="field-value">{job?.job_name || '—'}</p>
          </div>
          <div className="field">
            <span>Category</span>
            <p className="field-value">{job?.category || '—'}</p>
          </div>
          <div className="field">
            <span>Planned Date</span>
            <p className="field-value">{job?.plan_date ? formatDate(job.plan_date) : '—'}</p>
          </div>
          <div className="field">
            <span>Type of Paper</span>
            <p className="field-value">{job?.paper_type || '—'}</p>
          </div>
        </div>
        {record?.archived && <p className="notice warn">This record is archived. Restore it from the Job Summary to edit it.</p>}
      </section>

      {loading && <p className="page-status">Loading colours…</p>}

      {job && !loading && (
        <section className="card">
          <h2>Ink formula for each colour</h2>
          {standard.length > 0 && (
            <p className="notice info">
              Standard process colours <b>{standard.join(', ')}</b> need no formula, so they are not listed here.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="notice warn">
              {standard.length
                ? 'This order uses only the standard colours C, M, Y, K, so it needs no ink formula.'
                : 'This order has no colours in Production Plan. Add its colours under Job Details first.'}
            </p>
          ) : (
            <div className="ink-rows">
              {rows.map((r, i) => (
                <div key={r.colour} className={`ink-row ${r.status}`}>
                  <div className="ink-colour">
                    <span className="chip">{r.colour}</span>
                    <span className="muted small">{sideText(r.sides)}</span>
                    {r.status === 'new' && <span className="badge amber">New in plan</span>}
                    {r.status === 'gone' && <span className="badge grey">Not in plan any more</span>}
                  </div>
                  <label className="field">
                    <span className="sr-only">Formula for {r.colour}</span>
                    <textarea
                      rows={3}
                      maxLength={4000}
                      value={r.formula}
                      disabled={!editable}
                      placeholder={editable ? `Ink formula for ${r.colour}: components and proportions` : ''}
                      onChange={(e) => {
                        setRows((list) => list.map((x, j) => (j === i ? { ...x, formula: e.target.value } : x)))
                        setDirty(true)
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {record && editable && (
            <label className="field">
              <span>What changed (saved with this revision)</span>
              <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Shade too dark, reduced cyan" />
            </label>
          )}

          {errors.length > 0 && (
            <div className="notice error" role="alert">
              <ul className="error-list">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              {errors.some((e) => e.includes('already has ink formula')) && (
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    const rec = live.get(job.order_no.trim().toLowerCase())
                    if (rec) navigate(`/ink/entry?id=${rec.id}`)
                  }}
                >
                  Open the existing formula
                </button>
              )}
            </div>
          )}

          {editable && rows.length > 0 && (
            <div className="entry-footer">
              <span className="muted small">
                {filled} of {rows.length} colours have a formula.
                {record ? ' Saving keeps the previous version in the history.' : ''}
              </span>
              <button type="button" className="primary" onClick={save} disabled={saving || !dirty}>
                <Save size={17} /> {saving ? 'Saving…' : 'Save Formula'}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
