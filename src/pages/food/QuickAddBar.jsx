import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import { Segmented } from '../../components/ui/primitives.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { nowTimeHHMM } from '../../lib/dates.js'
import { imageToJpegDataUrl } from '../../lib/media.js'
import { entryCalories, findFavorite, foodKey, recents, suggestions } from '../../lib/food/nutrition.js'
import { addEntries } from '../../lib/food/state.js'
import { formatSeconds, useRecorder } from '../../lib/recorder.js'
import { BARCODE_HINT, FoodGlyph, MealSelect, barcodeDigits } from './EstimateReview.jsx'
import PhotoInput from './PhotoInput.jsx'
import { dayLabel, energyNumber, entryName, isSubmitKey, mealName, mealTime, portionText, unitLabel } from './format.js'
import '../../components/food-quick.css'

// The Food page's quick-add bar, pinned above the tab bar: describe food (Enter runs the AI
// estimate; a barcode number is looked up), a photo (of the food or of a barcode), or a voice
// note. Focusing it opens a tray above with Suggested · Recent · Favorites (one tap logs, with
// Undo), a meal picker, and links to manual entry / quick calories. While typing, the tray shows
// matching foods you've logged or saved before (a barcode number matches saved barcodes).

// The camera button: a small menu with "Photo of food" and "Scan barcode" (both open the same
// hidden photo picker; call it inside the tap so iOS allows it). onPick('photo' | 'barcode').
// placement: 'up' (menu above the button) or 'down'.
export function CameraChoice({ onPick, onOpen, disabled = false, preparing = false, buttonClass, iconSize = 20, placement = 'up' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
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
        onClick={() => setOpen((value) => {
          if (!value) onOpen?.()
          return !value
        })}
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
  { id: 'favorites', label: 'Favorites' },
]

// Logs a recent, suggestion or favorite with its last portion. Returns the undo.
export function quickLog(template, { meal, date, favorites, meals, unit, today }) {
  const favorite = template.aliases ? template : findFavorite(favorites, template)
  const { id, key, lastDate, count, score, aliases, updatedAt, ...rest } = template // eslint-disable-line no-unused-vars
  const row = { ...rest, meal, date, source: favorite ? 'favorite' : 'recent', favoriteId: favorite?.id ?? null }
  const kcal = entryCalories(template)
  const energy = kcal > 0 ? ` · ${energyNumber(kcal, unit)} ${unitLabel(unit)}` : ''
  const where = date === today ? mealName(meals, meal) : `${mealName(meals, meal)}, ${dayLabel(date, today)}`
  return addEntries([row], { toastLabel: `Logged ${entryName(template)} to ${where}${energy}` })
}

// controlRef.current.open() focuses the field and opens the tray (call it inside a tap so iOS
// shows the keyboard).
export default function QuickAddBar({ date, today, meal, mealChosen = false, onMealChange, entries, food, controlRef, onEstimate, onManual }) {
  const { meals, energyUnit: unit } = food.prefs
  const [text, setText] = useState('')
  const [trayOpen, setTrayOpen] = useState(false)
  const [tab, setTab] = useState('suggested')
  const [preparing, setPreparing] = useState(false)
  const dockRef = useRef(null)
  const fileRef = useRef(null)
  const photoMode = useRef('photo') // 'photo' | 'barcode': what the picked photo shows
  const input = useRef(null)

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
  }, [recorder.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // The tray closes on a tap outside the bar, or Escape.
  useEffect(() => {
    if (!trayOpen) return undefined
    const onDown = (event) => {
      if (!dockRef.current?.contains(event.target)) setTrayOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setTrayOpen(false)
        input.current?.blur()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [trayOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const query = text.trim().toLowerCase()
  const code = barcodeDigits(text)
  const lists = useMemo(() => {
    if (!trayOpen) return null
    const hhmm = date === today ? nowTimeHHMM() : mealTime(meal)
    const recent = recents(entries, today, { limit: 25 })
    const favorites = food.favorites
    let matches = []
    if (query) {
      const seen = new Set()
      for (const item of [...favorites, ...recent]) {
        const key = foodKey(item.name, item.brand)
        if (!key || seen.has(key)) continue
        const haystack = [item.name, item.brand, item.barcode, ...(item.aliases || [])].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(code || query)) continue
        seen.add(key)
        matches.push(item)
        if (matches.length >= 6) break
      }
    }
    return {
      suggested: suggestions(entries, meal, hhmm, today, 8),
      recent,
      favorites,
      matches,
    }
  }, [trayOpen, entries, food.favorites, meal, date, today, query, code])

  function log(template) {
    quickLog(template, { meal, date, favorites: food.favorites, meals, unit, today })
    setText('')
    setTrayOpen(false)
    input.current?.blur()
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
    if (!file) return
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
    } finally {
      setPreparing(false)
    }
  }

  const list = !lists ? [] : query ? lists.matches : lists[tab] || []
  const emptyText = {
    suggested: 'Foods you log often at this time show up here.',
    recent: 'Foods you’ve logged in the last 90 days show up here.',
    favorites: 'Tap the star when adding a food to keep it here. Labels, barcodes and web lookups you save show up here too.',
  }[tab]

  return (
    <div className={`food-dock${trayOpen ? ' has-tray' : ''}`} ref={dockRef}>
      {trayOpen && (
        <div className="food-tray" role="dialog" aria-label="Quick add">
          <div className="food-tray-head">
            <span className="food-tray-to">Add to</span>
            <MealSelect meals={meals} value={meal} onChange={onMealChange} />
            <span className="food-tray-links">
              <button type="button" className="food-tray-link" onClick={() => { setTrayOpen(false); onManual({ name: text.trim() }) }}>Manual entry</button>
              <button type="button" className="food-tray-link" onClick={() => { setTrayOpen(false); onManual({ quick: true }) }}>Quick calories</button>
            </span>
          </div>
          {!query && <Segmented options={TABS} value={tab} onChange={setTab} label="Quick add lists" className="food-tray-tabs" />}
          <ul className="food-tray-list">
            {query && (
              <li>
                <button type="button" className="food-tray-row is-ai" onClick={submit}>
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
              return (
                <li key={item.id || item.key || foodKey(item.name, item.brand)}>
                  <button type="button" className="food-tray-row" onClick={() => log(item)}>
                    <span className="food-tray-text">
                      <span className="food-tray-name">{entryName(item)}</span>
                      {(portion || item.brand) && <span className="food-tray-sub">{[portion, item.brand].filter(Boolean).join(' · ')}</span>}
                    </span>
                    <span className="food-tray-kcal">{kcal > 0 ? energyNumber(kcal, unit) : '—'}</span>
                    <span className="food-tray-plus" aria-hidden="true"><Icon name="plus" size={16} strokeWidth={2.4} /></span>
                  </button>
                </li>
              )
            })}
            {!query && list.length === 0 && <li className="food-tray-empty">{emptyText}</li>}
            {query && list.length === 0 && <li className="food-tray-empty">{code ? 'Not saved in My foods yet — tap above to look it up.' : 'Nothing logged before matches — tap above to estimate it.'}</li>}
          </ul>
        </div>
      )}

      {recorder.recording ? (
        <div className="food-bar is-recording">
          <button type="button" className="food-bar-btn" onClick={() => recorder.stop(true)} aria-label="Cancel recording">
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
            placeholder={mealChosen ? `Add to ${mealName(meals, meal).toLowerCase()}…` : 'Describe food or a barcode…'}
            aria-label="Describe what you ate, or type a barcode number"
            enterKeyHint="send"
            autoComplete="off"
            maxLength={1000}
          />
          <CameraChoice buttonClass="food-bar-btn" iconSize={21} preparing={preparing} onPick={pickPhoto} onOpen={() => setTrayOpen(false)} />
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

