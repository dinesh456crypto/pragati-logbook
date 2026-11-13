import { useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { OrderOption } from '../lib/production'
import { formatDate } from '../lib/jobs'

interface Props {
  value: string
  options: OrderOption[]
  disabled?: boolean
  invalid?: boolean
  onSelect: (orderNo: string) => void
}

// Searchable order list: pick a planned / open order, or type a new order number.
export function OrderPicker({ value, options, disabled, invalid, onSelect }: Props) {
  const [text, setText] = useState(value)
  const [lastValue, setLastValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  // Follow the value when the form changes it (for example after loading a draft).
  if (value !== lastValue) {
    setLastValue(value)
    setText(value)
  }

  const typed = text.trim()
  const matches = useMemo(() => {
    const q = typed.toLowerCase()
    const list = q
      ? options.filter((o) => o.order_no.toLowerCase().includes(q) || (o.job_name ?? '').toLowerCase().includes(q))
      : options
    return list.slice(0, 50)
  }, [options, typed])
  const exact = options.some((o) => o.order_no.toLowerCase() === typed.toLowerCase())
  const items: { order_no: string; option?: OrderOption }[] = [
    ...matches.map((o) => ({ order_no: o.order_no, option: o })),
    ...(typed && !exact ? [{ order_no: typed }] : []),
  ]

  function choose(orderNo: string) {
    setText(orderNo)
    setOpen(false)
    if (orderNo.trim() !== value.trim()) onSelect(orderNo.trim())
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (open && items[active]) choose(items[active].order_no)
      else choose(typed)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="picker">
      <div className={`picker-input ${invalid ? 'invalid' : ''}`}>
        <input
          ref={inputRef}
          value={text}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          placeholder="Search planned orders or type a new order number"
          maxLength={60}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          onBlur={() => {
            // Let a click on an option land first.
            setTimeout(() => {
              setOpen(false)
              if (text.trim() !== value.trim()) onSelect(text.trim())
            }, 150)
          }}
        />
        <button
          type="button"
          className="icon-button"
          tabIndex={-1}
          disabled={disabled}
          aria-label="Show orders"
          onMouseDown={(e) => {
            e.preventDefault()
            setOpen((o) => !o)
            inputRef.current?.focus()
          }}
        >
          <ChevronDown size={18} />
        </button>
      </div>
      {open && !disabled && (
        <ul className="picker-list" id={listId} role="listbox">
          {items.length === 0 && <li className="picker-empty">No open orders. Type an order number to enter a new one.</li>}
          {items.map((it, i) => (
            <li
              key={it.order_no + (it.option ? '' : '-new')}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(it.order_no)
              }}
              onMouseEnter={() => setActive(i)}
            >
              {it.option ? (
                <>
                  <span>
                    <b>{it.option.order_no}</b> · {it.option.job_name}
                  </span>
                  <span className="picker-meta">
                    {it.option.planned ? `Planned ${formatDate(it.option.plan_date)}` : 'Not in plan'}
                    {it.option.sides_used.length > 0 && ` · Printed: ${it.option.sides_used.join(', ')}`}
                    {it.option.sides_closed.length > 0 && ` · Closed: ${it.option.sides_closed.join(', ')}`}
                  </span>
                </>
              ) : (
                <span>
                  Use <b>{it.order_no}</b> as a new order (not in Production Plan)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
