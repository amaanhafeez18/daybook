import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { EmptyState } from '../../components/ui/primitives.jsx'
import { normalizeGym, routineColor } from '../../lib/gym/state.js'
import { formatDuration, formatNumber, fromKg, parseDecimal, parseDuration, toKg } from '../../lib/gym/units.js'
import { navigate } from '../../lib/router.js'
import { useStore } from '../../lib/store.js'
import './gym-common.css'

// ---- navigation ----------------------------------------------------------------------------
// The home-screen app has no browser back button, so detail views have their own. It goes back
// only when there is an in-app entry behind this one; otherwise it opens the fallback view.
// Each entry's depth is stamped into history.state (0 = where this module started), so it
// survives reloads and tells back/forward apart from new navigation.

const DEPTH_KEY = 'daybookDepth'
let depth = 0

function readDepth() {
  const state = window.history.state
  return state && typeof state === 'object' && Number.isInteger(state[DEPTH_KEY]) ? state[DEPTH_KEY] : null
}

function stampDepth(value) {
  depth = value
  try {
    const state = window.history.state
    window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), [DEPTH_KEY]: value }, '')
  } catch {
    // replaceState can be rate-limited; the in-memory depth still works
  }
}

if (typeof window !== 'undefined') {
  const initial = readDepth()
  if (initial === null) stampDepth(0)
  else depth = initial
  window.addEventListener('hashchange', () => {
    const known = readDepth()
    if (known === null) stampDepth(depth + 1)
    else depth = known
  })
}

export function goBack(fallback = 'gym') {
  if (depth > 0 && window.history.length > 1) window.history.back()
  else navigate(fallback)
}

// ---- routine colour ----------------------------------------------------------------------------

// A missing routine (deleted) shows as a grey dashed ring.
export function RoutineDot({ routine, size = 10 }) {
  return (
    <span
      className={`gym-dot${routine ? '' : ' is-missing'}`}
      style={{ width: size, height: size, ...(routine ? { '--gym-dot': routineColor(routine) } : {}) }}
      aria-hidden="true"
    />
  )
}

// Without a routine: a plain chip when a label is given (e.g. "Rest"), else "Deleted routine".
export function RoutineChip({ routine, label }) {
  const name = typeof routine?.name === 'string' ? routine.name.trim() : ''
  const text = label ?? (routine ? name || 'Untitled routine' : 'Deleted routine')
  const missing = !routine && label == null
  return (
    <span
      className={`gym-routine-chip${routine ? ' has-color' : ''}${missing ? ' is-missing' : ''}`}
      style={routine ? { '--gym-dot': routineColor(routine) } : undefined}
    >
      {(routine || missing) && <RoutineDot routine={routine} size={8} />}
      <span className="gym-routine-chip-label">{text}</span>
    </span>
  )
}

const SET_TYPE_BADGES = {
  warmup: { short: 'W', label: 'Warm-up set' },
  drop: { short: 'D', label: 'Drop set' },
  failure: { short: 'F', label: 'Failure set' },
}

// Normal sets show their number (counted among normal sets by the caller).
export function SetTypeBadge({ type, number }) {
  const special = SET_TYPE_BADGES[type]
  return (
    <span className={`gym-set-badge${special ? ` is-${type}` : ''}`}>
      <span aria-hidden="true">{special ? special.short : number ?? '–'}</span>
      <span className="sr-only">{special ? special.label : `Set ${number ?? ''}`}</span>
    </span>
  )
}

// ---- inputs ----------------------------------------------------------------------------------
// The field keeps the user's own text while they type, so parsing and formatting never fight the
// caret: text that reads as a valid value is committed as it is typed, and on blur the field shows
// the value again in its tidy form (or goes back to it when the text can't be read).

const INVALID = Symbol('invalid')

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const sameValue = (a, b) => a === b || (a == null && b == null) || (isFiniteNumber(a) && isFiniteNumber(b) && Math.abs(a - b) < 1e-9)

