// Reason buttons in category columns: downtime (one reason, four columns) and
// wastage (several reasons, three columns). The lists come from Masters.
import type { Reason } from '../lib/downtime'

interface Props {
  groups: readonly { key: string; label: string }[]
  reasons: Reason[]
  selected: string[]
  multiple?: boolean
  disabled?: boolean
  invalid?: boolean
  label: string
  onToggle: (reasonId: string) => void
}

export function ReasonPicker({ groups, reasons, selected, multiple, disabled, invalid, label, onToggle }: Props) {
  return (
    <div
      className={`reason-grid${invalid ? ' invalid' : ''}`}
      style={{ ['--reason-cols' as string]: groups.length }}
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={label}
    >
      {groups.map((group) => {
        const list = reasons.filter((r) => r.category === group.key && (r.active || selected.includes(r.id)))
        return (
          <div key={group.key} className="reason-col">
            <div className="reason-col-head">{group.label}</div>
            {list.length === 0 && <span className="muted small">No reasons yet</span>}
            {list.map((r) => {
              const on = selected.includes(r.id)
              return (
                <button
                  key={r.id}
                  type="button"
                  role={multiple ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  className={`reason-btn${on ? ' on' : ''}`}
                  disabled={disabled}
                  onClick={() => onToggle(r.id)}
                >
                  {r.name}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
