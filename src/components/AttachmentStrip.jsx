import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from './ui/Icon.jsx'
import { confirmAction, toast } from './ui/feedback.jsx'
import { MAX_PER_TARGET, attachFile, attachmentAccept, removeAttachment, useAttachmentsFor, useSignedUrl } from '../lib/attachments.js'
import { attachmentKind, formatBytes } from '../lib/media.js'
import { formatDateShort } from '../lib/dates.js'
import './attachments.css'

// Photos and PDFs pinned to a task, a note or a person: a row of thumbnails (newest first) with an
// "Add" tile, each opening a full-screen viewer that can also remove the file.
//   <AttachmentStrip targetType="task" targetId={task.id} />
// compact: smaller tiles, and nothing at all while there is nothing to show — the page then offers
// its own "add" button and calls ref.current.pick(). label: the list's accessible name.
const AttachmentStrip = forwardRef(function AttachmentStrip({ targetType, targetId, compact = false, label = 'Photos and files' }, ref) {
  const items = useAttachmentsFor(targetType, targetId)
  const [uploads, setUploads] = useState([]) // { key, name, kind, preview, progress: -1 (preparing) | 0…1 }
  const [viewing, setViewing] = useState(null) // id of the open attachment
  const inputRef = useRef(null)
  const uploadsRef = useRef([])
  // Object URLs of photos uploaded in this session, keyed by attachment id: the new tile shows the
  // very same JPEG at once instead of waiting for its link. Freed when the strip unmounts.
  const previews = useRef(new Map())

  useEffect(() => () => {
    for (const url of previews.current.values()) revoke(url)
    for (const upload of uploadsRef.current) revoke(upload.preview)
  }, [])

  const setUploadList = (next) => {
    uploadsRef.current = typeof next === 'function' ? next(uploadsRef.current) : next
    setUploads(uploadsRef.current)
  }
  const patchUpload = (key, patch) => setUploadList((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  const dropUpload = (key) => setUploadList((list) => list.filter((item) => item.key !== key))

  function pick() {
    inputRef.current?.click()
  }
  useImperativeHandle(ref, () => ({ pick }), [])

  function onPick(event) {
    const files = [...(event.target.files || [])]
    event.target.value = '' // so choosing the same file again still counts
    if (!files.length || !targetId) return
    const room = MAX_PER_TARGET - items.length - uploadsRef.current.length
    if (room <= 0) {
      toast(`Up to ${MAX_PER_TARGET} files can be attached here.`, { tone: 'error' })
      return
    }
    if (files.length > room) toast(`Only ${room} more ${room === 1 ? 'file fits' : 'files fit'} here (up to ${MAX_PER_TARGET}).`)
    for (const file of files.slice(0, room)) startUpload(file)
  }

  async function startUpload(file) {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    setUploadList((list) => [...list, { key, name: file.name || 'photo', kind: attachmentKind(file) === 'pdf' ? 'pdf' : 'image', preview: '', progress: -1 }])
    try {
      const row = await attachFile(file, targetType, targetId, {
        onPrepared: (prepared) => patchUpload(key, { name: prepared.name, kind: prepared.kind, preview: prepared.kind === 'image' ? objectUrl(prepared.blob) : '' }),
        onProgress: (fraction) => patchUpload(key, { progress: fraction }),
      })
      const upload = uploadsRef.current.find((item) => item.key === key)
      if (upload?.preview) previews.current.set(row.id, upload.preview)
      dropUpload(key)
    } catch (error) {
      const upload = uploadsRef.current.find((item) => item.key === key)
      revoke(upload?.preview)
      dropUpload(key)
      if (error?.name !== 'AbortError') toast(error?.message || 'Couldn’t attach that file.', { tone: 'error', duration: 7000 })
    }
  }

  const input = typeof document === 'undefined' ? null : createPortal(
    // Outside .shell, so a focused picker never counts as "typing" (which hides the tab bar).
    <input ref={inputRef} type="file" accept={attachmentAccept} multiple className="att-input" tabIndex={-1} aria-hidden="true" data-att-target={`${targetType}:${targetId || ''}`} onChange={onPick} />,
    document.body,
  )

  const viewer = viewing && (
    <Viewer
      items={items}
      currentId={viewing}
      previews={previews.current}
      onChange={setViewing}
      onClose={() => setViewing(null)}
    />
  )

  if (compact && !items.length && !uploads.length) return <>{input}{viewer}</>

  return (
    <div className={`att-strip${compact ? ' is-compact' : ''}`}>
      <ul className="att-list" aria-label={label}>
        <li>
          <button type="button" className="att-add" onClick={pick} aria-label="Add a photo or PDF">
            <Icon name="plus" size={20} strokeWidth={2.2} />
            <span>Add</span>
          </button>
        </li>
        {uploads.map((upload) => (
          <li key={upload.key}><UploadTile upload={upload} /></li>
        ))}
        {items.map((item) => (
          <li key={item.id}><Tile item={item} preview={previews.current.get(item.id)} onOpen={() => setViewing(item.id)} /></li>
        ))}
      </ul>
      {input}
      {viewer}
    </div>
  )
})

export default AttachmentStrip

// A thumbnail (photos) or a small file card (PDFs); tapping opens the viewer.
function Tile({ item, preview, onOpen }) {
  const isPdf = item.kind === 'pdf'
  const link = useSignedUrl(isPdf || preview ? null : item.id)
  const [failed, setFailed] = useState(false)
  const src = preview || link.url
  const loading = !isPdf && !src && link.status === 'loading'
  const broken = !isPdf && (failed || (!src && link.status !== 'loading'))
  const label = `${isPdf ? 'Open' : 'View'} ${item.name}`
  return (
    <button
      type="button"
      className={`att-tile${isPdf ? ' is-pdf' : ' is-image'}${loading ? ' is-loading' : ''}${broken ? ' is-broken' : ''}`}
      onClick={onOpen}
      aria-label={label}
      title={item.name}
    >
      {isPdf ? (
        <>
          <Icon name="file" size={20} className="att-tile-icon" />
          <span className="att-tile-name">{item.name}</span>
        </>
      ) : src && !failed ? (
        <img src={src} alt="" decoding="async" loading="lazy" onError={() => { setFailed(true); if (!preview) link.retry() }} />
      ) : broken ? (
        <Icon name="image" size={22} />
      ) : null}
    </button>
  )
}

// A file on its way up: the photo (dimmed) or a file card, with a progress ring.
function UploadTile({ upload }) {
  const isPdf = upload.kind === 'pdf'
  const percent = upload.progress < 0 ? null : Math.round(upload.progress * 100)
  return (
    <div className={`att-tile is-uploading${isPdf ? ' is-pdf' : ' is-image'}`} role="status" aria-label={percent === null ? `Preparing ${upload.name}` : `Uploading ${upload.name}, ${percent}%`}>
      {isPdf ? (
        <>
          <Icon name="file" size={20} className="att-tile-icon" />
          <span className="att-tile-name">{upload.name}</span>
        </>
      ) : upload.preview ? <img src={upload.preview} alt="" /> : null}
      <span className="att-veil" aria-hidden="true"><Ring fraction={upload.progress} /></span>
    </div>
  )
}

const RING_R = 10
const RING_C = 2 * Math.PI * RING_R

function Ring({ fraction }) {
  const spinning = fraction < 0
  const offset = spinning ? RING_C * 0.75 : RING_C * (1 - Math.max(0, Math.min(1, fraction)))
  return (
    <svg className={`att-ring${spinning ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="att-ring-track" cx="12" cy="12" r={RING_R} />
      <circle className="att-ring-bar" cx="12" cy="12" r={RING_R} strokeDasharray={RING_C} strokeDashoffset={offset} />
    </svg>
  )
}

// ---- viewer ----------------------------------------------------------------------------------------
// Full-screen: the photo at full size, or a card with an "Open PDF" link (the bucket is private,
// so the link is the short-lived signed one). × or Escape closes; ← → move between the files;
// Remove asks first, since a removed file is gone from the server.

function Viewer({ items, currentId, previews, onChange, onClose }) {
  const index = items.findIndex((item) => item.id === currentId)
  const item = index >= 0 ? items[index] : null
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const returnFocus = useRef(null)
  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  confirmingRef.current = confirming
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const stepRef = useRef(null)

  const step = (delta) => {
    if (items.length < 2) return
    const next = items[(index + delta + items.length) % items.length]
    if (next) onChange(next.id)
  }
  stepRef.current = step

  // Gone from the list (removed elsewhere, or the target was deleted): nothing left to show.
  useEffect(() => {
    if (!item) onCloseRef.current()
  }, [item])

  useEffect(() => {
    returnFocus.current = document.activeElement
    document.documentElement.classList.add('has-att-viewer')
    const focusTimer = setTimeout(() => closeRef.current?.focus({ preventScroll: true }), 30)
    // Capture phase, ahead of the sheet the viewer may have been opened from (which listens for
    // Escape and Tab on document too); while the "Remove?" question is up, it gets the keys.
    const onKeyDown = (event) => {
      if (confirmingRef.current) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        onCloseRef.current()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.stopPropagation()
        stepRef.current?.(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.key === 'Tab') {
        event.stopPropagation()
        trapFocus(event, panelRef.current)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('keydown', onKeyDown, true)
      document.documentElement.classList.remove('has-att-viewer')
      const target = returnFocus.current
      if (target && document.contains(target)) target.focus?.({ preventScroll: true })
    }
  }, [])

  async function remove() {
    if (!item) return
    const isPdf = item.kind === 'pdf'
    setConfirming(true)
    const ok = await confirmAction({ title: isPdf ? 'Remove this file?' : 'Remove this photo?', message: `“${item.name}” will be deleted for good.`, confirmLabel: 'Remove' })
    setConfirming(false)
    if (!ok) return
    const next = items.length > 1 ? items[(index + 1) % items.length] : null
    removeAttachment(item.id)
    toast(isPdf ? 'File removed' : 'Photo removed')
    if (next && next.id !== item.id) onChange(next.id)
    else onClose()
  }

  if (!item) return null
  const when = item.createdAt ? formatDateShort(String(item.createdAt).slice(0, 10)) : ''
  const meta = [item.bytes ? formatBytes(item.bytes) : '', when].filter(Boolean).join(' · ')

  return createPortal(
    <div ref={panelRef} className="att-viewer" role="dialog" aria-modal="true" aria-label={item.name}>
      <header className="att-viewer-bar">
        <button ref={closeRef} type="button" className="att-viewer-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={22} />
        </button>
        <span className="att-viewer-title">
          <strong>{item.name}</strong>
          {meta && <small>{meta}</small>}
        </span>
        <button type="button" className="att-viewer-btn is-danger" onClick={remove} aria-label={item.kind === 'pdf' ? 'Remove this file' : 'Remove this photo'}>
          <Icon name="trash" size={21} />
        </button>
      </header>
      {/* A tap on the dark area (not the picture) closes, like Photos. */}
      <div className="att-viewer-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
        <Stage key={item.id} item={item} preview={previews.get(item.id)} />
      </div>
      {items.length > 1 && (
        <footer className="att-viewer-nav">
          <button type="button" className="att-viewer-btn" onClick={() => step(-1)} aria-label="Previous"><Icon name="chevronLeft" size={22} /></button>
          <span aria-live="polite">{index + 1} of {items.length}</span>
          <button type="button" className="att-viewer-btn" onClick={() => step(1)} aria-label="Next"><Icon name="chevronRight" size={22} /></button>
        </footer>
      )}
    </div>,
    document.body,
  )
}

function Stage({ item, preview }) {
  const link = useSignedUrl(item.id)
  const [failed, setFailed] = useState(false)
  const isPdf = item.kind === 'pdf'
  const retry = () => {
    setFailed(false)
    link.retry()
  }

  if (isPdf) {
    return (
      <div className="att-viewer-pdf">
        <span className="att-viewer-pdf-icon"><Icon name="file" size={30} strokeWidth={1.6} /></span>
        <strong>{item.name}</strong>
        {item.bytes ? <small>{formatBytes(item.bytes)}</small> : null}
        {link.status === 'loading' ? <span className="att-viewer-note"><span className="spinner" /> Getting the link…</span>
          : link.url ? <a className="btn btn-primary att-viewer-open" href={link.url} target="_blank" rel="noopener noreferrer"><Icon name="arrowRight" size={18} /> Open PDF</a>
            : <Unavailable status={link.status} onRetry={retry} />}
      </div>
    )
  }

  const src = link.url || preview
  if (link.status === 'loading' && !src) return <span className="att-viewer-note"><span className="spinner" /> Loading…</span>
  if (!src || failed) return <Unavailable status={failed ? 'error' : link.status} onRetry={retry} />
  return <img src={src} alt={item.name} decoding="async" onError={() => setFailed(true)} />
}

function Unavailable({ status, onRetry }) {
  return (
    <div className="att-viewer-note is-stack">
      <Icon name="alert" size={22} />
      <span>{status === 'missing' ? 'This file is no longer available.' : 'Couldn’t load this file.'}</span>
      {status !== 'missing' && <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  )
}

function trapFocus(event, container) {
  if (!container) return
  const focusable = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((element) => !element.disabled)
  if (!focusable.length) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  const outside = !container.contains(active)
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault()
    first.focus()
  }
}

function objectUrl(blob) {
  try {
    return blob && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : ''
  } catch {
    return ''
  }
}

function revoke(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // already gone
    }
  }
}
