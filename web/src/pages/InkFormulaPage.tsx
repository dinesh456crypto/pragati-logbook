import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, FileDown, Pencil, Printer } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate } from '../lib/jobs'
import { formatMoment } from '../lib/production'
import { downloadPdf } from '../lib/exports'
import { RECORD_COLUMNS, formulaLabel, sideText } from '../lib/ink'
import type { InkColour, InkRecord, InkRevision } from '../lib/ink'
import { useToast } from '../components/Toast'
import { PhotoGallery } from '../components/InkPhotos'
import { loadInkPhotos } from '../lib/inkPhotos'
import type { InkPhoto } from '../lib/inkPhotos'

// Formula detail: job details, the formula sheet, and the revision history.
export function InkFormulaPage() {
  const { id = '' } = useParams()
  const { hash } = useLocation()
  const { can } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const [record, setRecord] = useState<InkRecord | null>(null)
  const [colours, setColours] = useState<InkColour[]>([])
  const [revisions, setRevisions] = useState<InkRevision[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [photos, setPhotos] = useState<InkPhoto[]>([])
  const [photoError, setPhotoError] = useState('')

  useEffect(() => {
    let alive = true
    Promise.all([
      supabase.from('ink_formula_records').select(RECORD_COLUMNS).eq('id', id).maybeSingle(),
      supabase.from('ink_formula_colours').select('colour, sides, formula').eq('record_id', id).order('line'),
      supabase
        .from('ink_formula_revisions')
        .select('id, revision, colours, note, changed_by_name, changed_at')
        .eq('record_id', id)
        .order('revision', { ascending: false }),
    ]).then(([r, c, h]) => {
      if (!alive) return
      setLoading(false)
      if (r.error || !r.data) return setError(r.error ? friendlyError(r.error) : 'This formula record was not found.')
      setRecord(r.data as InkRecord)
      setColours((c.data ?? []) as InkColour[])
      setRevisions((h.data ?? []) as InkRevision[])
    })
    loadInkPhotos(id)
      .then((list) => alive && setPhotos(list))
      .catch((err: Error) => alive && setPhotoError(`Could not load the photos: ${err.message}`))
    return () => {
      alive = false
    }
  }, [id])

  useEffect(() => {
    if (hash === '#history' && revisions.length) document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })
  }, [hash, revisions.length])

  if (loading) return <p className="page-status">Loading…</p>
  if (error || !record) {
    return (
      <section className="card">
        <p className="notice error">{error}</p>
        <Link to="/ink/summary" className="button">
          Back to the summary
        </Link>
      </section>
    )
  }

  async function pdf() {
    if (!record) return
    try {
      await downloadPdf(
        `${formulaLabel(record.record_no)} ${record.order_no}`.replace(/[^\w .-]/g, ''),
        `Ink Formula ${formulaLabel(record.record_no)} · Production Order ${record.order_no}`,
        `${record.job_name ?? ''} · ${record.category ?? ''} · Paper ${record.paper_type ?? '—'} · Last production ${formatDate(record.production_date) || '—'} · Revision ${record.revision} · ${formatMoment(record.updated_at)}`,
        [{ name: 'Formula', headers: ['Colour', 'Print sides', 'Ink formula'], rows: colours.map((c) => [c.colour, sideText(c.sides), c.formula ?? '']) }],
      )
    } catch (err) {
      notify('error', `Could not create the PDF: ${(err as Error).message}`)
    }
  }

  return (
    <>
      <div className="pagehead">
        <div>
          <Link to="/ink/summary" className="back-link no-print">
            <ArrowLeft size={16} /> Ink Formula Job Summary
          </Link>
          <h1>
            Ink Formula {formulaLabel(record.record_no)} {record.archived && <span className="badge grey">Archived</span>}
          </h1>
          <p className="muted">
            Revision {record.revision} · created {formatMoment(record.created_at)}
            {record.created_by_name ? ` by ${record.created_by_name}` : ''} · last changed {formatMoment(record.updated_at)}
            {record.updated_by_name ? ` by ${record.updated_by_name}` : ''}
          </p>
        </div>
        <div className="actions no-print">
          {can('ink_formula', 'edit') && !record.archived && (
            <button type="button" className="primary" onClick={() => navigate(`/ink/entry?id=${record.id}`)}>
              <Pencil size={17} /> Edit Formula
            </button>
          )}
          <button type="button" onClick={pdf}>
            <FileDown size={17} /> PDF
          </button>
          <button type="button" onClick={() => window.print()}>
            <Printer size={17} /> Print
          </button>
        </div>
      </div>

      <section className="card">
        <h2>Job Details</h2>
        <dl className="summary-list wide">
          <dt>Production Order Number</dt>
          <dd>{record.order_no}</dd>
          <dt>Job Name</dt>
          <dd>{record.job_name || '—'}</dd>
          <dt>Category</dt>
          <dd>{record.category || '—'}</dd>
          <dt>Last Production Date</dt>
          <dd>{formatDate(record.production_date) || '—'}</dd>
          {record.plan_date && (
            <>
              <dt>Production Plan Date</dt>
              <dd>{formatDate(record.plan_date)}</dd>
            </>
          )}
          <dt>Type of Paper</dt>
          <dd>{record.paper_type || '—'}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Ink Formula Details</h2>
        <div className="tablewrap">
          <table className="formula-table">
            <thead>
              <tr>
                <th>Colour</th>
                <th>Print sides</th>
                <th>Formula</th>
              </tr>
            </thead>
            <tbody>
              {colours.map((c) => (
                <tr key={c.colour}>
                  <td>
                    <span className="chip">{c.colour}</span>
                  </td>
                  <td>{sideText(c.sides)}</td>
                  <td className="formula-text">{c.formula || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Job Sample Photos</h2>
        {photoError ? (
          <p className="notice error">{photoError}</p>
        ) : photos.length === 0 ? (
          <p className="muted">
            No photos yet.{can('ink_formula', 'edit') && !record.archived ? ' Use Edit Formula to add a photo of the job sample.' : ''}
          </p>
        ) : (
          <PhotoGallery photos={photos} />
        )}
      </section>

      <section className="card no-print" id="history">
        <h2>History</h2>
        {revisions.length === 0 ? (
          <p className="empty">No history.</p>
        ) : (
          <ol className="history">
            {revisions.map((rev, i) => {
              const older = revisions[i + 1]
              const before = new Map((older?.colours ?? []).map((c) => [c.colour.toLowerCase(), c.formula ?? '']))
              return (
                <li key={rev.id}>
                  <div className="history-head">
                    <b>Revision {rev.revision}</b>
                    {i === 0 && <span className="badge green">Current</span>}
                    <span className="muted small">
                      {formatMoment(rev.changed_at)}
                      {rev.changed_by_name ? ` · ${rev.changed_by_name}` : ''}
                    </span>
                  </div>
                  {rev.note && <p className="history-note">“{rev.note}”</p>}
                  <table className="compact formula-table">
                    <tbody>
                      {rev.colours.map((c) => {
                        const changed = older && (before.get(c.colour.toLowerCase()) ?? null) !== (c.formula ?? '')
                        return (
                          <tr key={c.colour} className={changed ? 'changed' : ''}>
                            <td>
                              <span className="chip">{c.colour}</span>
                            </td>
                            <td className="formula-text">
                              {c.formula || <span className="muted">—</span>}
                              {changed && <span className="badge amber small-badge">Changed</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </>
  )
}
