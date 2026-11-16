import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, FileDown, FileSpreadsheet, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate, formatNumber, searchPattern, tidy } from '../lib/jobs'
import { formatMoment } from '../lib/production'
import { downloadExcel, downloadPdf } from '../lib/exports'
import type { ExportTable } from '../lib/exports'
import { RECORD_COLUMNS, lineTotals, wastageLabel } from '../lib/wastage'
import type { WastageRecord } from '../lib/wastage'
import { ConfirmDialog, Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

interface Line {
  line: number
  process: string
  defect: string
  reason: string | null
  quantity: number
  unit: 'cartons' | 'sheets'
}
type Row = WastageRecord & { wastage_lines: Line[] }

// Wastage Summary: every wastage record, with its lines.
export function WastageSummaryPage() {
  const { can } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [process, setProcess] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [viewing, setViewing] = useState<Row | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQuery(tidy(typed)), 300)
    return () => clearTimeout(t)
  }, [typed])

  const rangeError = from && to && from > to ? 'From Date cannot be after To Date.' : ''

  useEffect(() => {
    if (rangeError) return
    let alive = true
    let q = supabase
      .from('wastage_records')
      .select(`${RECORD_COLUMNS}, wastage_lines(line, process, defect, reason, quantity, unit)`)
      .order('created_at', { ascending: false })
      .limit(3000)
    if (from) q = q.gte('created_at', `${from}T00:00:00+05:30`)
    if (to) q = q.lte('created_at', `${to}T23:59:59+05:30`)
    if (query) q = q.or(`order_no.ilike.${searchPattern(query)},job_name.ilike.${searchPattern(query)}`)
    q.then(({ data, error }) => {
      if (!alive) return
      if (error) setLoadError(friendlyError(error))
      else {
        setRows(((data ?? []) as unknown as Row[]).map((r) => ({ ...r, wastage_lines: [...r.wastage_lines].sort((a, b) => a.line - b.line) })))
        setLoadError('')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [query, from, to, reload, rangeError])

  const filtered = useMemo(() => {
    const p = process.trim().toLowerCase()
    return p ? rows.filter((r) => r.wastage_lines.some((l) => l.process.toLowerCase().includes(p) || l.defect.toLowerCase().includes(p))) : rows
  }, [rows, process])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  const totals = useMemo(() => {
    let cartons = 0
    let sheets = 0
    for (const r of filtered) {
      const t = lineTotals(r.wastage_lines, r.ups)
      cartons += t.cartons
      sheets += t.sheets
    }
    return {
      records: filtered.length,
      orderQty: filtered.reduce((s, r) => s + r.order_qty, 0),
      packed: filtered.reduce((s, r) => s + r.packed_qty, 0),
      prodWaste: filtered.reduce((s, r) => s + r.production_wastage, 0),
      cartons,
      sheets,
    }
  }, [filtered])

  async function confirmDelete() {
    if (!deleting) return
    const label = wastageLabel(deleting.record_no)
    setBusy('delete')
    const { data, error } = await supabase.from('wastage_records').delete().eq('id', deleting.id).select('id')
    setBusy('')
    setDeleting(null)
    if (error) return notify('error', friendlyError(error, 'record'))
    if (!data?.length) return notify('error', 'Only an admin can delete wastage records.')
    notify('success', `${label} deleted.`)
    setReload((n) => n + 1)
  }

  const tables = (): ExportTable[] => [
    {
      name: 'Wastage Summary',
      headers: ['S.No', 'Wastage ID', 'Order No', 'Job Name', 'UPS', 'OK Sheets', 'Production Wastage (sheets)', 'Order Qty (cartons)',
        'Packed Qty (cartons)', 'Wastage (cartons)', 'Wastage (sheets)', 'Lines', 'Created By', 'Created', 'Remarks'],
      rows: filtered.map((r, i) => {
        const t = lineTotals(r.wastage_lines, r.ups)
        return [i + 1, wastageLabel(r.record_no), r.order_no, r.job_name, r.ups, r.ok_sheets, r.production_wastage, r.order_qty, r.packed_qty,
          t.cartons, t.sheets, r.wastage_lines.length, r.created_by_name, formatMoment(r.created_at), r.remarks]
      }),
    },
    {
      name: 'Wastage Lines',
      headers: ['Wastage ID', 'Order No', 'Line No', 'Function / Process', 'Defect', 'Reason / Defect', 'Wastage Qty', 'Unit'],
      rows: filtered.flatMap((r) =>
        r.wastage_lines.map((l) => [wastageLabel(r.record_no), r.order_no, l.line, l.process, l.defect, l.reason, l.quantity, l.unit]),
      ),
    },
  ]

  async function exportAs(kind: 'excel' | 'pdf') {
    setBusy(kind)
    try {
      const name = `Pragati Wastage Summary ${from || 'all'}_${to || 'today'}`
      if (kind === 'excel') await downloadExcel(name, tables())
      else await downloadPdf(name, 'Wastage Summary', `${formatDate(from) || 'All dates'} to ${formatDate(to) || 'today'}`, tables())
    } catch (err) {
      notify('error', `Could not create the file: ${(err as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  const headers = ['Wastage ID', 'Order No', 'Job Name', 'Prod. Wastage', 'Order / Packed', 'Wastage Lines', 'Last Updated', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Wastage Summary</h1>
          <p className="muted">All wastage records · open one to see its lines</p>
        </div>
        <div className="actions">
          {can('wastage', 'create') && (
            <button type="button" className="primary" onClick={() => navigate('/wastage/entry')}>
              <Plus size={18} /> New Wastage Entry
            </button>
          )}
          <button type="button" onClick={() => exportAs('excel')} disabled={!!busy || loading}>
            <FileSpreadsheet size={18} /> {busy === 'excel' ? 'Preparing…' : 'Excel'}
          </button>
          <button type="button" onClick={() => exportAs('pdf')} disabled={!!busy || loading}>
            <FileDown size={18} /> {busy === 'pdf' ? 'Preparing…' : 'PDF'}
          </button>
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
              placeholder="Search Order No or Job Name"
              aria-label="Search"
            />
          </label>
          <input
            className="plain-input"
            value={process}
            onChange={(e) => {
              setProcess(e.target.value)
              setPage(1)
            }}
            placeholder="Process or defect"
            aria-label="Process or defect"
          />
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From Date" />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To Date" />
          </label>
        </div>
        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}

        <div className="totals">
          <div>
            <span>Records</span>
            <b>{formatNumber(totals.records)}</b>
          </div>
          <div>
            <span>Order / Packed (cartons)</span>
            <b>
              {formatNumber(totals.orderQty)} / {formatNumber(totals.packed)}
            </b>
          </div>
          <div>
            <span>Production wastage (sheets)</span>
            <b>{formatNumber(totals.prodWaste)}</b>
          </div>
          <div>
            <span>Wastage lines: cartons / sheets</span>
            <b>
              {formatNumber(totals.cartons)} / {formatNumber(totals.sheets)}
            </b>
          </div>
        </div>

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
                    {rows.length ? 'No matching records.' : 'No wastage records yet.'}
                  </td>
                </tr>
              ) : (
                visible.map((r) => {
                  const t = lineTotals(r.wastage_lines, r.ups)
                  return (
                    <tr key={r.id} className="clickable" onClick={() => setViewing(r)}>
                      <td>
                        <b>{wastageLabel(r.record_no)}</b>
                      </td>
                      <td>{r.order_no}</td>
                      <td className="wrap job-cell">{r.job_name}</td>
                      <td className="num">
                        {formatNumber(r.production_wastage)}
                        <div className="muted small">sheets</div>
                      </td>
                      <td className="num">
                        {formatNumber(r.order_qty)} / {formatNumber(r.packed_qty)}
                        <div className="muted small">cartons</div>
                      </td>
                      <td>
                        {[t.cartons ? `${formatNumber(t.cartons)} cartons` : '', t.sheets ? `${formatNumber(t.sheets)} sheets` : ''].filter(Boolean).join(' · ') || '—'}
                        <div className="muted small">{r.wastage_lines.length} line{r.wastage_lines.length === 1 ? '' : 's'}</div>
                      </td>
                      <td>
                        {formatMoment(r.updated_at).split(' ')[0]}
                        <div className="muted small">
                          {formatMoment(r.updated_at).split(' ').slice(1).join(' ')} · {r.updated_by_name ?? r.created_by_name}
                        </div>
                      </td>
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="icon-button" title="View" aria-label={`View ${wastageLabel(r.record_no)}`} onClick={() => setViewing(r)}>
                          <Eye size={17} />
                        </button>
                        {can('wastage', 'edit') && (
                          <button type="button" className="icon-button" title="Edit" aria-label={`Edit ${wastageLabel(r.record_no)}`} onClick={() => navigate(`/wastage/entry?id=${r.id}`)}>
                            <Pencil size={17} />
                          </button>
                        )}
                        {can('wastage', 'delete') && (
                          <button type="button" className="icon-button danger-text" title="Delete" aria-label={`Delete ${wastageLabel(r.record_no)}`} onClick={() => setDeleting(r)}>
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
        <p className="muted small">Dates filter by when the record was created. Production wastage = given − OK − separate sheets.</p>
      </section>

      {viewing && (
        <Modal
          title={`${wastageLabel(viewing.record_no)} · Order ${viewing.order_no}`}
          onClose={() => setViewing(null)}
          width={860}
          footer={
            <>
              <button type="button" onClick={() => setViewing(null)}>
                Close
              </button>
              {can('wastage', 'edit') && (
                <button type="button" className="primary" onClick={() => navigate(`/wastage/entry?id=${viewing.id}`)}>
                  <Pencil size={16} /> Edit
                </button>
              )}
            </>
          }
        >
          <dl className="summary-list wide">
            <dt>Job Name</dt>
            <dd>{viewing.job_name}</dd>
            <dt>No. of UPS</dt>
            <dd>{viewing.ups ?? '—'}</dd>
            <dt>OK Sheets</dt>
            <dd>{formatNumber(viewing.ok_sheets)}</dd>
            <dt>Wastage during production</dt>
            <dd>{formatNumber(viewing.production_wastage)} sheets</dd>
            <dt>Order Qty / Packed Qty</dt>
            <dd>
              {formatNumber(viewing.order_qty)} / {formatNumber(viewing.packed_qty)} cartons
            </dd>
            {viewing.remarks && (
              <>
                <dt>Remarks</dt>
                <dd>{viewing.remarks}</dd>
              </>
            )}
            <dt>Saved</dt>
            <dd>
              {formatMoment(viewing.created_at)} by {viewing.created_by_name ?? '—'}
              {viewing.updated_at !== viewing.created_at && ` · changed ${formatMoment(viewing.updated_at)} by ${viewing.updated_by_name ?? '—'}`}
            </dd>
          </dl>
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  {['Line No', 'Function / Process', 'Defect', 'Reason / Defect', 'Wastage Qty', 'Unit'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {viewing.wastage_lines.map((l) => (
                  <tr key={l.line}>
                    <td className="num">{l.line}</td>
                    <td>{l.process}</td>
                    <td>{l.defect}</td>
                    <td>{l.reason}</td>
                    <td className="num">{formatNumber(l.quantity)}</td>
                    <td>{l.unit === 'cartons' ? 'Cartons' : 'Sheets'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${wastageLabel(deleting.record_no)}?`}
          message={`The wastage record of order ${deleting.order_no} and its ${deleting.wastage_lines.length} line(s) will be removed permanently. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          busy={busy === 'delete'}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  )
}
