import { useEffect, useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Checkbox } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { archiveTask, isReminderMarker, restoreTask, setTaskDone, updateTask } from '../lib/planner.js'
import { useAttachmentCount } from '../lib/attachments.js'
import { addDaysISO, formatTime, relativeDay, todayISO } from '../lib/dates.js'
import './today.css'
import './tasks.css'

// Swipe right to complete (or reopen); swipe left to reveal Tomorrow and Archive, or swipe all
// the way to archive. Everything has Undo, and tapping the row still opens the full sheet.
const ACTION_W = 72 // px per revealed button
const ACTION_GAP = 6
const EDGE = 6 // inset of the action pills from the row's edges
const DRAG_START = 10 // px of sideways movement before a swipe takes over from scrolling
const FULL_SWIPE = 0.6 // of the row width: archive on release
let openRow = null // { ref, close }: only one row stays swiped open at a time

// trailing: an optional accessory after the text (e.g. a "Today" chip); tapping it doesn't open the task.
// swipe: false turns the swipe actions off.
export default function TaskRow({ task, onOpen, showDate = true, trailing = null, swipe = true }) {
  const today = todayISO()
  const tomorrow = addDaysISO(today, 1)
  const overdue = !task.done && task.date && task.date < today
  const details = isReminderMarker(task.details) ? '' : task.details
  const files = useAttachmentCount('task', task.id) // photos and PDFs pinned to the task
  const canTomorrow = !task.done && task.date !== tomorrow
  const openX = (canTomorrow ? 2 : 1) * ACTION_W + (canTomorrow ? ACTION_GAP : 0) + 2 * EDGE

  const rowRef = useRef(null)
  const drag = useRef(null)
  // A swipe ends in a click on the row (mouse) or in none at all (touch): only a click right
  // after it is swallowed, so a later keyboard or VoiceOver activation still works.
  const suppressClickUntil = useRef(0)
  const settleTimer = useRef(0)
  const [open, setOpen] = useState(false)

  function toggle(done) {
    setTaskDone(task.id, done)
    if (done) toast(`Completed “${truncate(task.text, 32)}”`, { action: { label: 'Undo', onClick: () => setTaskDone(task.id, false) } })
  }

  function moveToTomorrow() {
    const from = task.date || ''
    updateTask(task.id, { date: tomorrow })
    toast(`Moved “${truncate(task.text, 28)}” to tomorrow`, { action: { label: 'Undo', onClick: () => updateTask(task.id, { date: from }) } })
  }

  function archive() {
    archiveTask(task.id)
    toast(`Archived “${truncate(task.text, 30)}”`, { action: { label: 'Undo', onClick: () => restoreTask(task.id) } })
  }

  // ---- swipe ------------------------------------------------------------------------------------

  // Swipe states are data attributes, not classes, so React re-rendering className can't drop
  // them mid-animation: data-swiping (action layers shown, content movable), data-dragging (no
  // transition), data-armed (a release completes), data-full (a release archives).
  const flag = (name, on) => rowRef.current?.toggleAttribute(`data-${name}`, !!on)

  // Moves the row's content to x (px); animated unless a finger is on it.
  function slide(x) {
    const row = rowRef.current
    if (!row) return
    row.style.setProperty('--tr-x', `${x}px`)
    clearTimeout(settleTimer.current)
    if (x === 0) {
      // Keep the action layers until the content has slid back over them.
      settleTimer.current = setTimeout(() => {
        for (const name of ['swiping', 'armed', 'full']) row.removeAttribute(`data-${name}`)
        row.style.removeProperty('--tr-x')
      }, 340)
    }
  }

  function close() {
    if (openRow?.ref === rowRef) openRow = null
    setOpen(false)
    slide(0)
  }

  const closeOthers = () => {
    if (openRow && openRow.ref !== rowRef) openRow.close()
  }

  useEffect(() => () => {
    clearTimeout(settleTimer.current)
    if (openRow?.ref === rowRef) openRow = null
  }, [])

  // A row swiped open closes on the next tap anywhere else.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!rowRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (event) => {
    suppressClickUntil.current = 0
    if (!swipe || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (event.target.closest?.('.tr-trail')) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, base: open ? -openX : 0, offset: open ? -openX : 0, active: false, width: rowRef.current?.offsetWidth || 340 }
  }

  const onPointerMove = (event) => {
    const d = drag.current
    if (!d || d.id !== event.pointerId) return
    // A mouse released outside the row (before a swipe began) never sent pointerup here.
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      if (d.active) finishDrag(false)
      else drag.current = null
      return
    }
    const dx = event.clientX - d.x
    const dy = event.clientY - d.y
    const row = rowRef.current
    if (!d.active) {
      // A mostly vertical move is a scroll: let it be.
      if (Math.abs(dy) > DRAG_START && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        return
      }
      if (Math.abs(dx) < DRAG_START || Math.abs(dx) < Math.abs(dy) * 1.2) return
      d.active = true
      try {
        row?.setPointerCapture?.(event.pointerId)
      } catch {
        // capture is best-effort
      }
      clearTimeout(settleTimer.current)
      closeOthers()
      flag('swiping', true)
      flag('dragging', true)
      const focused = document.activeElement
      if (focused && row?.contains(focused)) focused.blur?.()
    }
    const raw = d.base + dx
    // Right: up to 60% of the row, with resistance past the commit point. Left: up to 92%.
    const commit = leadCommit(d.width)
    const offset = raw > commit ? commit + (raw - commit) * 0.45 : Math.max(-d.width * 0.92, raw)
    d.offset = Math.min(offset, d.width * 0.6)
    row?.style.setProperty('--tr-x', `${d.offset}px`)
    flag('armed', d.offset >= commit)
    flag('full', d.offset <= -d.width * FULL_SWIPE)
  }

  const finishDrag = (cancelled) => {
    const d = drag.current
    drag.current = null
    if (!d?.active) return
    suppressClickUntil.current = performance.now() + 400
    const row = rowRef.current
    flag('dragging', false)
    const offset = cancelled ? d.base : d.offset
    if (!cancelled && offset >= leadCommit(d.width)) {
      slide(0)
      setOpen(false)
      toggle(!task.done)
      return
    }
    if (!cancelled && offset <= -d.width * FULL_SWIPE) {
      // Slide it off, then archive (the row leaves the list).
      row?.style.setProperty('--tr-x', `${-d.width}px`)
      setTimeout(() => {
        archive()
        slide(0) // in case the row is still shown
      }, 160)
      return
    }
    if (offset < -openX / 2) {
      flag('armed', false)
      flag('full', false)
      row?.style.setProperty('--tr-x', `${-openX}px`)
      closeOthers()
      openRow = { ref: rowRef, close }
      setOpen(true)
    } else close()
  }

  const onClickCapture = (event) => {
    if (performance.now() < suppressClickUntil.current) {
      suppressClickUntil.current = 0
      event.preventDefault()
      event.stopPropagation()
      return
    }
    // While open, a tap on the row (not its buttons) just closes it.
    if (open && !event.target.closest?.('.tr-trail')) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  const act = (run) => () => {
    close()
    run()
  }

  return (
    <li
      ref={rowRef}
      className={`task-row ${swipe ? 'tr-row' : ''} ${open ? 'is-open' : ''} ${task.done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}
      onPointerDown={swipe ? onPointerDown : undefined}
      onPointerMove={swipe ? onPointerMove : undefined}
      onPointerUp={swipe ? () => finishDrag(false) : undefined}
      onPointerCancel={swipe ? () => finishDrag(true) : undefined}
      onClickCapture={swipe ? onClickCapture : undefined}
    >
      {swipe && (
        <span className={`tr-lead ${task.done ? 'is-reopen' : ''}`} aria-hidden="true">
          <Icon name={task.done ? 'undo' : 'check'} size={22} strokeWidth={2.6} />
        </span>
      )}
      {swipe && (
        <span className="tr-trail" aria-hidden={!open}>
          {canTomorrow && (
            <button type="button" className="tr-act tr-act-later" tabIndex={open ? 0 : -1} onClick={act(moveToTomorrow)} aria-label={`Move “${task.text}” to tomorrow`}>
              <Icon name="sunrise" size={18} />
              <span>Tomorrow</span>
            </button>
          )}
          <button type="button" className="tr-act tr-act-archive" tabIndex={open ? 0 : -1} onClick={act(archive)} aria-label={`Archive “${task.text}”`}>
            <Icon name="archive" size={18} />
            <span>Archive</span>
          </button>
        </span>
      )}
      <Checkbox checked={!!task.done} onChange={toggle} label={task.done ? `Mark “${task.text}” as not done` : `Complete “${task.text}”`} />
      <button type="button" className="task-body" onClick={() => onOpen?.(task)}>
        <span className="task-title">{task.text}</span>
        {details && <span className="task-notes">{details}</span>}
        {(showDate && task.date) || task.time || task.priority === 'urgent' || files > 0 ? (
          <span className="task-meta">
            {showDate && task.date && (
              <span className={`meta-chip ${overdue ? 'is-danger' : task.date === today ? 'is-accent' : ''}`}>
                <Icon name="calendar" size={13} />
                {overdue ? `Overdue · ${relativeDay(task.date, today)}` : relativeDay(task.date, today)}
              </span>
            )}
            {task.time && (
              <span className="meta-chip">
                <Icon name="clock" size={13} />
                {formatTime(task.time)}
              </span>
            )}
            {task.priority === 'urgent' && (
              <span className="meta-chip is-danger">
                <Icon name="flag" size={13} />
                Urgent
              </span>
            )}
            {files > 0 && (
              <span className="meta-chip tr-files" aria-label={`${files} attached ${files === 1 ? 'file' : 'files'}`} title={`${files} attached ${files === 1 ? 'file' : 'files'}`}>
                <Icon name="paperclip" size={13} />
                {files > 1 ? files : ''}
              </span>
            )}
          </span>
        ) : null}
      </button>
      {trailing && <span className="task-trailing">{trailing}</span>}
      {task.priority === 'low' && <span className="task-low" aria-label="Low priority" title="Low priority" />}
    </li>
  )
}

// How far right a swipe must go to complete the task.
const leadCommit = (width) => Math.min(96, width * 0.33)

function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}
