import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Save, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate, formatNumber } from '../lib/jobs'
import { formatMoment } from '../lib/production'
import type { OrderOption } from '../lib/production'
import { RECORD_COLUMNS, UNITS, emptyLine, lineTotals, unitLabel, wastageLabel } from '../lib/wastage'
import type { ProductionTotals, Unit, WastageLine, WastageRecord } from '../lib/wastage'
import { OrderPicker } from '../components/OrderPicker'
import { useToast } from '../components/Toast'

interface OrderRow {
  order_no: string
  job_name: string | null
  last_production_date: string | null
  record_id: string | null
  record_no: number | null
}

type SaveReply =
  | { ok: true; id: string; record_no: number; updated_at: string }
  | { ok: false; code: 'INVALID'; errors: { message: string }[] }
  | { ok: false; code: 'STALE' | 'EXISTS'; message: string; id?: string }

const digits = (v: string) => v.replace(/[^0-9]/g, '')

// Wastage Entry: an order with submitted production → its production figures,
// order and packed quantities, and the wastage lines. ?id= opens a saved record.
export function WastageEntryPage() {
  const [params] = useSearchParams()
  const id = params.get('id')
  return <WastageEditor key={id ?? 'new'} recordId={id} />
}

function WastageEditor({ recordId }: { recordId: string | null }) {
  const { can } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [orderNo, setOrderNo] = useState('')
  const [totals, setTotals] = useState<ProductionTotals | null>(null)
  const [record, setRecord] = useState<WastageRecord | null>(null)
  const [orderQty, setOrderQty] = useState('')
  const [packedQty, setPackedQty] = useState('')
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<WastageLine[]>([emptyLine()])
  const [suggest, setSuggest] = useState<{ process: string[]; defect: string[]; reason: string[] }>({ process: [], defect: [], reason: [] })
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const editable = record ? can('wastage', 'edit') : can('wastage', 'create')

  useEffect(() => {
    supabase.rpc('wastage_order_options').then(({ data }) => setOrders((data ?? []) as OrderRow[]))
    // Earlier entries, offered as suggestions while typing.
    supabase
      .from('wastage_lines')
      .select('process, defect, reason')
      .limit(2000)
      .then(({ data }) => {
        const rows = (data ?? []) as { process: string; defect: string; reason: string | null }[]
        const uniq = (list: (string | null)[]) => [...new Set(list.filter(Boolean) as string[])].sort().slice(0, 200)
        setSuggest({ process: uniq(rows.map((r) => r.process)), defect: uniq(rows.map((r) => r.defect)), reason: uniq(rows.map((r) => r.reason)) })
      })
  }, [])

  const options: OrderOption[] = useMemo(
    () =>
      orders.map((o) => ({
        order_no: o.order_no,
        job_name: o.job_name,
        plan_date: null,
        planned: true,
        sides_used: [],
        sides_closed: [],
        note: [
          o.last_production_date ? `last produced ${formatDate(o.last_production_date)}` : '',
          o.record_no ? `has wastage record ${wastageLabel(o.record_no)}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [orders],
  )

  const loadTotals = useCallback(async (order: string) => {
    const { data, error } = await supabase.rpc('order_production_totals', { p_order_no: order })
    if (error) throw error
    return data as ProductionTotals | null
  }, [])

  const openRecord = useCallback(
    async (id: string) => {
      setLoading(true)
      const [r, l] = await Promise.all([
        supabase.from('wastage_records').select(RECORD_COLUMNS).eq('id', id).maybeSingle(),
        supabase.from('wastage_lines').select('line, process, defect, reason, quantity, unit').eq('record_id', id).order('line'),
      ])
      if (r.error || !r.data) {
        setLoading(false)
        notify('error', r.error ? friendlyError(r.error) : 'This wastage record was not found.')
        return
      }
      const rec = r.data as WastageRecord
      setRecord(rec)
      setOrderNo(rec.order_no)
      setOrderQty(String(rec.order_qty))
      setPackedQty(String(rec.packed_qty))
      setRemarks(rec.remarks ?? '')
      const saved = (l.data ?? []) as { line: number; process: string; defect: string; reason: string | null; quantity: number; unit: Unit }[]
      setLines(saved.length ? saved.map((x) => ({ ...x, reason: x.reason ?? '', quantity: String(x.quantity) })) : [emptyLine()])
      try {
        setTotals(await loadTotals(rec.order_no))
      } catch {
        setTotals(null)
      }
      setDirty(false)
      setLoading(false)
    },
    [loadTotals, notify],
  )

  useEffect(() => {
    if (recordId) openRecord(recordId)
  }, [recordId, openRecord])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function chooseOrder(value: string) {
    setOrderNo(value)
    setErrors([])
    const o = orders.find((x) => x.order_no.toLowerCase() === value.trim().toLowerCase())
    if (!o) {
      setTotals(null)
      return
    }
    if (o.record_id) {
      navigate(`/wastage/entry?id=${o.record_id}`, { replace: true })
      return
    }
    setLoading(true)
    try {
      setTotals(await loadTotals(o.order_no))
    } catch (err) {
      notify('error', friendlyError(err))
    }
    setLoading(false)
  }

  function setLine(i: number, patch: Partial<WastageLine>) {
    setLines((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    setErrors([])
    const { data, error } = await supabase.rpc('save_wastage_record', {
      p_id: record?.id ?? null,
      p_order_no: record?.order_no ?? totals?.order_no ?? orderNo,
      p_record: { order_qty: orderQty, packed_qty: packedQty, remarks },
      p_lines: lines.map((l) => ({ ...l, quantity: l.quantity === '' ? null : Number(l.quantity) })),
      p_expected_updated_at: record?.updated_at ?? null,
    })
    setSaving(false)
    if (error) return setErrors([friendlyError(error, 'wastage record')])
    const reply = data as SaveReply
    if (reply.ok) {
      setDirty(false)
      notify('success', `Wastage record ${wastageLabel(reply.record_no)} saved.`)
      navigate('/wastage/summary')
      return
    }
    setErrors(reply.code === 'INVALID' ? reply.errors.map((e) => e.message) : [reply.message])
  }

  const ups = record?.ups ?? totals?.ups ?? null
  const sum = lineTotals(lines, ups)
  const figures = totals ?? record
  const changedSinceSave =
    record && totals && (totals.ok_sheets !== record.ok_sheets || totals.production_wastage !== record.production_wastage)

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{record ? `Wastage Record ${wastageLabel(record.record_no)}` : 'Wastage Entry'}</h1>
          <p className="muted">
            {record
              ? `Created ${formatMoment(record.created_at)}${record.created_by_name ? ` by ${record.created_by_name}` : ''} · last changed ${formatMoment(record.updated_at)}${record.updated_by_name ? ` by ${record.updated_by_name}` : ''}`
              : 'Select a production order that has finished production (submitted entries), then enter the quantities and wastage.'}
          </p>
        </div>
        <Link to="/wastage/summary" className="button">
          Wastage Summary
        </Link>
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
              placeholder="Search production orders with production entries"
              onSelect={chooseOrder}
            />
          </label>
          <div className="field span-2">
            <span>Job Name</span>
            <p className="field-value">{figures?.job_name || '—'}</p>
          </div>
          <div className="field">
            <span>No. of UPS</span>
            <p className="field-value">{ups ?? '—'}</p>
          </div>
          <div className="field">
            <span>OK Sheets</span>
            <p className="field-value">{figures ? formatNumber(figures.ok_sheets) : '—'}</p>
          </div>
          <div className="field">
            <span>Wastage Sheets during Production</span>
            <p className="field-value">{figures ? formatNumber(figures.production_wastage) : '—'}</p>
          </div>
          <div className="field">
            <span>Given Sheets</span>
            <p className="field-value">{figures ? formatNumber(figures.given_sheets) : '—'}</p>
          </div>
        </div>
        {figures && (
          <p className="muted small">
            Wastage during production = Given sheets − OK sheets − Separate sheets, from {formatNumber(totals?.entries ?? record?.production_entries ?? 0)} submitted
            production {(totals?.entries ?? record?.production_entries) === 1 ? 'entry' : 'entries'}.
          </p>
        )}
        {totals && totals.sides.length > 1 && (
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  {['Print side', 'Entries', 'Given', 'OK', 'Separate', 'Wastage'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {totals.sides.map((s) => (
                  <tr key={s.side}>
                    <td>{s.side}</td>
                    <td className="num">{s.entries}</td>
                    <td className="num">{formatNumber(s.given)}</td>
                    <td className="num">{formatNumber(s.ok)}</td>
                    <td className="num">{formatNumber(s.separate)}</td>
                    <td className="num">{formatNumber(s.wastage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {changedSinceSave && (
          <p className="notice info">Production figures changed since this record was saved. Saving updates them to the figures shown.</p>
        )}
      </section>

      {loading && <p className="page-status">Loading…</p>}

      {(totals || record) && !loading && (
        <section className="card">
          <div className="form-grid">
            <label className="field">
              <span>Order Qty (Pcs) *</span>
              <input inputMode="numeric" value={orderQty} disabled={!editable} maxLength={9} onChange={(e) => (setOrderQty(digits(e.target.value)), setDirty(true))} />
            </label>
            <label className="field">
              <span>Packed Qty (Pcs) *</span>
              <input inputMode="numeric" value={packedQty} disabled={!editable} maxLength={9} onChange={(e) => (setPackedQty(digits(e.target.value)), setDirty(true))} />
            </label>
          </div>

          <h2 className="section-title">Wastage</h2>
          <div className="tablewrap">
            <table className="lines-table">
              <thead>
                <tr>
                  <th>Line No</th>
                  <th>Function / Process *</th>
                  <th>Defect *</th>
                  <th>Reason / Defect</th>
                  <th>Wastage Qty *</th>
                  <th>Unit *</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="num" data-label="Line No">{i + 1}</td>
                    <td data-label="Function / Process *">
                      <input list="w-process" value={l.process} maxLength={80} disabled={!editable} aria-label={`Line ${i + 1} function or process`} onChange={(e) => setLine(i, { process: e.target.value })} />
                    </td>
                    <td data-label="Defect *">
                      <input list="w-defect" value={l.defect} maxLength={120} disabled={!editable} aria-label={`Line ${i + 1} defect`} onChange={(e) => setLine(i, { defect: e.target.value })} />
                    </td>
                    <td data-label="Reason / Defect">
                      <input list="w-reason" value={l.reason} maxLength={200} disabled={!editable} aria-label={`Line ${i + 1} reason`} onChange={(e) => setLine(i, { reason: e.target.value })} />
                    </td>
                    <td data-label="Wastage Qty *">
                      <input inputMode="numeric" className="qty" value={l.quantity} maxLength={9} disabled={!editable} aria-label={`Line ${i + 1} wastage quantity`} onChange={(e) => setLine(i, { quantity: digits(e.target.value) })} />
                    </td>
                    <td data-label="Unit *">
                      <select value={l.unit} disabled={!editable} aria-label={`Line ${i + 1} unit`} onChange={(e) => setLine(i, { unit: e.target.value as Unit })}>
                        {UNITS.map((u) => (
                          <option key={u} value={u}>
                            {unitLabel(u)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="line-remove">
                      {editable && (
                        <button
                          type="button"
                          className="icon-button danger-text"
                          aria-label={`Remove line ${i + 1}`}
                          title="Remove line"
                          onClick={() => {
                            setLines((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [emptyLine()]))
                            setDirty(true)
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <datalist id="w-process">
            {suggest.process.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="w-defect">
            {suggest.defect.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          <datalist id="w-reason">
            {suggest.reason.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
          {editable && (
            <button
              type="button"
              className="small add-line"
              onClick={() => {
                setLines((list) => [...list, emptyLine()])
                setDirty(true)
              }}
            >
              <Plus size={15} /> Add line
            </button>
          )}

          <div className="totals">
            <div>
              <span>Wastage in Pcs</span>
              <b>{formatNumber(sum.pcs)}</b>
            </div>
            <div>
              <span>Wastage in sheets</span>
              <b>{formatNumber(sum.sheets)}</b>
            </div>
            <div>
              <span>Total as Pcs{ups ? ` (1 sheet = ${ups} Pcs)` : ''}</span>
              <b>{sum.inPcs === null ? '—' : formatNumber(sum.inPcs)}</b>
            </div>
          </div>

          <label className="field">
            <span>Remarks</span>
            <textarea rows={2} maxLength={500} value={remarks} disabled={!editable} onChange={(e) => (setRemarks(e.target.value), setDirty(true))} />
          </label>

          {errors.length > 0 && (
            <div className="notice error" role="alert">
              <b>Please fix {errors.length === 1 ? 'this' : `these ${errors.length} items`} and save again:</b>
              <ul className="error-list">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {editable && (
            <div className="entry-footer">
              <span className="muted small">{lines.filter((l) => l.quantity).length} wastage line(s)</span>
              <button type="button" className="primary" onClick={save} disabled={saving}>
                <Save size={17} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
