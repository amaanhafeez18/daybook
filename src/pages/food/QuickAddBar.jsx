import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Segmented } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { nowTimeHHMM } from '../../lib/dates.js'
import { imageToJpegDataUrl } from '../../lib/media.js'
import { entryCalories, findFavorite, foodKey, recents, suggestions } from '../../lib/food/nutrition.js'
import { addedSummary } from '../../lib/food/shortcuts.js'
import { addEntries } from '../../lib/food/state.js'
import { formatSeconds, useRecorder } from '../../lib/recorder.js'
import { BARCODE_HINT, FoodGlyph, MealSelect, barcodeDigits } from './EstimateReview.jsx'
import PhotoInput from './PhotoInput.jsx'
import { dayLabel, energyNumber, entryName, isSubmitKey, mealName, mealTime, plural, portionText, unitLabel } from './format.js'
import '../../components/food-quick.css'

// The Food page's quick-add bar, pinned above the tab bar: describe food (Enter runs the AI
// estimate; a barcode number is looked up), a photo (of the food or of a barcode), or a voice
// note. Focusing it opens a tray above with a meal picker and Suggested · Recent · My foods, then
// "Add by hand" / "Quick calories" at the bottom of the list. One tap logs a food and the tray
// stays open for the next ("Added ✓"; tap again to take it back out); closing it shows one toast
// for everything added, with "Undo all". While typing, the tray shows matching foods you've
// logged or saved before (a barcode number matches saved barcodes).

// The camera button: a small menu with "Photo of food" and "Scan barcode" (both open the same
// hidden photo picker; call it inside the tap so iOS allows it). onPick('photo' | 'barcode').
// placement: 'up' (menu above the button) or 'down'. onClose(target): the menu was put away
// without a pick (target: what a tap outside it landed on, else null).
export function CameraChoice({ onPick, onOpen, onClose, disabled = false, preparing = false, buttonClass, iconSize = 20, placement = 'up' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (ref.current?.contains(event.target)) return
      setOpen(false)
      closeRef.current?.(event.target)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        closeRef.current?.(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const pick = (mode) => {
    setOpen(false)
    onPick(mode)
  }
  return (
    <span className="food-cam" ref={ref}>
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          if (open) onClose?.(null)
          else onOpen?.()
          setOpen(!open)
        }}
        disabled={disabled || preparing}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add a photo of your food or scan a barcode"
      >
        {preparing ? <span className="spinner" aria-hidden="true" /> : <Icon name="camera" size={iconSize} />}
      </button>
      {open && (
        <span className={`food-cam-menu is-${placement === 'down' ? 'down' : 'up'}`} role="menu">
          <button type="button" role="menuitem" onClick={() => pick('photo')}>
            <Icon name="camera" size={19} />
            <span>Photo of food</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick('barcode')}>
            <FoodGlyph name="barcode" size={19} />
            <span className="food-cam-text">Scan barcode<small>Or type the number</small></span>
          </button>
        </span>
      )}
    </span>
  )
}

const TABS = [
  { id: 'suggested', label: 'Suggested' },
  { id: 'recent', label: 'Recent' },
  { id: 'favorites', label: 'My foods' },
]

// The row to log for a recent, suggestion or favorite (its last portion).
function quickRow(template, { meal, date, favorites }) {
  const favorite = template.aliases ? template : findFavorite(favorites, template)
  const { id, key, lastDate, count, score, aliases, updatedAt, ...rest } = template // eslint-disable-line no-unused-vars
  return { ...rest, meal, date, source: favorite ? 'favorite' : 'recent', favoriteId: favorite?.id ?? null }
}

// "Breakfast", or "Breakfast, Yesterday" on another day; without a meal just the day (or '').
function whereText(meals, meal, date, today) {
  const day = date && date !== today ? dayLabel(date, today) : ''
  return [meal ? mealName(meals, meal) : '', day].filter(Boolean).join(', ')
}

const energyTail = (kcal, unit) => (kcal > 0 ? ` · ${energyNumber(kcal, unit)} ${unitLabel(unit)}` : '')