function DraftInput({ value, format, parse, onChange, placeholder, ariaLabel, className = '', onFocus, onBlur, onKeyDown, ...rest }) {
  const [text, setText] = useState(() => format(value))
  const focused = useRef(false)
  const committed = useRef(value)

  useEffect(() => {
    // Changes from outside show at once; the echo of our own commit leaves the typed text alone.
    if (!focused.current || !sameValue(value, committed.current)) setText(format(value))
    committed.current = value
  }, [value, format])

  const commit = (next) => {
    if (sameValue(next, committed.current)) return false
    committed.current = next
    onChange?.(next)
    return true
  }

  return (
    <input
      type="text"
      enterKeyHint="done"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...rest}
      className={`gym-input ${className}`}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={text}
      onFocus={(event) => {
        focused.current = true
        onFocus?.(event)
      }}
      onChange={(event) => {
        setText(event.target.value)
        const parsed = parse(event.target.value)
        if (parsed !== INVALID) commit(parsed)
      }}
      onBlur={(event) => {
        focused.current = false
        const parsed = parse(event.target.value)
        if (parsed !== INVALID && commit(parsed)) {
          setText(format(parsed))
        } else {
          committed.current = value
          setText(format(value))
        }
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (!event.defaultPrevented && event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}

const selectUnit = (state) => normalizeGym(state.data.settings?.gym).prefs.unit

export function useUnit() {
  return useStore(selectUnit)
}

// Shows the weight in `unit` (default: the gym setting) and reports kg (null when cleared).
// A numeric placeholder is read as kg and converted too.
export function WeightInput({ valueKg, unit, onChange, placeholder, ariaLabel, ...rest }) {
  const preferred = useUnit()
  const shownUnit = unit === 'kg' || unit === 'lb' ? unit : preferred
  const format = useCallback((kg) => {
    const shown = fromKg(kg, shownUnit)
    return shown === null ? '' : formatNumber(shown, 2)
  }, [shownUnit])
  const parse = useCallback((text) => {
    if (!text.trim()) return null
    const number = parseDecimal(text)
    return number === null || number < 0 ? INVALID : toKg(number, shownUnit)
  }, [shownUnit])
  return (
    <DraftInput
      inputMode="decimal"
      {...rest}
      value={isFiniteNumber(valueKg) ? valueKg : null}
      format={format}
      parse={parse}
      onChange={onChange}
      placeholder={isFiniteNumber(placeholder) ? format(placeholder) : placeholder}
      ariaLabel={ariaLabel}
    />
  )
}

// Whole numbers unless `decimal`; values below min (default 0) or above max don't commit.
export function NumberInput({ value, onChange, placeholder, ariaLabel, decimal = false, min = 0, max, ...rest }) {
  const format = useCallback((number) => (!isFiniteNumber(number) ? '' : decimal ? formatNumber(number, 2) : String(number)), [decimal])
  const parse = useCallback((text) => {
    if (!text.trim()) return null
    const number = parseDecimal(text)
    if (number === null || (!decimal && !Number.isInteger(number))) return INVALID
    if ((isFiniteNumber(min) && number < min) || (isFiniteNumber(max) && number > max)) return INVALID
    return number
  }, [decimal, min, max])
  return (
    <DraftInput
      inputMode={decimal ? 'decimal' : 'numeric'}
      {...rest}
      value={isFiniteNumber(value) ? value : null}
      format={format}
      parse={parse}
      onChange={onChange}
      placeholder={isFiniteNumber(placeholder) ? format(placeholder) : placeholder}
      ariaLabel={ariaLabel}
    />
  )
}

const formatSeconds = (sec) => (isFiniteNumber(sec) ? formatDuration(sec) : '')

// 'm:ss', 'h:mm:ss' or plain seconds. The iPhone decimal keypad has no colon, so a separator
// followed by exactly two digits reads as minutes and seconds: '1.30' → 1:30.
function parseSeconds(text) {
  const clean = text.trim()
  if (!clean) return null
  const minutes = clean.match(/^(\d+)[.,](\d{2})$/)
  if (minutes) return Number(minutes[2]) < 60 ? Number(minutes[1]) * 60 + Number(minutes[2]) : INVALID
  const sec = parseDuration(clean)
  return sec === null ? INVALID : sec
}

export function DurationInput({ valueSec, onChange, placeholder, ariaLabel, ...rest }) {
  return (
    <DraftInput
      inputMode="decimal"
      {...rest}
      value={isFiniteNumber(valueSec) ? valueSec : null}
      format={formatSeconds}
      parse={parseSeconds}
      onChange={onChange}
      placeholder={isFiniteNumber(placeholder) ? formatSeconds(placeholder) : placeholder}
      ariaLabel={ariaLabel}
    />
  )
}

// ---- layout ----------------------------------------------------------------------------------

export function Stat({ label, value, sub }) {
  return (
    <div className="gym-stat">
      <span className="gym-stat-label">{label}</span>
      <span className="gym-stat-value">{value ?? '—'}</span>
      {sub != null && sub !== '' && <span className="gym-stat-sub">{sub}</span>}
    </div>
  )
}

export function SectionHeader({ title, action }) {
  return (
    <div className="gym-section-header">
      <h2>{title}</h2>
      {action}
    </div>
  )
}

export function GymEmpty({ icon = 'dumbbell', title, children, action }) {
  return (
    <div className="gym-empty">
      <EmptyState icon={icon} title={title} action={action}>{children}</EmptyState>
    </div>
  )
}

// ---- action sheets -----------------------------------------------------------------------------
// The one ⋯ menu the gym uses everywhere: an iOS-style titled sheet with grouped actions. Pass a
// flat list (one group) or a list of lists (groups, separated); destructive actions go last with
// `danger`. A falsy entry is skipped, so callers can write `cond && { … }`.

export function ActionSheet({ open, onClose, title, description, actions }) {
  const groups = (Array.isArray(actions?.[0]) ? actions : [actions || []])
    .map((group) => (Array.isArray(group) ? group.filter(Boolean) : []))
    .filter((group) => group.length)
  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} size="sm" initialFocus={false}>
      <div className="gym-as-groups">
        {groups.map((group, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} className="gym-as-list">
            {group.map((action) => (
              <button
                key={action.id}
                type="button"
                className={`gym-as-row${action.danger ? ' is-danger' : ''}`}
                disabled={action.disabled}
                aria-current={action.checked ? 'true' : undefined}
                onClick={() => {
                  onClose()
                  action.onClick()
                }}
              >
                {action.icon && <Icon name={action.icon} size={20} />}
                <span className="gym-as-label">
                  {action.label}
                  {action.hint && <small>{action.hint}</small>}
                </span>
                {action.value && <span className="gym-as-value">{action.value}</span>}
                {action.checked && <Icon name="check" size={18} strokeWidth={2.4} className="gym-as-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Sheet>
  )
}

// Sheet state that keeps its target while the sheet animates closed, so its content doesn't blank out.
export function useSheetTarget() {
  const [state, setState] = useState({ open: false, target: null })
  const show = (target) => setState({ open: true, target })
  const hide = () => setState((current) => (current.open ? { ...current, open: false } : current))
  return [state, show, hide]
}
