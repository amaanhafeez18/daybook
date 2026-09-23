import { useId, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'

export function Button({ variant = 'primary', size, icon, loading = false, children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${className}`}
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon, label, size = 20, className = '', active = false, ...props }) {
  return (
    <button type="button" className={`icon-btn ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} {...props}>
      <Icon name={icon} size={size} />
    </button>
  )
}

// Visible label above the control (placeholders alone aren't labels).
export function Field({ label, hint, error, children, className = '' }) {
  const id = useId()
  const control = typeof children === 'function' ? children(id) : children
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label && <label className="field-label" htmlFor={id}>{label}</label>}
      {control}
      {error ? <p className="field-error" role="alert">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  )
}

export function PasswordInput({ id, value, onChange, autoComplete, placeholder, ...props }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="input-with-action">
      <input
        id={id}
        className="input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        placeholder={placeholder}
        autoCapitalize="none"
        spellCheck={false}
        {...props}
      />
      <button type="button" className="input-action" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Hide password' : 'Show password'}>
        <Icon name={visible ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </div>
  )
}

// Grows with its content, up to maxRows.
export function AutoTextarea({ value, maxRows = 12, minRows = 2, className = '', ...props }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 22
    const max = lineHeight * maxRows + 24
    element.style.height = `${Math.min(element.scrollHeight, max)}px`
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, maxRows])
  return <textarea ref={ref} rows={minRows} value={value} className={`input textarea ${className}`} {...props} />
}

export function Segmented({ options, value, onChange, label, size, className = '' }) {
  return (
    <div className={`segmented ${size ? `segmented-${size}` : ''} ${className}`} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={value === option.id ? 'is-active' : ''}
          onClick={() => onChange(option.id)}
        >
          {option.icon && <Icon name={option.icon} size={16} />}
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label, description }) {
  const id = useId()
  return (
    <label className="switch-row" htmlFor={id}>
      <span className="switch-text">
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  )
}

export function EmptyState({ icon, title, children, action }) {
  return (
    <div className="empty-state">
      {icon && <span className="empty-icon"><Icon name={icon} size={24} /></span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

const AVATAR_TONES = ['#E8845B', '#5B9BD5', '#7BAF6E', '#B982D6', '#D6A64F', '#E0708C', '#4FB3A5', '#8C8FD9']

export function Avatar({ name = '', src, size = 40 }) {
  const [failed, setFailed] = useState(false)
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?'
  const tone = AVATAR_TONES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_TONES.length]
  return (
    <span className="avatar" style={{ width: size, height: size, '--avatar-tone': tone, fontSize: size * 0.38 }} aria-hidden="true">
      {src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : initials}
    </span>
  )
}

export function Skeleton({ lines = 3 }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => <span key={index} className="skeleton" style={{ width: `${92 - index * 14}%` }} />)}
    </div>
  )
}

export function Card({ title, icon, action, children, className = '', tone }) {
  return (
    <section className={`card ${tone ? `card-${tone}` : ''} ${className}`}>
      {(title || action) && (
        <header className="card-header">
          <h3>
            {icon && <Icon name={icon} size={18} />}
            {title}
          </h3>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function Checkbox({ checked, onChange, label }) {
  return (
    <button
      type="button"
      className={`check ${checked ? 'is-checked' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onChange(!checked)
      }}
    >
      <Icon name="check" size={14} strokeWidth={3} />
    </button>
  )
}
