import { useEffect, useId, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import Sheet from './Sheet.jsx'

// ---- toasts ------------------------------------------------------------------------------
// toast('Task archived', { action: { label: 'Undo', onClick } }) — short-lived, non-blocking
// messages. Reversible actions use an Undo toast instead of an "are you sure?" dialog.

let toastListener = null
let toastId = 0

export function toast(message, { action, tone = 'default', duration = 4500 } = {}) {
  toastListener?.({ id: ++toastId, message, action, tone, duration })
}

export function Toaster() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    toastListener = (item) => setToasts((current) => [...current.slice(-2), item])
    return () => { toastListener = null }
  }, [])

  const dismiss = (id) => setToasts((current) => current.filter((item) => item.id !== id))

  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => <ToastItem key={item.id} item={item} onDismiss={() => dismiss(item.id)} />)}
    </div>
  )
}

function ToastItem({ item, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, item.duration)
    return () => clearTimeout(timer)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`toast toast-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
      {item.tone === 'error' && <Icon name="alert" size={18} />}
      {item.tone === 'success' && <Icon name="check" size={18} />}
      <span className="toast-message">{item.message}</span>
      {item.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            item.action.onClick()
            onDismiss()
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="close" size={16} />
      </button>
    </div>
  )
}

// ---- confirmation ------------------------------------------------------------------------
// Only for permanent actions: `if (await confirmAction({...})) ...`
// Resolves true (confirm button), false (the cancel button, which cancelLabel can name as an
// action, e.g. 'Resume') or null (dismissed: backdrop, Escape or close).

let confirmListener = null

export function confirmAction({ title, message, confirmLabel = 'Delete', tone = 'danger', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    if (!confirmListener) {
      resolve(window.confirm(message || title))
      return
    }
    confirmListener({ title, message, confirmLabel, tone, cancelLabel, resolve })
  })
}

export function ConfirmHost() {
  const [request, setRequest] = useState(null)
  const [open, setOpen] = useState(false)
  const pending = useRef(null)
  const messageId = useId()

  useEffect(() => {
    confirmListener = (next) => {
      pending.current?.resolve(null) // a newer question replaces one still open
      pending.current = next
      setRequest(next)
      setOpen(true)
    }
    return () => {
      confirmListener = null
      pending.current?.resolve(null)
      pending.current = null
    }
  }, [])

  const settle = (value) => {
    if (pending.current === request) pending.current = null
    request?.resolve(value)
    setOpen(false)
  }

  return (
    <Sheet
      open={open}
      onClose={() => settle(null)}
      title={request?.title}
      size="sm"
      initialFocus={false}
      role="alertdialog"
      describedBy={request?.message ? messageId : undefined}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>{request?.cancelLabel || 'Cancel'}</button>
          <button type="button" className={`btn ${request?.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => settle(true)} data-autofocus>
            {request?.confirmLabel}
          </button>
        </>
      )}
    >
      {request?.message && <p id={messageId} className="confirm-message">{request.message}</p>}
    </Sheet>
  )
}
