import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon.jsx'

const EXIT_MS = 180
let openSheets = 0

// Bottom sheet on phones, centred dialog on wider screens. Closes on Escape or backdrop tap,
// moves focus inside while open and returns it afterwards, and locks page scroll.
export default function Sheet({ open, onClose, title, description, children, footer, size = 'md', initialFocus = true }) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const panelRef = useRef(null)
  const returnFocusRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (!mounted) return undefined
    setClosing(true)
    const timer = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, EXIT_MS)
    return () => clearTimeout(timer)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mounted || closing) return undefined
    returnFocusRef.current = document.activeElement
    openSheets += 1
    document.documentElement.classList.add('has-sheet')

    const focusTimer = setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const target = initialFocus ? panel.querySelector('[data-autofocus], input:not([type=hidden]), textarea, select') : null
      ;(target || panel).focus({ preventScroll: true })
    }, 40)

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose?.()
      }
      if (event.key === 'Tab') trapFocus(event, panelRef.current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown)
      openSheets -= 1
      if (openSheets <= 0) document.documentElement.classList.remove('has-sheet')
      returnFocusRef.current?.focus?.({ preventScroll: true })
    }
  }, [mounted, closing]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null

  return createPortal(
    <div className={`sheet-layer ${closing ? 'is-closing' : ''}`}>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sheet sheet-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        <div className="sheet-handle" aria-hidden="true" />
        {title && (
          <header className="sheet-header">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </header>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

function trapFocus(event, container) {
  if (!container) return
  const focusable = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && element.offsetParent !== null)
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
