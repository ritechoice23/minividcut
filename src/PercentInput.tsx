import { useEffect, useState } from 'react'

/**
 * A typed percentage. A valid value is applied as you type (so the arrows work),
 * and anything out of range or empty is put right when you leave the box.
 */
export function PercentInput({ value, min, max, step = 1, label, disabled, onCommit }: {
  value: number
  min: number
  max: number
  step?: number
  label: string
  disabled?: boolean
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const inRange = (number: number) => Number.isFinite(number) && number >= min && number <= max
  return <span className="percent-input">
    <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} step={step} value={text} disabled={disabled}
      onChange={event => {
        setText(event.target.value)
        const number = event.target.valueAsNumber
        if (inRange(number) && number !== value) onCommit(number)
      }}
      onBlur={() => {
        const number = Number(text)
        if (text.trim() !== '' && Number.isFinite(number)) {
          const next = Math.round(Math.max(min, Math.min(max, number)))
          setText(String(next))
          if (next !== value) onCommit(next)
        } else {
          setText(String(value))
        }
      }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    <span aria-hidden="true">%</span>
  </span>
}
