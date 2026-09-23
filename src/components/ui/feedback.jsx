import { useEffect, useState } from 'react'
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

let confirmListener = null

export function confirmAction({ title, message, confirmLabel = 'Delete', tone = 'danger' }) {
  return new Promise((resolve) => {
    if (!confirmListener) {
      resolve(window.confirm(message || title))
      return
    }
    confirmListener({ title, message, confirmLabel, tone, resolve })
  })
}

export function ConfirmHost() {
  const [request, setRequest] = useState(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    confirmListener = (next) => {
      setRequest(next)
      setOpen(true)
    }
    return () => { confirmListener = null }
  }, [])

  const settle = (value) => {
    request?.resolve(value)
    setOpen(false)
  }

  return (
    <Sheet
      open={open}
      onClose={() => settle(false)}
      title={request?.title}
      size="sm"
      initialFocus={false}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={() => settle(false)}>Cancel</button>
          <button type="button" className={`btn ${request?.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => settle(true)} data-autofocus>
            {request?.confirmLabel}
          </button>
        </>
      )}
    >
      {request?.message && <p className="confirm-message">{request.message}</p>}
    </Sheet>
  )
}
