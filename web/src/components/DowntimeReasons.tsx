// Downtime reason buttons in four columns: Man | Machine | Material | Others.
// The lists come from Masters → Downtime Reasons.
import { DOWNTIME_GROUPS } from '../lib/production'
import type { DowntimeReason } from '../lib/downtime'

interface Props {
  reasons: DowntimeReason[]
  value: string
  disabled?: boolean
  invalid?: boolean
  onChange: (reasonId: string) => void
}

export function DowntimeReasonPicker({ reasons, value, disabled, invalid, onChange }: Props) {
  return (
    <div className={`reason-grid${invalid ? ' invalid' : ''}`} role="radiogroup" aria-label="Downtime reason">
      {DOWNTIME_GROUPS.map((group) => {
        const list = reasons.filter((r) => r.category === group && (r.active || r.id === value))
        return (
          <div key={group} className="reason-col">
            <div className="reason-col-head">{group}</div>
            {list.length === 0 && <span className="muted small">No reasons yet</span>}
            {list.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={r.id === value}
                className={`reason-btn${r.id === value ? ' on' : ''}`}
                disabled={disabled}
                onClick={() => onChange(r.id)}
              >
                {r.name}
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}
