import { useRef, useState } from 'react'
import { CheckCircle2, FileDown, FileUp, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/errors'
import { MAX_ROWS, columnOf, readUpload, sortErrors } from '../lib/jobUpload'
import type { RowError, UploadRow } from '../lib/jobUpload'
import { Modal } from './Modal'

type Reply =
  | { ok: true; count: number; dry_run: boolean }
  | { ok: false; code: 'INVALID'; errors: { row: number | null; field: string; message: string }[] }

interface Props {
  onClose: () => void
  onImported: (count: number) => void
  onTemplate: () => void
  templateBusy: boolean
}

// Bulk Upload: read the file, check every row (in the database, without saving),
// show all mistakes, and import only when there are none.
export function JobBulkUpload({ onClose, onImported, onTemplate, templateBusy }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState<UploadRow[]>([])
  const [errors, setErrors] = useState<RowError[]>([])
  const [stage, setStage] = useState<'pick' | 'checking' | 'preview' | 'importing'>('pick')

  // Same row and column reported by the file reader and the database: keep the first.
  function merge(a: RowError[], b: RowError[]) {
    const seen = new Set(a.map((e) => `${e.row}|${e.column}`))
    return sortErrors([...a, ...b.filter((e) => !seen.has(`${e.row}|${e.column}`))])
  }

  async function check(rowsToSend: UploadRow[], dryRun: boolean): Promise<{ reply?: Reply; failure?: string }> {
    const { data, error } = await supabase.rpc('import_production_jobs', { p_rows: rowsToSend, p_dry_run: dryRun })
    if (error) return { failure: friendlyError(error, 'job') }
    return { reply: data as Reply }
  }

  async function choose(file: File | undefined) {
    if (!file) return
    setFileName(file.name)
    setStage('checking')
    setErrors([])
    setRows([])
    const parsed = await readUpload(file)
    setRows(parsed.rows)
    if (parsed.rows.length === 0 || parsed.rows.length > MAX_ROWS || parsed.errors.some((e) => e.row === null)) {
      setErrors(parsed.errors)
      setStage('preview')
      return
    }
    const { reply, failure } = await check(parsed.rows, true)
    const server: RowError[] = failure
      ? [{ row: null, column: 'File', message: failure }]
      : reply && !reply.ok
        ? reply.errors.map((e) => ({ row: e.row, column: columnOf(e.field), message: e.message }))
        : []
    setErrors(merge(parsed.errors, server))
    setStage('preview')
  }

  async function runImport() {
    setStage('importing')
    const { reply, failure } = await check(rows, false)
    if (reply?.ok) {
      onImported(reply.count)
      return
    }
    setErrors(
      failure
        ? [{ row: null, column: 'File', message: failure }]
        : sortErrors((reply as Extract<Reply, { ok: false }>).errors.map((e) => ({ row: e.row, column: columnOf(e.field), message: e.message }))),
    )
    setStage('preview')
  }

  const badRows = new Set(errors.map((e) => e.row).filter((r) => r !== null))
  const canImport = stage === 'preview' && rows.length > 0 && errors.length === 0

  return (
    <Modal
      title="Bulk Upload · Job Details"
      onClose={stage === 'importing' ? () => undefined : onClose}
      width={980}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={stage === 'importing'}>
            Cancel
          </button>
          {stage !== 'pick' && (
            <button type="button" onClick={() => input.current?.click()} disabled={stage === 'checking' || stage === 'importing'}>
              <FileUp size={16} /> Choose another file
            </button>
          )}
          <button type="button" className="primary" onClick={runImport} disabled={!canImport}>
            {stage === 'importing' ? 'Importing…' : rows.length && !errors.length ? `Import ${rows.length} job${rows.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        aria-label="Excel file"
        onChange={(e) => {
          choose(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {stage === 'pick' && (
        <div className="upload-pick">
          <p>
            Fill in the <b>Jobs</b> sheet of the template (up to {MAX_ROWS} jobs), save it, and choose the file here. Every row is checked first: if any row has a
            mistake, nothing is imported.
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => input.current?.click()}>
              <FileUp size={17} /> Choose Excel file
            </button>
            <button type="button" onClick={onTemplate} disabled={templateBusy}>
              <FileDown size={17} /> {templateBusy ? 'Preparing…' : 'Download Template'}
            </button>
          </div>
        </div>
      )}

      {stage === 'checking' && <p className="page-status">Checking {fileName}…</p>}

      {(stage === 'preview' || stage === 'importing') && (
        <>
          <div className={`notice ${errors.length ? 'error' : 'success'} upload-summary`} role="status">
            {errors.length ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>
              <b>{fileName}</b>: {rows.length} job{rows.length === 1 ? '' : 's'} found.{' '}
              {errors.length
                ? `${errors.length} mistake${errors.length === 1 ? '' : 's'}${badRows.size ? ` in ${badRows.size} row${badRows.size === 1 ? '' : 's'}` : ''}. Nothing will be imported until the file is fixed: correct the rows below in Excel and choose the file again.`
                : 'All rows are correct and ready to import.'}
            </span>
          </div>

          {errors.length > 0 && (
            <div className="tablewrap upload-errors">
              <table className="compact">
                <thead>
                  <tr>
                    <th>Excel row</th>
                    <th>Column</th>
                    <th>What to fix</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, i) => (
                    <tr key={i}>
                      <td className="num">{e.row ?? '—'}</td>
                      <td>{e.column}</td>
                      <td className="wrap">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rows.length > 0 && (
            <>
              <h3 className="upload-heading">Jobs in the file</h3>
              <div className="tablewrap upload-rows">
                <table className="compact">
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th />
                      <th>Date</th>
                      <th>Order No</th>
                      <th>Job Name</th>
                      <th>Category</th>
                      <th>UPS</th>
                      <th>Job Type</th>
                      <th>Paper</th>
                      <th>Qty</th>
                      <th>Print Side</th>
                      <th>Colours</th>
                      <th>B/S Colours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const bad = badRows.has(r.row)
                      return (
                        <tr key={r.row} className={bad ? 'row-bad' : ''}>
                          <td className="num">{r.row}</td>
                          <td>{bad ? <XCircle size={16} className="danger-text" aria-label="Has mistakes" /> : <CheckCircle2 size={16} className="ok-text" aria-label="OK" />}</td>
                          <td>{r.plan_date === 'invalid' ? '?' : r.plan_date.split('-').reverse().join('-')}</td>
                          <td>{r.order_no}</td>
                          <td>{r.job_name}</td>
                          <td>{r.category}</td>
                          <td className="num">{r.ups}</td>
                          <td>{r.job_type}</td>
                          <td>{r.paper_type}</td>
                          <td className="num">{r.quantity}</td>
                          <td>{r.print_side}</td>
                          <td>{r.colours}</td>
                          <td>{r.bs_colours}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  )
}
