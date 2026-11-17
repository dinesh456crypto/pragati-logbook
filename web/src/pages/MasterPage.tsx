import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { masterBySlug } from '../lib/masters'
import type { MasterConfig, MasterRow } from '../lib/masters'
import { friendlyError } from '../lib/errors'
import { ConfirmDialog, Modal } from '../components/Modal'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

// One screen serves all master lists; the URL decides which table is shown.
export function MasterPage() {
  const { pathname } = useLocation()
  const config = masterBySlug(pathname.split('/').pop() ?? '')
  if (!config) return <p className="empty">Unknown master list.</p>
  return <MasterList key={config.slug} config={config} />
}

type StatusFilter = 'all' | 'active' | 'inactive'

function MasterList({ config }: { config: MasterConfig }) {
  const { can } = useAuth()
  const notify = useToast()
  const isMachine = config.kind === 'machine'
  const [rows, setRows] = useState<MasterRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<MasterRow | 'new' | null>(null)
  const [deleting, setDeleting] = useState<MasterRow | null>(null)
  const [busy, setBusy] = useState(false)
  // Reason lists with categories: pick the category first, then its reasons are listed.
  const categories = config.categories
  const [category, setCategory] = useState(categories?.[0]?.key ?? '')
  const categoryLabel = categories?.find((c) => c.key === category)?.label ?? ''

  const canCreate = can('masters', 'create')
  const canEdit = can('masters', 'edit')
  const canDelete = can('masters', 'delete')

  // Fetches the whole list (master lists are small); filtering happens on screen.
  const fetchRows = useCallback(() => {
    const columns = isMachine
      ? 'id, code, name, default_speed, sort_order, active, created_at, updated_at'
      : `id, name, active, created_at, updated_at${config.categories ? ', category' : ''}`
    return supabase.from(config.table).select(columns).order('created_at').order('id')
  }, [config.table, config.categories, isMachine])

  const applyRows = useCallback(({ data, error }: { data: unknown; error: unknown }) => {
    if (error) setLoadError(friendlyError(error))
    else {
      setRows((data ?? []) as MasterRow[])
      setLoadError('')
    }
    setLoading(false)
  }, [])

  const load = useCallback(() => fetchRows().then(applyRows), [fetchRows, applyRows])

  useEffect(() => {
    let alive = true
    fetchRows().then((result) => alive && applyRows(result))
    return () => {
      alive = false
    }
  }, [fetchRows, applyRows])

  // The rows of the chosen category (all rows for lists without categories).
  const inCategory = useMemo(() => (categories ? rows.filter((r) => r.category === category) : rows), [rows, categories, category])

  // S.No follows creation order and does not change when filtering.
  const serial = useMemo(() => new Map(inCategory.map((r, i) => [r.id, i + 1])), [inCategory])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return inCategory.filter(
      (r) =>
        (status === 'all' || (status === 'active') === r.active) &&
        (!q || r.name.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q)),
    )
  }, [inCategory, query, status])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    const { error } = await supabase.from(config.table).delete().eq('id', deleting.id)
    setBusy(false)
    setDeleting(null)
    if (error) {
      notify('error', friendlyError(error, config.singular.toLowerCase()))
    } else {
      notify('success', `${config.singular} "${deleting.name}" deleted.`)
      load()
    }
  }

  const headers = isMachine
    ? ['S.No', 'Machine ID', 'Machine Name', 'Default Speed (sheets/hr)', 'Status', '']
    : ['S.No', config.nameLabel, 'Status', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>{config.title}</h1>
          <p className="muted">
            {categories ? 'Choose a category, then create, edit or search its reasons' : 'Master data · create, view, edit, delete and search'}
          </p>
        </div>
        {canCreate && (
          <button type="button" className="primary" onClick={() => setEditing('new')}>
            <Plus size={18} /> {categories ? `New ${categoryLabel} reason` : 'Create New'}
          </button>
        )}
      </div>

      {categories && (
        <div className="category-tabs" role="tablist" aria-label="Category">
          {categories.map((c) => {
            const count = rows.filter((r) => r.category === c.key).length
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={category === c.key}
                className={category === c.key ? 'on' : ''}
                onClick={() => {
                  setCategory(c.key)
                  setPage(1)
                }}
              >
                {c.label} <span className="count">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      <section className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(1)
              }}
              placeholder={isMachine ? 'Search Machine ID or name' : categories ? `Search ${categoryLabel} reasons` : `Search ${config.title.toLowerCase()}`}
              aria-label="Search"
            />
          </label>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter)
              setPage(1)
            }}
            aria-label="Status filter"
          >
            <option value="all">All statuses</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </div>

        {loadError && <p className="notice error">{loadError}</p>}

        <div className="tablewrap">
          <table className={isMachine ? '' : 'compact'}>
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
                    {inCategory.length
                      ? 'No matching records.'
                      : categories
                        ? `No ${categoryLabel} reasons yet.`
                        : `No ${config.title.toLowerCase()} yet.`}
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setEditing(r)}>
                    <td>{serial.get(r.id)}</td>
                    {isMachine && <td>{r.code}</td>}
                    <td className="wrap">{r.name}</td>
                    {isMachine && <td>{r.default_speed?.toLocaleString('en-IN')}</td>}
                    <td>
                      <span className={`badge ${r.active ? 'green' : 'grey'}`}>{r.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      {canEdit && (
                        <button type="button" className="icon-button" onClick={() => setEditing(r)} title="Edit" aria-label={`Edit ${r.name}`}>
                          <Pencil size={17} />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          className="icon-button danger-text"
                          onClick={() => setDeleting(r)}
                          title="Delete"
                          aria-label={`Delete ${r.name}`}
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
            {filtered.length
              ? `Showing ${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, filtered.length)} of ${filtered.length}`
              : 'Showing 0 records'}
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
        <p className="muted small">Inactive entries stay in past records but are not offered for new entries.</p>
      </section>

      {editing && (
        <MasterForm
          config={config}
          defaultCategory={category}
          row={editing === 'new' ? null : editing}
          readOnly={editing === 'new' ? !canCreate : !canEdit}
          onClose={() => setEditing(null)}
          onSaved={(name, isNew) => {
            notify('success', `${config.singular} "${name}" ${isNew ? 'created' : 'saved'}.`)
            setEditing(null)
            load()
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${config.singular.toLowerCase()}?`}
          message={
            <>
              <b>{deleting.code ? `${deleting.code} · ` : ''}{deleting.name}</b> will be removed permanently. If it has
              been used in production records it cannot be deleted. Mark it Inactive instead.
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
  config: MasterConfig
  defaultCategory: string
  row: MasterRow | null
  readOnly: boolean
  onClose: () => void
  onSaved: (name: string, isNew: boolean) => void
}

function MasterForm({ config, defaultCategory, row, readOnly, onClose, onSaved }: FormProps) {
  const isMachine = config.kind === 'machine'
  const [category, setCategory] = useState(row?.category ?? defaultCategory)
  const [code, setCode] = useState(row?.code ?? '')
  const [name, setName] = useState(row?.name ?? '')
  const [speed, setSpeed] = useState(String(row?.default_speed ?? 13500))
  const [active, setActive] = useState(row?.active ?? true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (readOnly) return
    const cleanName = name.trim().replace(/\s+/g, ' ')
    const cleanCode = code.trim().replace(/\s+/g, ' ')
    const speedNum = Number(speed)
    if (isMachine && !cleanCode) return setError('Machine ID is required.')
    if (isMachine && cleanCode.length > 40) return setError('Machine ID can be at most 40 characters.')
    if (!cleanName) return setError(`${config.nameLabel} is required.`)
    if (cleanName.length > 100) return setError(`${config.nameLabel} can be at most 100 characters.`)
    if (isMachine && (!Number.isInteger(speedNum) || speedNum <= 0)) {
      return setError('Default speed must be a whole number above zero.')
    }

    const values: Record<string, unknown> = { name: cleanName, active }
    if (isMachine) Object.assign(values, { code: cleanCode, default_speed: speedNum })
    if (config.categories) {
      if (!config.categories.some((c) => c.key === category)) return setError('Select a category.')
      Object.assign(values, { category })
    }

    setBusy(true)
    setError('')
    const result = row
      ? await supabase.from(config.table).update(values).eq('id', row.id).select('id')
      : await supabase.from(config.table).insert(values).select('id')
    setBusy(false)
    if (result.error) return setError(friendlyError(result.error, config.singular.toLowerCase()))
    if (!result.data?.length) return setError('You do not have permission to do this.')
    onSaved(cleanName, !row)
  }

  const title = readOnly ? config.singular : row ? `Edit ${config.singular.toLowerCase()}` : `Create ${config.singular.toLowerCase()}`

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        readOnly ? (
          <button type="button" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" form="master-form" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )
      }
    >
      <form id="master-form" className="form-stack" onSubmit={submit} noValidate>
        {isMachine && (
          <label className="field">
            <span>Machine ID *</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} disabled={readOnly} autoFocus={!readOnly} />
          </label>
        )}
        {config.categories && (
          <label className="field">
            <span>Category *</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={readOnly}>
              {config.categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{config.nameLabel} *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            disabled={readOnly}
            autoFocus={!readOnly && !isMachine}
          />
        </label>
        {isMachine && (
          <label className="field">
            <span>Default Speed (sheets/hour) *</span>
            <input type="number" inputMode="numeric" min={1} step={1} value={speed} onChange={(e) => setSpeed(e.target.value)} disabled={readOnly} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={readOnly} />
          <span>Active (available for new entries)</span>
        </label>
        {row && (
          <p className="muted small">
            Created {new Date(row.created_at).toLocaleString('en-IN')} · Last updated {new Date(row.updated_at).toLocaleString('en-IN')}
          </p>
        )}
        {error && <p className="notice error">{error}</p>}
      </form>
    </Modal>
  )
}
