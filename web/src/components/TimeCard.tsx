import type { ReactNode } from 'react'
import { Clock, RotateCcw, X } from 'lucide-react'
import { formatDuration, nowStamp, spanMinutes, spanTouched, stampFilled, stampPartial, time12 } from '../lib/production'
import type { Span, Stamp } from '../lib/production'

export interface AutoStart {
  manual: boolean // the start was typed by hand
  source: string // where the automatic start comes from, e.g. "Job Changeover end"
  value: Stamp | null // the automatic start, when known
  onReset: () => void
}

interface Props {
  title: string
  span: Span
  onChange: (span: Span) => void
  disabled?: boolean
  required?: boolean
  error?: string
  auto?: AutoStart
  downtime?: number // minutes of downtime inside this step
  children?: ReactNode // extra content under the card
}

// One timed step: Start date/time + Start Now, End date/time + End Now, gross and net.
export function TimeCard({ title, span, onChange, disabled, required, error, auto, downtime = 0, children }: Props) {
  const minutes = spanMinutes(span)
  const set = (side: 'start' | 'end', part: Partial<Stamp>) => onChange({ ...span, [side]: { ...span[side], ...part } })
  const partial = stampPartial(span.start) || stampPartial(span.end)
  const running = !partial && stampFilled(span.start) && !span.end.date && !span.end.time

  let status: ReactNode
  if (minutes !== null && minutes < 0) status = <span className="danger-text">End is before Start. Check the dates and times.</span>
  else if (minutes !== null)
    status = (
      <>
        Gross <b>{formatDuration(minutes)}</b>
        {downtime > 0 && (
          <>
            {' '}· Downtime {formatDuration(downtime)} · Net <b>{formatDuration(Math.max(0, minutes - downtime))}</b>
          </>
        )}
      </>
    )
  else if (partial) status = <span className="warn-text">Enter both the date and the time.</span>
  else if (running) status = <span className="muted">Running… press End Now when it finishes.</span>
  else status = <span className="muted">—</span>

  const autoNote =
    auto &&
    (auto.manual ? (
      <span className="auto-note manual">
        Typed by hand
        {!disabled && auto.value && (
          <button type="button" className="link-button" onClick={auto.onReset}>
            <RotateCcw size={13} /> Use {auto.source} ({time12(auto.value.time)})
          </button>
        )}
      </span>
    ) : (
      <span className="auto-note">Automatic: {auto.source}</span>
    ))

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
      {key === 'start' && autoNote}
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
      <div className="duration">{status}</div>
      {children}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
