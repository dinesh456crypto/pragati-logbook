import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Save } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate } from '../lib/jobs'
import { colourKey, formatMoment } from '../lib/production'
import type { OrderOption } from '../lib/production'
import { RECORD_COLUMNS, formulaLabel, isStandardColour, sideText } from '../lib/ink'
import type { InkColour, InkRecord } from '../lib/ink'
import { OrderPicker } from '../components/OrderPicker'
import { PhotoGallery, PhotoPicker } from '../components/InkPhotos'
import { ConfirmDialog } from '../components/Modal'
import { loadInkPhotos, removeInkPhoto, uploadInkPhoto } from '../lib/inkPhotos'
import type { InkPhoto } from '../lib/inkPhotos'
import { useToast } from '../components/Toast'

interface PlanJob {
  id: string
  order_no: string
  cso_no?: string | null
  job_name: string
  category: string | null
  plan_date: string
  paper_type: string | null
}

// What ink_order_options returns: orders with a formula record, or still needing one.
interface InkOrder {
  job_id: string
  order_no: string
  cso_no: string | null
  job_name: string
  category: string | null
  plan_date: string
  paper_type: string | null
  record_id: string | null
  record_no: number | null
}

// A plan colour as order_plan_colours returns it. "known": the formula already saved for
// this colour with the same paper type and category on an earlier order.
interface PlanColour {
  colour: string
  sides: string[]
  standard?: boolean
  known: { record_id: string; record_no: number; order_no: string; formula: string } | null
}
type KnownRow = { colour: string; sides: string[] } & NonNullable<PlanColour['known']>
const knownRows = (all: PlanColour[]): KnownRow[] =>
  all.filter((x) => x.known && !isStandardColour(x.colour)).map((x) => ({ colour: x.colour, sides: x.sides, ...x.known! }))

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
  // Colours whose formula is already known from an earlier order: shown, not asked again.
  const [known, setKnown] = useState<KnownRow[]>([])
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  // Job sample photos: saved ones, and new ones uploaded when the formula is saved.
  const [photos, setPhotos] = useState<InkPhoto[]>([])
  const [newPhotos, setNewPhotos] = useState<File[]>([])
  const [removing, setRemoving] = useState<InkPhoto | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  const editable = record ? can('ink_formula', 'edit') && !record.archived : can('ink_formula', 'create')

  // Only orders that have a formula record or still need a formula are offered.
  useEffect(() => {
    supabase.rpc('ink_order_options').then(({ data, error }) => {
      if (error) return notify('error', friendlyError(error))
      const list = (data ?? []) as InkOrder[]
      setJobs(
        list.map((x) => ({
          id: x.job_id,
          order_no: x.order_no,
          cso_no: x.cso_no,
          job_name: x.job_name,
          category: x.category,
          plan_date: x.plan_date,
          paper_type: x.paper_type,
        })),
      )
      setLive(
        new Map(
          list
            .filter((x) => x.record_id)
            .map((x) => [x.order_no.trim().toLowerCase(), { id: x.record_id!, record_no: x.record_no! }]),
        ),
      )
    })
  }, [notify])

  const options: OrderOption[] = useMemo(
    () =>
      jobs.map((j) => {
        const rec = live.get(j.order_no.trim().toLowerCase())
        return {
          order_no: j.order_no,
          cso_no: j.cso_no,
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
      let plan: PlanColour[] = []
      let std: string[] = []
      let knownList: KnownRow[] = []
      if (rec.job_id) {
        // Only formulas saved before this record was made count as "already known".
        const p = await supabase.rpc('order_plan_colours', { p_job_id: rec.job_id, p_before: rec.created_at })
        const all = (p.data ?? []) as PlanColour[]
        knownList = knownRows(all)
        plan = all.filter((x) => !isStandardColour(x.colour) && !x.known)
        std = all.filter((x) => isStandardColour(x.colour)).map((x) => x.colour)
      }
      const knownKeys = new Set(knownList.map((x) => colourKey(x.colour)))
      const planKeys = new Set(plan.map((x) => colourKey(x.colour)))
      const savedKeys = new Set(saved.map((x) => colourKey(x.colour)))
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
      setKnown(knownList)
      setRows([
        ...saved
          .filter((x) => !isStandardColour(x.colour) && !knownKeys.has(colourKey(x.colour)))
          .map((x) => ({
            colour: x.colour,
            sides: x.sides,
            formula: x.formula ?? '',
            status: (rec.job_id && !planKeys.has(colourKey(x.colour)) ? 'gone' : 'plan') as Row['status'],
          })),
        ...plan
          .filter((x) => !savedKeys.has(colourKey(x.colour)))
          .map((x) => ({ colour: x.colour, sides: x.sides, formula: '', status: 'new' as const })),
      ])
      setNote('')
      setErrors([])
      setDirty(false)
      setNewPhotos([])
      setLoading(false)
      try {
        setPhotos(await loadInkPhotos(rec.id))
      } catch (err) {
        notify('error', `Could not load the photos: ${(err as Error).message}`)
      }
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
      setKnown([])
      setRecord(null)
      setPhotos([])
      setNewPhotos([])
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
    const all = (data ?? []) as PlanColour[]
    setJob(j)
    setRecord(null)
    setPhotos([])
    setNewPhotos([])
    setStandard(all.filter((x) => isStandardColour(x.colour)).map((x) => x.colour))
    setKnown(knownRows(all))
    setRows(
      all
        .filter((x) => !isStandardColour(x.colour) && !x.known)
        .map((x) => ({ colour: x.colour, sides: x.sides, formula: '', status: 'plan' as const })),
    )
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
      // Photos are uploaded after the formula is saved, tagged with its revision.
      let added = 0
      const failed: string[] = []
      if (newPhotos.length) {
        setSaving(true)
        for (const file of newPhotos) {
          try {
            await uploadInkPhoto(reply.id, file)
            added++
          } catch (err) {
            failed.push((err as Error).message)
          }
        }
        setSaving(false)
      }
      setDirty(false)
      setNewPhotos([])
      const photoText = added ? ` ${added} photo${added > 1 ? 's' : ''} added.` : ''
      notify(
        'success',
        reply.unchanged
          ? added
            ? `Formula unchanged (revision ${reply.revision}).${photoText}`
            : 'Nothing changed, so no new revision was made.'
          : `Formula ${formulaLabel(reply.record_no)} saved (revision ${reply.revision}).${photoText}`,
      )
      if (failed.length) {
        notify('error', `${failed.length} photo${failed.length > 1 ? 's were' : ' was'} not uploaded: ${failed[0]} Open the formula and add ${failed.length > 1 ? 'them' : 'it'} again.`)
      }
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
              : 'Select a production order from Production Plan, then enter the ink formula for each new colour.'}
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
            <span>Production Order Number *</span>
            <OrderPicker
              value={orderNo}
              options={options}
              allowNew={false}
              disabled={Boolean(record) || saving}
              placeholder="Search by Production Order, CSO or Job Name"
              onSelect={chooseOrder}
            />
          </label>
          <div className="field">
            <span>CSO Number</span>
            <p className="field-value">{(job && jobs.find((x) => x.id === job.id)?.cso_no) || '—'}</p>
          </div>
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
          {known.length > 0 && (
            <div className="known-formulas">
              <p className="smallcaps">Already known: same colour, paper type and category</p>
              {known.map((k) => (
                <div key={k.colour} className="ink-row known">
                  <div className="ink-colour">
                    <span className="chip">{k.colour}</span>
                    <span className="muted small">{sideText(k.sides)}</span>
                    <span className="badge green">Formula known</span>
                  </div>
                  <div className="field">
                    <p className="field-value known-formula">{k.formula}</p>
                    <span className="muted small">
                      From{' '}
                      <Link to={`/ink/summary/${k.record_id}`}>
                        {formulaLabel(k.record_no)} · production order {k.order_no}
                      </Link>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {rows.length === 0 ? (
            <p className="notice warn">
              {known.length
                ? 'Every colour of this production order already has a formula (or is C, M, Y, K), so no new formula is needed.'
                : standard.length
                  ? 'This production order uses only the standard colours C, M, Y, K, so it needs no ink formula.'
                  : 'This production order has no colours in Production Plan. Add its colours under Job Details first.'}
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

          {(editable ? rows.length > 0 : photos.length > 0) && (
            <div className="ink-photos">
              <h3>Job sample photos</h3>
              <p className="muted small">
                {editable
                  ? 'Take a photo of the printed sample (or choose one from the phone) for future reference. New photos are uploaded when you save.'
                  : 'Photos of the printed sample.'}
              </p>
              {photos.length > 0 && (
                <PhotoGallery photos={photos} onRemove={editable && record && can('ink_formula', 'edit') ? setRemoving : undefined} />
              )}
              <PhotoPicker
                files={newPhotos}
                disabled={!editable || saving}
                onChange={(files) => {
                  setNewPhotos(files)
                  setDirty(true)
                }}
              />
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
                {newPhotos.length ? ` ${newPhotos.length} new photo${newPhotos.length > 1 ? 's' : ''} to upload.` : ''}
                {record ? ' Saving keeps the previous version in the history.' : ''}
              </span>
              <button type="button" className="primary" onClick={save} disabled={saving || !dirty}>
                <Save size={17} /> {saving ? (newPhotos.length ? 'Saving and uploading photos…' : 'Saving…') : 'Save Formula'}
              </button>
            </div>
          )}
        </section>
      )}

      {removing && (
        <ConfirmDialog
          title="Remove this photo?"
          message={`The photo added with revision ${removing.revision} on ${formatMoment(removing.uploaded_at)} will be deleted for everyone.`}
          confirmLabel="Remove photo"
          danger
          busy={removeBusy}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            setRemoveBusy(true)
            try {
              await removeInkPhoto(removing.id)
              setPhotos((list) => list.filter((p) => p.id !== removing.id))
              notify('success', 'Photo removed.')
            } catch (err) {
              notify('error', (err as Error).message)
            }
            setRemoveBusy(false)
            setRemoving(null)
          }}
        />
      )}
    </>
  )
}