// Logs a recent, suggestion or favorite with its last portion, with an Undo toast. Returns the undo.
export function quickLog(template, { meal, date, favorites, meals, unit, today }) {
  const row = quickRow(template, { meal, date, favorites })
  return addEntries([row], { toastLabel: `Logged ${entryName(template)} to ${whereText(meals, meal, date, today)}${energyTail(entryCalories(template), unit)}` })
}

// While the tray is open on a phone, its height follows the room the keyboard leaves above the
// bar (so 3–4 rows show): --food-tray-room on the dock, read by food.css.
function useTrayRoom(dockRef, open) {
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null
    const dock = dockRef.current
    if (!open || !viewport || !dock) return undefined
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bar = dock.querySelector('.food-bar')
        if (!bar) return
        // From the top of what's visible (below the title bar) down to the bar, less the gaps.
        const topbar = document.querySelector('.topbar')?.getBoundingClientRect()
        const top = Math.max(viewport.offsetTop + 12, topbar && topbar.bottom > 0 ? topbar.bottom + 8 : 0)
        const room = bar.getBoundingClientRect().top - 8 - top
        dock.style.setProperty('--food-tray-room', `${Math.round(Math.min(440, Math.max(200, room)))}px`)
      })
    }
    measure()
    viewport.addEventListener('resize', measure)
    viewport.addEventListener('scroll', measure)
    dock.addEventListener('focusin', measure)
    dock.addEventListener('focusout', measure)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', measure)
      viewport.removeEventListener('scroll', measure)
      dock.removeEventListener('focusin', measure)
      dock.removeEventListener('focusout', measure)
      dock.style.removeProperty('--food-tray-room')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}

// A tap on a tray row keeps the keyboard up (the field keeps its focus).
const keepFocus = (event) => event.preventDefault()

