import type { ReactNode } from 'react'
import { Clock, X } from 'lucide-react'
import { formatDuration, nowStamp, spanMinutes, spanTouched, stampPartial, time12 } from '../lib/production'
import type { Span, Stamp } from '../lib/production'

interface Props {
  title: string
  span: Span
  onChange: (span: Span) => void
  disabled?: boolean
  required?: boolean
  error?: string
  children?: ReactNode // extra actions under the card
}

// One timed activity: Start date/time + Start Now, End date/time + End Now, duration.
export function TimeCard({ title, span, onChange, disabled, required, error, children }: Props) {
  const minutes = spanMinutes(span)
  const set = (side: 'start' | 'end', part: Partial<Stamp>) => onChange({ ...span, [side]: { ...span[side], ...part } })
  const partial = stampPartial(span.start) || stampPartial(span.end)
  const oneSided = !partial && (Boolean(span.start.date) !== Boolean(span.end.date))

  let status: ReactNode
  if (minutes !== null && minutes < 0) status = <span className="danger-text">End is before Start. Check the dates and times.</span>
  else if (minutes !== null) status = <b>{formatDuration(minutes)}</b>
  else if (partial) status = <span className="warn-text">Enter both the date and the time.</span>
  else if (oneSided && span.start.date) status = <span className="muted">Running… press End Now when it finishes.</span>
  else status = <span className="muted">—</span>

  const side = (key: 'start' | 'end', label: string) => (
    <div className="time-side">
      <span className="smallcaps">{label}</span>
      <div className="time-inputs">
        <label className="field">
          <span>{label} Date</span>
          <input type="date" value={span[key].date} disabled={disabled} onChange={(e) => set(key, { date: e.target.value })} />
        </label>
        <label className="field">
          <span>
            {label} Time {span[key].time && <em className="muted">({time12(span[key].time)})</em>}
          </span>
          <input type="time" value={span[key].time} disabled={disabled} onChange={(e) => set(key, { time: e.target.value })} />
        </label>
      </div>
      {!disabled && (
        <button type="button" className="small" onClick={() => set(key, nowStamp())}>
          <Clock size={15} /> {label} Now
        </button>
      )}
    </div>
  )

  return (
    <div className={`time-card ${error ? 'has-error' : ''}`}>
      <div className="time-card-head">
        <h3>
          {title} {required && <span className="badge amber">Required</span>}
        </h3>
        {!disabled && spanTouched(span) && (
          <button
            type="button"
            className="icon-button"
            title="Clear times"
            aria-label={`Clear ${title} times`}
            onClick={() => onChange({ start: { date: '', time: '' }, end: { date: '', time: '' } })}
          >
            <X size={17} />
          </button>
        )}
      </div>
      <div className="time-grid">
        {side('start', 'Start')}
        {side('end', 'End')}
      </div>
      <div className="duration">Duration: {status}</div>
      {children}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
