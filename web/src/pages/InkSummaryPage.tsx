import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, Eye, History, Pencil, Plus, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate, searchPattern, tidy } from '../lib/jobs'
import { formatMoment } from '../lib/production'
import { RECORD_COLUMNS, formulaLabel } from '../lib/ink'
import type { InkRecord } from '../lib/ink'
import { ConfirmDialog } from '../components/Modal'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

type Row = InkRecord & { ink_formula_colours: { colour: string; formula: string | null; line: number }[] }

// Ink Formula Job Summary: every saved formula record, searchable.
export function InkSummaryPage() {
  const { can } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [colour, setColour] = useState('')
  const [creator, setCreator] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [archived, setArchived] = useState(false)
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [pending, setPending] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setQuery(tidy(typed)), 300)
    return () => clearTimeout(t)
  }, [typed])

  const rangeError = from && to && from > to ? 'From Date cannot be after To Date.' : ''

  useEffect(() => {
    if (rangeError) return
    let alive = true
    let q = supabase
      .from('ink_formula_records')
      .select(`${RECORD_COLUMNS}, ink_formula_colours(colour, formula, line)`)
      .eq('archived', archived)
      .order('updated_at', { ascending: false })
      .limit(3000)
    if (from) q = q.gte('production_date', from)
    if (to) q = q.lte('production_date', to)
    if (query) q = q.or(`order_no.ilike.${searchPattern(query)},job_name.ilike.${searchPattern(query)}`)
    q.then(({ data, error }) => {
      if (!alive) return
      if (error) setLoadError(friendlyError(error))
      else {
        setRows((data ?? []) as unknown as Row[])
        setLoadError('')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [query, from, to, archived, reload, rangeError])

  const creators = useMemo(() => [...new Set(rows.map((r) => r.created_by_name).filter(Boolean))].sort() as string[], [rows])
  const filtered = useMemo(() => {
    const c = colour.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (!c || r.ink_formula_colours.some((x) => x.colour.toLowerCase().includes(c))) &&
        (!creator || r.created_by_name === creator),
    )
  }, [rows, colour, creator])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  async function confirmArchive() {
    if (!pending) return
    setBusy(true)
    const { data, error } = await supabase.rpc('archive_ink_formula', { p_id: pending.id, p_archived: !pending.archived })
    setBusy(false)
    const label = formulaLabel(pending.record_no)
    setPending(null)
    if (error) return notify('error', friendlyError(error, 'formula'))
    const reply = data as { ok: boolean; message?: string }
    if (!reply.ok) return notify('error', reply.message ?? 'Could not change the record.')
    notify('success', pending.archived ? `${label} restored.` : `${label} archived.`)
    setReload((n) => n + 1)
  }

  const headers = ['S.No', 'Formula ID', 'Production Order Number', 'Job Name', 'Date', 'Colours', 'Created By', 'Last Updated', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Ink Formula Job Summary</h1>
          <p className="muted">Saved ink formulas by order · each change is kept in the history</p>
        </div>
        {can('ink_formula', 'create') && (
          <button type="button" className="primary" onClick={() => navigate('/ink/entry')}>
            <Plus size={18} /> New Ink Formula
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
              placeholder="Search Production Order Number or Job Name"
              aria-label="Search"
            />
          </label>
          <input
            className="plain-input"
            value={colour}
            onChange={(e) => {
              setColour(e.target.value)
              setPage(1)
            }}
            placeholder="Colour (e.g. PMS 185)"
            aria-label="Colour"
          />
          <select value={creator} onChange={(e) => setCreator(e.target.value)} aria-label="Created by">
            <option value="">Created by anyone</option>
            {creators.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From Date" />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To Date" />
          </label>
          <select value={archived ? 'archived' : 'live'} onChange={(e) => setArchived(e.target.value === 'archived')} aria-label="Status">
            <option value="live">Current records</option>
            <option value="archived">Archived records</option>
          </select>
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
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    {rows.length ? 'No matching formulas.' : archived ? 'No archived formulas.' : 'No ink formulas yet.'}
                  </td>
                </tr>
              ) : (
                visible.map((r, i) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/ink/summary/${r.id}`)}>
                    <td>{(current - 1) * PAGE_SIZE + i + 1}</td>
                    <td>
                      <b>{formulaLabel(r.record_no)}</b>
                      <span className="muted small"> rev {r.revision}</span>
                    </td>
                    <td>{r.order_no}</td>
                    <td className="wrap">{r.job_name}</td>
                    <td>{formatDate(r.production_date)}</td>
                    <td className="wrap">
                      {[...r.ink_formula_colours]
                        .sort((a, b) => a.line - b.line)
                        .map((c) => c.colour)
                        .join(', ')}
                    </td>
                    <td>{r.created_by_name}</td>
                    <td>
                      {formatMoment(r.updated_at)}
                      {r.updated_by_name && <span className="sub muted small">{r.updated_by_name}</span>}
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="icon-button" title="View formula" aria-label={`View ${formulaLabel(r.record_no)}`} onClick={() => navigate(`/ink/summary/${r.id}`)}>
                        <Eye size={17} />
                      </button>
                      {can('ink_formula', 'edit') && !r.archived && (
                        <button type="button" className="icon-button" title="Edit formula" aria-label={`Edit ${formulaLabel(r.record_no)}`} onClick={() => navigate(`/ink/entry?id=${r.id}`)}>
                          <Pencil size={17} />
                        </button>
                      )}
                      <button type="button" className="icon-button" title="View history" aria-label={`History of ${formulaLabel(r.record_no)}`} onClick={() => navigate(`/ink/summary/${r.id}#history`)}>
                        <History size={17} />
                      </button>
                      {can('ink_formula', 'delete') && (
                        <button
                          type="button"
                          className="icon-button"
                          title={r.archived ? 'Restore' : 'Archive'}
                          aria-label={`${r.archived ? 'Restore' : 'Archive'} ${formulaLabel(r.record_no)}`}
                          onClick={() => setPending(r)}
                        >
                          {r.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}
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
            {filtered.length ? `Showing ${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, filtered.length)} of ${filtered.length}` : 'Showing 0 records'}
          </span>
          <div className="actions">
            <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </div>
        </div>
        <p className="muted small">Date is the order's last production date. Archived records stay readable and can be restored.</p>
      </section>

      {pending && (
        <ConfirmDialog
          title={`${pending.archived ? 'Restore' : 'Archive'} ${formulaLabel(pending.record_no)}?`}
          message={
            pending.archived
              ? `Production order ${pending.order_no} will use this formula again.`
              : `The formula for order ${pending.order_no} will move to Archived records. Its history is kept, and a new formula can then be started for the order.`
          }
          confirmLabel={pending.archived ? 'Restore' : 'Archive'}
          busy={busy}
          onConfirm={confirmArchive}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  )
}