// controlRef.current.open() focuses the field and opens the tray (call it inside a tap so iOS
// shows the keyboard). onDismiss: the tray was put away without adding anything more (Done, a tap
// outside, Escape, or the camera or microphone it made way for ended without an estimate), e.g.
// to forget a meal chosen for it.
export default function QuickAddBar({ date, today, meal, mealChosen = false, onMealChange, onDismiss, entries, food, controlRef, onEstimate, onManual }) {
  const { meals, energyUnit: unit } = food.prefs
  const [text, setText] = useState('')
  const [trayOpen, setTrayOpen] = useState(false)
  const [tab, setTab] = useState('suggested')
  const [preparing, setPreparing] = useState(false)
  // Foods logged since the tray opened: [{ key, undo, kcal, name, meal, date }].
  const [added, setAdded] = useState([])
  const addedRef = useRef(added)
  const dockRef = useRef(null)
  const fileRef = useRef(null)
  const photoMode = useRef('photo') // 'photo' | 'barcode': what the picked photo shows
  const input = useRef(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useImperativeHandle(controlRef, () => ({
    open() {
      input.current?.focus()
      setTrayOpen(true)
    },
  }), [])

  const recorder = useRecorder({
    onAudio: (audio, mimeType) => {
      onEstimate({ audio, mimeType, text: text.trim() || undefined, source: 'ai_voice' })
      setText('')
    },
  })

  useEffect(() => {
    if (!recorder.error) return
    toast(recorder.error, { tone: 'error' })
    recorder.clearError()
    dismissRef.current?.() // no estimate is coming from this recording
  }, [recorder.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // The photo picker was closed without a photo: no estimate is coming either.
  useEffect(() => {
    const node = fileRef.current
    if (!node) return undefined
    const onCancel = () => dismissRef.current?.()
    node.addEventListener('cancel', onCancel)
    return () => node.removeEventListener('cancel', onCancel)
  }, [])

  useTrayRoom(dockRef, trayOpen)

  function setAddedList(next) {
    addedRef.current = next
    setAdded(next)
  }

  // When the tray closes: one toast for everything added while it was open, with Undo all.
  function flushAdded() {
    const items = addedRef.current
    if (!items.length) return
    setAddedList([])
    const { count, kcal, meal: oneMeal, date: oneDate } = addedSummary(items)
    const where = whereText(meals, oneMeal, oneDate, today)
    toast(`Logged ${count === 1 ? items[0].name : plural(count, 'item')}${where ? ` to ${where}` : ''}${energyTail(kcal, unit)}`, {
      action: { label: count === 1 ? 'Undo' : 'Undo all', onClick: () => items.forEach((item) => item.undo()) },
      duration: 7000,
    })
  }

  const flushRef = useRef(flushAdded)
  flushRef.current = flushAdded
  useEffect(() => {
    if (!trayOpen) flushRef.current()
  }, [trayOpen])
  // Leaving the page with the tray open still says what was logged.
  useEffect(() => () => flushRef.current(), [])

  // The tray closes on a tap outside the bar, or Escape.
  useEffect(() => {
    if (!trayOpen) return undefined
    const onDown = (event) => {
      if (dockRef.current?.contains(event.target)) return
      setTrayOpen(false)
      dismissRef.current?.()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setTrayOpen(false)
        input.current?.blur()
        dismissRef.current?.()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [trayOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Once something has been added, the lists hold still until the tray closes, so logging one
  // food doesn't move the next one out from under your finger.
  const listEntries = useRef(entries)
  if (!trayOpen || !added.length) listEntries.current = entries
  const shownEntries = listEntries.current

  const query = text.trim().toLowerCase()
  const code = barcodeDigits(text)
  // Recent and Suggested don't depend on what's typed: worked out once per tray, not per keystroke.
  const quickLists = useMemo(() => {
    if (!trayOpen) return null
    const hhmm = date === today ? nowTimeHHMM() : mealTime(meal)
    return {
      suggested: suggestions(shownEntries, meal, hhmm, today, 8),
      recent: recents(shownEntries, today, { limit: 25 }),
    }
  }, [trayOpen, shownEntries, meal, date, today])
  const lists = useMemo(() => {
    if (!quickLists) return null
    const favorites = food.favorites
    let matches = []
    if (query) {
      const seen = new Set()
      for (const item of [...favorites, ...quickLists.recent]) {
        const key = foodKey(item.name, item.brand)
        if (!key || seen.has(key)) continue
        const haystack = [item.name, item.brand, item.barcode, ...(item.aliases || [])].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(code || query)) continue
        seen.add(key)
        matches.push(item)
        if (matches.length >= 6) break
      }
    }
    return { ...quickLists, favorites, matches }
  }, [quickLists, food.favorites, query, code])

  const foodId = (item) => foodKey(item.name, item.brand)
  // "Added" is per meal and day: after switching "Add to", the same food can be added there too.
  const addedId = (item) => `${meal}|${date}|${foodId(item)}`

  // Logs a food and keeps the tray open for the next; a food added already (to this meal) comes
  // back out.
  function toggle(template) {
    const key = addedId(template)
    const done = addedRef.current.find((item) => item.key === key)
    if (done) {
      done.undo()
      setAddedList(addedRef.current.filter((item) => item !== done))
      return
    }
    const undo = addEntries([quickRow(template, { meal, date, favorites: food.favorites })])
    if (!undo.entries.length) return
    setAddedList([...addedRef.current, { key, undo, kcal: entryCalories(template), name: entryName(template), meal, date }])
    setText('')
  }

  function closeTray() {
    setTrayOpen(false)
    input.current?.blur()
    onDismiss?.()
  }

  function manual(defaults) {
    setTrayOpen(false)
    onManual(defaults)
  }

  function submit(event) {
    event?.preventDefault()
    const words = text.trim()
    if (!words) return
    const digits = barcodeDigits(words)
    // A barcode can't be kept as a name to estimate later.
    if (digits && typeof navigator !== 'undefined' && navigator.onLine === false) {
      toast('You’re offline — barcode lookups need a connection.', { tone: 'error' })
      return
    }
    onEstimate({ text: digits || words, source: 'ai_text' })
    setText('')
    setTrayOpen(false)
    input.current?.blur()
  }

  function pickPhoto(mode) {
    photoMode.current = mode
    fileRef.current?.click()
  }

  async function onPhoto(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      dismissRef.current?.()
      return
    }
    const barcode = photoMode.current === 'barcode'
    photoMode.current = 'photo'
    setPreparing(true)
    try {
      // Barcodes need the detail: a larger, sharper image.
      const image = await imageToJpegDataUrl(file, barcode ? { maxDim: 1600, quality: 0.85 } : { maxDim: 1280, quality: 0.72 })
      onEstimate({ image, text: barcode ? BARCODE_HINT : text.trim() || undefined, source: 'ai_photo' })
      setText('')
      setTrayOpen(false)
    } catch (error) {
      toast(error?.message || 'Couldn’t use that photo.', { tone: 'error' })
      dismissRef.current?.()
    } finally {
      setPreparing(false)
    }
  }

  const list = !lists ? [] : query ? lists.matches : lists[tab] || []
  const addedKeys = new Set(added.map((item) => item.key))
  const addedTotal = addedSummary(added)
  const emptyText = {
    suggested: 'Foods you log often at this time show up here.',
    recent: 'Foods you’ve logged in the last 90 days show up here.',
    favorites: 'Foods you save show up here: tap the star on a food, or keep a label, barcode or web lookup when you log it.',
  }[tab]

  return (
    <div className={`food-dock${trayOpen ? ' has-tray' : ''}`} ref={dockRef}>
      {trayOpen && (
        <div className="food-tray" role="dialog" aria-label="Quick add">
          {/* A tap on the tabs keeps the keyboard up, like the rows (the meal picker is a select,
              which needs the focus to open). */}
          <div className={`food-tray-head${query ? ' is-search' : ''}`} onMouseDown={(event) => { if (!event.target.closest?.('.food-pick')) keepFocus(event) }}>
            <span className="food-tray-to">Add to</span>
            <MealSelect meals={meals} value={meal} onChange={onMealChange} className="food-tray-meal" />
            {!query && <Segmented options={TABS} value={tab} onChange={setTab} label="Quick add lists" className="food-tray-tabs" />}
          </div>
          <ul className="food-tray-list">
            {query && (
              <li>
                <button type="button" className="food-tray-row is-ai" onMouseDown={keepFocus} onClick={submit}>
                  <span className="food-tray-icon">{code ? <FoodGlyph name="barcode" size={17} /> : <Icon name="sparkles" size={17} />}</span>
                  <span className="food-tray-text">
                    <span className="food-tray-name">{code ? `Look up barcode ${code}` : `Estimate “${text.trim()}”`}</span>
                    <span className="food-tray-sub">{code ? 'Open Food Facts, then you confirm' : 'AI estimate you can review'}</span>
                  </span>
                  <Icon name="arrowRight" size={17} />
                </button>
              </li>
            )}
            {list.map((item) => {
              const kcal = entryCalories(item)
              const portion = portionText(item)
              const isAdded = addedKeys.has(addedId(item))
              return (
                <li key={item.id || item.key || foodId(item)}>
                  <button type="button" className={`food-tray-row${isAdded ? ' is-added' : ''}`} aria-pressed={isAdded} onMouseDown={keepFocus} onClick={() => toggle(item)}>
                    <span className="food-tray-text">
                      <span className="food-tray-name">{entryName(item)}</span>
                      {(portion || item.brand) && <span className="food-tray-sub">{[portion, item.brand].filter(Boolean).join(' · ')}</span>}
                    </span>
                    <span className="food-tray-kcal">{kcal > 0 ? energyNumber(kcal, unit) : '—'}</span>
                    {isAdded ? (
                      <span className="food-tray-added">Added<Icon name="check" size={14} strokeWidth={2.6} /></span>
                    ) : (
                      <span className="food-tray-plus" aria-hidden="true"><Icon name="plus" size={16} strokeWidth={2.4} /></span>
                    )}
                  </button>
                </li>
              )
            })}
            {!query && list.length === 0 && <li className="food-tray-empty">{emptyText}</li>}
            {query && list.length === 0 && <li className="food-tray-empty">{code ? 'Not saved in My foods yet — tap above to look it up.' : 'Nothing logged before matches — tap above to estimate it.'}</li>}
            <li className="food-tray-more">
              <button type="button" className="food-tray-row is-link" onClick={() => manual({ name: text.trim() })}>
                <span className="food-tray-icon is-soft" aria-hidden="true"><Icon name="pencil" size={15} /></span>
                <span className="food-tray-text">
                  <span className="food-tray-name">Add by hand</span>
                  <span className="food-tray-sub">Name, portion and nutrition</span>
                </span>
                <Icon name="chevronRight" size={17} />
              </button>
            </li>
            <li>
              <button type="button" className="food-tray-row is-link" onClick={() => manual({ quick: true })}>
                <span className="food-tray-icon is-soft" aria-hidden="true"><Icon name="zap" size={15} /></span>
                <span className="food-tray-text">
                  <span className="food-tray-name">Quick calories</span>
                  <span className="food-tray-sub">Just a number</span>
                </span>
                <Icon name="chevronRight" size={17} />
              </button>
            </li>
          </ul>
          {added.length > 0 && (
            <div className="food-tray-foot">
              <span className="food-tray-count" role="status">
                {addedTotal.count} added{addedTotal.kcal > 0 ? ` · ${energyNumber(addedTotal.kcal, unit)} ${unitLabel(unit)}` : ''}
              </span>
              <button type="button" className="food-tray-done" onClick={closeTray}>Done</button>
            </div>
          )}
        </div>
      )}

      {recorder.recording ? (
        <div className="food-bar is-recording">
          <button type="button" className="food-bar-btn" onClick={() => { recorder.stop(true); dismissRef.current?.() }} aria-label="Cancel recording">
            <Icon name="close" size={20} />
          </button>
          <div className="recorder">
            <span className="rec-dot" aria-hidden="true" />
            <span className="rec-time">{formatSeconds(recorder.seconds)}</span>
            <span className="waveform" aria-hidden="true">
              {recorder.levels.map((level, index) => <i key={index} style={{ transform: `scaleY(${level})` }} />)}
            </span>
          </div>
          <button type="button" className="food-bar-send" onClick={() => recorder.stop()} aria-label="Stop and estimate">
            <Icon name="send" size={20} strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        <form className="food-bar" onSubmit={submit}>
          <Icon name="utensils" size={19} className="food-bar-icon" />
          <input
            ref={input}
            className="food-bar-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitKey(event)) {
                event.preventDefault()
                submit()
              }
            }}
            onFocus={() => setTrayOpen(true)}
            // iOS can close the tray (a touch outside that turned into a scroll) without the field
            // losing focus; tapping it then fires no focus event, so a tap opens it too.
            onClick={() => setTrayOpen(true)}
            placeholder="What did you eat?"
            aria-label={`What did you eat${mealChosen ? ` for ${mealName(meals, meal).toLowerCase()}` : ''}? You can also type a barcode number.`}
            enterKeyHint="send"
            autoComplete="off"
            maxLength={1000}
          />
          {/* The camera menu put away without a pick ends the add, unless the tap was back on the bar. */}
          <CameraChoice
            buttonClass="food-bar-btn"
            iconSize={21}
            preparing={preparing}
            onPick={pickPhoto}
            onOpen={() => setTrayOpen(false)}
            onClose={(target) => { if (!dockRef.current?.contains(target)) dismissRef.current?.() }}
          />
          {text.trim() ? (
            <button type="submit" className="food-bar-send" aria-label="Estimate">
              <Icon name="send" size={20} strokeWidth={2.2} />
            </button>
          ) : recorder.supported ? (
            <button type="button" className="food-bar-btn is-mic" onClick={() => { setTrayOpen(false); recorder.start() }} aria-label="Describe it by voice">
              <Icon name="mic" size={21} />
            </button>
          ) : null}
        </form>
      )}
      <PhotoInput inputRef={fileRef} onChange={onPhoto} />
    </div>
  )
}

