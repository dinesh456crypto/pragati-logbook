import { RIGHTS, emptyGrant, setRight } from '../lib/users'
import type { Matrix, ResourceRow, Right } from '../lib/users'

const RIGHT_LABEL: Record<Right, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete' }

interface Props {
  resources: ResourceRow[]
  value: Matrix
  onChange: (next: Matrix) => void
  disabled?: boolean
}

// View / Create / Edit / Delete per screen, grouped by module.
export function PermissionMatrix({ resources, value, onChange, disabled }: Props) {
  const modules = [...new Set(resources.map((r) => r.module))]
  const all = (right: Right) => resources.length > 0 && resources.every((r) => value[r.key]?.[right])

  function setColumn(right: Right, on: boolean) {
    const next: Matrix = { ...value }
    for (const r of resources) next[r.key] = setRight(next[r.key], right, on)
    onChange(next)
  }
  function setRow(key: ResourceRow['key'], on: boolean) {
    onChange({ ...value, [key]: on ? { view: true, create: true, edit: true, delete: true } : emptyGrant() })
  }

  return (
    <div className="tablewrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>Module / Screen</th>
            {RIGHTS.map((right) => (
              <th key={right} className="center">
                <label className="matrix-head">
                  <span>{RIGHT_LABEL[right]}</span>
                  <input
                    type="checkbox"
                    checked={all(right)}
                    disabled={disabled}
                    aria-label={`${RIGHT_LABEL[right]} on every screen`}
                    onChange={(e) => setColumn(right, e.target.checked)}
                  />
                </label>
              </th>
            ))}
            <th className="center">All</th>
          </tr>
        </thead>
        <tbody>
          {modules.map((module) => {
            const rows = resources.filter((r) => r.module === module)
            const single = rows.length === 1 && rows[0].label.toLowerCase() === module.toLowerCase()
            return [
              !single && (
                <tr key={`m-${module}`} className="matrix-module">
                  <td colSpan={6}>{module}</td>
                </tr>
              ),
              ...rows.map((r) => {
                const grant = value[r.key] ?? emptyGrant()
                const full = RIGHTS.every((x) => grant[x])
                return (
                  <tr key={r.key} className={grant.view ? 'granted' : ''}>
                    <td className={single ? 'matrix-single' : 'matrix-sub'}>{single ? module : r.label}</td>
                    {RIGHTS.map((right) => (
                      <td key={right} className="center" data-label={RIGHT_LABEL[right]}>
                        <input
                          type="checkbox"
                          checked={grant[right]}
                          disabled={disabled}
                          aria-label={`${r.label}: ${RIGHT_LABEL[right]}`}
                          onChange={(e) => onChange({ ...value, [r.key]: setRight(grant, right, e.target.checked) })}
                        />
                      </td>
                    ))}
                    <td className="center" data-label="All">
                      <input type="checkbox" checked={full} disabled={disabled} aria-label={`${r.label}: all rights`} onChange={(e) => setRow(r.key, e.target.checked)} />
                    </td>
                  </tr>
                )
              }),
            ]
          })}
        </tbody>
      </table>
    </div>
  )
}
