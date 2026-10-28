import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import Callout from './ui/Callout.jsx'
import { Button } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { imageToJpegDataUrl } from '../lib/media.js'
import { formatSeconds, useRecorder } from '../lib/recorder.js'
import { haptic } from '../lib/haptics.js'
import { readPref, writePref } from '../lib/api.js'
import { useNow } from '../lib/environment.js'
import { useAnimatedNumber } from '../lib/useAnimatedNumber.js'
import { proteinNudge } from '../lib/food/coach.js'
import { dayTotals, entryCalories, entryMeal, foodKey, recents } from '../lib/food/nutrition.js'
import { matchFoods, quickRow } from '../lib/food/shortcuts.js'
import { nowMeal as usualMealNow } from '../lib/food/mealTimes.js'
import { addEntries, dayEntries, estimateFood, setNudge, useFood, useFoodEntries, useMealTimes } from '../lib/food/state.js'
import { useStore } from '../lib/store.js'
import EstimateReview, { BARCODE_HINT, barcodeDigits, canAutoLog, logEstimate, prepareEstimate, reviewTotals } from '../pages/food/EstimateReview.jsx'
import MealShortcuts, { hasShortcuts, useMealShortcuts } from '../pages/food/MealShortcuts.jsx'
import { CameraChoice, quickLog } from '../pages/food/QuickAddBar.jsx'
import { Ring, ringState } from '../pages/food/ring.jsx'
import PhotoInput from '../pages/food/PhotoInput.jsx'
import { energyNumber, entryName, fmtEnergy, isSubmitKey, mealIdFor, unitLabel } from '../pages/food/format.js'
import './food-quick.css'

// Today-page food card: today's total against the goal with a tiny ring, and one line to log
// food by text, photo (of the food or of a barcode), a barcode number or voice. The AI estimate
// opens right here as an editable review with Save / Cancel (or logs straight away when
// "auto-log if sure" is on); items with "Save to My foods" on are saved there on Save too.
// Below the line, up to 3 one-tap chips for the meal of the moment (and "Same as <day>" while
// that meal is empty), hidden while an estimate is open. While typing (2+ letters), those chips
// make way for up to 3 matching foods from My foods and recent days: a tap logs the saved numbers
// at once (offline too) without asking the AI; Enter still estimates anything new.
// From 6 PM, when protein is well behind its goal, a nudge chip suggests something to close the gap:
// a saved or recent food logs on a tap (with Undo); a generic idea only fills the box (an AI
// estimate costs money, so it never sends by itself). × hides it for the day on this device.

const NUDGE_PREF = 'food.nudge.protein' // the day the protein nudge was hidden (this device)

function statusText(request) {
  if (request?.image && request.text === BARCODE_HINT) return 'Reading the barcode…'
  if (request && barcodeDigits(request.text) && !request.image && !request.audio) return 'Looking up the barcode…'
  if (request?.audio) return 'Listening and estimating…'
  if (request?.image) return 'Looking at your photo…'
  return 'Estimating…'
}

export default function FoodQuickCard({ today, loaded }) {
  const food = useFood()
  const entries = useFoodEntries()
  const offline = useStore((state) => state.offline)
  const { meals, energyUnit: unit, aiReview } = food.prefs
  const goal = food.goals.calories
  // The meal of the moment follows when the owner usually logs each meal (fixed windows until known).
  const mealTimes = useMealTimes()
  const defaultMeal = (list) => usualMealNow(list, mealTimes)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState('idle') // idle | estimating | review | error
  const [request, setRequest] = useState(null)
  const [review, setReview] = useState(null)
  const [error, setError] = useState('')
  const [meal, setMeal] = useState(() => defaultMeal(meals))
  const [preparing, setPreparing] = useState(false)
  const [fixing, setFixing] = useState(false) // a "Fix" request in the review is running
  const controllerRef = useRef(null)
  const fileRef = useRef(null)
  const inputRef = useRef(null)
  const photoMode = useRef('photo') // 'photo' | 'barcode': what the picked photo shows

  const todayRows = useMemo(() => dayEntries(entries, today, meals), [entries, today, meals])
  const totals = useMemo(() => dayTotals(todayRows), [todayRows])
  const eaten = totals.calories
  // The meal of the moment, for the one-tap chips.
  const nowMealId = defaultMeal(meals)
  const nowMeal = meals.find((item) => item.id === nowMealId) || meals[0]
  const nowMealEmpty = !todayRows.some((entry) => entryMeal(entry, meals) === nowMeal?.id)
  const shortcuts = useMealShortcuts({ entries, meal: nowMeal || { id: nowMealId }, date: today, today, meals, sameAs: nowMealEmpty })
  const ring = ringState(eaten, goal)
  const left = goal ? goal - eaten : null
  // The numbers count to their new value after logging (shown as is on first render).
  const shownEaten = useAnimatedNumber(eaten)
  const shownLeft = useAnimatedNumber(left ?? 0)

  // Foods you've had before that match what's typed: My foods first, then recent days.
  const recent = useMemo(() => recents(entries, today, { limit: 25 }), [entries, today])
  const query = text.trim()
  const matches = useMemo(
    () => (query.length >= 2 && !barcodeDigits(query) ? matchFoods(query, { favorites: food.favorites, recent, limit: 3 }) : []),
    [query, food.favorites, recent],
  )

  // The evening protein nudge (Food settings → Nudges).
  const now = useNow(60000)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const [nudgeHiddenOn, setNudgeHiddenOn] = useState(() => readPref(NUDGE_PREF, null))
  const nudgeOn = food.prefs.nudges?.protein !== false
  const nudge = useMemo(
    () => (loaded && nudgeOn && nudgeHiddenOn !== today
      ? proteinNudge({ goals: food.goals, totals, rowsToday: todayRows.length, nowMinutes, entries, favorites: food.favorites, today })
      : null),
    [loaded, nudgeOn, nudgeHiddenOn, today, food.goals, totals, todayRows.length, nowMinutes, entries, food.favorites],
  )

  useEffect(() => () => controllerRef.current?.abort(), [])

  const recorder = useRecorder({
    onAudio: (audio, mimeType) => run({ audio, mimeType, text: text.trim() || undefined, source: 'ai_voice' }),
  })
  useEffect(() => {
    if (!recorder.error) return
    setError(recorder.error)
    setPhase((current) => (current === 'idle' ? 'error' : current))
    recorder.clearError()
  }, [recorder.error]) // eslint-disable-line react-hooks/exhaustive-deps

  function run(next) {
    controllerRef.current?.abort()
    const startMeal = defaultMeal(meals)
    if (offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      if (next.text && !next.image && !next.audio && !barcodeDigits(next.text)) {
        addEntries([{ name: next.text.slice(0, 120), meal: startMeal, date: today, source: 'ai_text' }], {
          toastLabel: `You’re offline — saved “${next.text.slice(0, 32)}” without calories. Estimate it on the Food page later.`,
        })
        setText('')
        setPhase('idle')
      } else {
        setError(next.image || next.audio ? 'You’re offline — photos and voice need a connection.' : 'You’re offline — barcode lookups need a connection.')
        setRequest(null)
        setPhase('error')
      }
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setRequest(next)
    setReview(null)
    setError('')
    setMeal(startMeal)
    setPhase('estimating')
    estimateFood({ text: next.text, image: next.image, audio: next.audio, mimeType: next.mimeType, date: today, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        const prepared = prepareEstimate(result, next.text || result.transcript)
        const hint = prepared.items.find((item) => item.mealHint)?.mealHint
        const chosen = hint ? mealIdFor(hint, meals) : startMeal
        setMeal(chosen)
        if (aiReview === 'autoHigh' && canAutoLog(prepared)) {
          logEstimate({ review: prepared, meal: chosen, date: today, source: next.source, today, meals, unit })
          finish()
          return
        }
        setReview(prepared)
        setPhase('review')
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return
        setError(err?.message || 'Couldn’t estimate that right now.')
        setPhase('error')
      })
  }

  function finish() {
    controllerRef.current?.abort()
    controllerRef.current = null
    setPhase('idle')
    setReview(null)
    setRequest(null)
    setError('')
    setText('')
  }

  function submit(event) {
    event?.preventDefault()
    const words = text.trim()
    if (!words || phase === 'estimating') return
    run({ text: barcodeDigits(words) || words, source: 'ai_text' })
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
      run({ image, text: barcode ? BARCODE_HINT : text.trim() || undefined, source: 'ai_photo' })
    } catch (err) {
      toast(err?.message || 'Couldn’t use that photo.', { tone: 'error' })
    } finally {
      setPreparing(false)
    }
  }

  function save() {
    if (!review || !request || fixing) return
    if (logEstimate({ review, meal, date: today, source: request.source, today, meals, unit })) finish()
  }

  // Logs a matching food with its saved numbers into the meal of the moment (toast with Undo).
  function logMatch(item) {
    const undo = quickLog(item, { meal: defaultMeal(meals), date: today, favorites: food.favorites, meals, unit, today })
    if (!undo?.entries?.length) return
    haptic()
    setText('')
  }

  // A saved food logs at once; a generic idea fills the box and focuses it (never sends).
  function takeNudge() {
    const idea = nudge?.idea
    if (!idea) return
    if (idea.saved) {
      const undo = addEntries([quickRow(idea.template, { meal: defaultMeal(meals), date: today, favorites: food.favorites })], {
        toastLabel: `Logged ${entryName(idea.template)}`,
      })
      if (undo?.entries?.length) haptic('light')
      return
    }
    setText(idea.text)
    const input = inputRef.current
    if (input) {
      input.focus() // in the tap itself, so iOS opens the keyboard
      requestAnimationFrame(() => {
        try {
          input.setSelectionRange(input.value.length, input.value.length)
        } catch {
          // not a text input any more
        }
      })
    }
  }

  function hideNudge() {
    writePref(NUDGE_PREF, today)
    setNudgeHiddenOn(today)
    toast('Hidden for today', {
      action: {
        label: 'Turn off',
        onClick: () => {
          const undo = setNudge('protein', false)
          toast('Protein nudge turned off', { action: { label: 'Undo', onClick: undo } })
        },
      },
    })
  }

  function saveNameOnly() {
    const name = request?.text?.trim()
    if (!name || name === BARCODE_HINT || barcodeDigits(name)) return
    addEntries([{ name: name.slice(0, 120), meal, date: today, source: 'ai_text' }], { toastLabel: `Saved “${name.slice(0, 40)}” without calories` })
    finish()
  }

  const busy = phase === 'estimating'
  const reviewTotalsNow = review ? reviewTotals(review.items) : null
  const count = review?.items.length || 0
  const namedRequest = !!request?.text?.trim() && request.text !== BARCODE_HINT && !barcodeDigits(request.text)

  let summary
  if (!loaded) summary = <span className="skeleton fq-skel" aria-hidden="true" />
  else if (!totals.count) summary = <span className="fq-sum">{goal ? `${energyNumber(goal, unit)} ${unitLabel(unit)} to go` : 'Nothing logged yet'}</span>
  else {
    // Screen readers get the final numbers; the counting copy is for the eye only.
    const final = `${energyNumber(eaten, unit)} ${unitLabel(unit)}${goal ? ` · ${energyNumber(Math.abs(left), unit)} ${left < 0 ? 'over' : 'left'}` : ''}`
    summary = (
      <span className="fq-sum">
        <span className="sr-only">{final}</span>
        <span aria-hidden="true">
          <span className="num-display">{energyNumber(shownEaten, unit)}</span> {unitLabel(unit)}
          {goal ? <span className={left < 0 ? 'is-over' : ''}> · <span className="num-display">{energyNumber(Math.abs(shownLeft), unit)}</span> {left < 0 ? 'over' : 'left'}</span> : null}
        </span>
      </span>
    )
  }

  return (
    <section className="card fq-card" aria-labelledby="fq-title">
      {/* Like the Gym card: the whole header opens the area, with a chevron (no "See all" link). */}
      <a href="#/food" className="fq-head">
        <Ring size={40} stroke={4} progress={loaded ? ring.progress : 0} tone={ring.tone} className="fq-ring" intro={loaded ? `fq:${today}` : null} />
        <span className="fq-head-text">
          <h3 id="fq-title">Food</h3>
          {summary}
        </span>
        <Icon name="chevronRight" size={18} strokeWidth={2.2} className="fq-chevron" />
      </a>

      {recorder.recording ? (
        <div className="fq-bar is-recording">
          <button type="button" className="fq-btn" onClick={() => recorder.stop(true)} aria-label="Cancel recording">
            <Icon name="close" size={19} />
          </button>
          <div className="recorder">
            <span className="rec-dot" aria-hidden="true" />
            <span className="rec-time">{formatSeconds(recorder.seconds)}</span>
            <span className="waveform" aria-hidden="true">
              {recorder.levels.map((level, index) => <i key={index} style={{ transform: `scaleY(${level})` }} />)}
            </span>
          </div>
          <button type="button" className="fq-send" onClick={() => recorder.stop()} aria-label="Stop and estimate">
            <Icon name="send" size={19} strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        <form className="fq-bar" onSubmit={submit}>
          <input
            ref={inputRef}
            className="fq-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (isSubmitKey(event)) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder="What did you eat?"
            aria-label="What did you eat? You can also type a barcode number."
            enterKeyHint="send"
            autoComplete="off"
            maxLength={1000}
            disabled={busy}
          />
          <CameraChoice buttonClass="fq-btn" iconSize={20} placement="down" disabled={busy} preparing={preparing} onPick={pickPhoto} />
          {text.trim() ? (
            <button type="submit" className="fq-send" disabled={busy} aria-label="Estimate">
              <Icon name="send" size={19} strokeWidth={2.2} />
            </button>
          ) : recorder.supported ? (
            <button type="button" className="fq-btn is-mic" onClick={recorder.start} disabled={busy} aria-label="Describe it by voice">
              <Icon name="mic" size={20} />
            </button>
          ) : null}
        </form>
      )}
      <PhotoInput inputRef={fileRef} onChange={onPhoto} />

      {nudge && phase === 'idle' && !text && !recorder.recording && (
        <div className="fq-nudge">
          {nudge.idea ? (
            <button
              type="button"
              className="fq-nudge-main"
              onClick={takeNudge}
              aria-label={`${nudge.leftG} g protein to go. ${nudge.idea.saved ? `Log ${nudge.idea.name}` : `Type ${nudge.idea.name} in the food box`}`}
            >
              <Icon name="target" size={16} />
              <span><strong>{nudge.leftG} g protein to go</strong> · e.g. {nudge.idea.name}</span>
            </button>
          ) : (
            <span className="fq-nudge-main is-static">
              <Icon name="target" size={16} />
              <span><strong>{nudge.leftG} g protein to go</strong></span>
            </span>
          )}
          <button type="button" className="fq-nudge-x" onClick={hideNudge} aria-label="Hide the protein nudge for today">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {loaded && phase === 'idle' && !recorder.recording && matches.length > 0 && (
        <div className="fq-shortcuts">
          <span className="fq-shortcuts-label" aria-hidden="true">You’ve had</span>
          <div className="food-chips" role="group" aria-label="Log a food you’ve had before">
            {matches.map((item) => {
              const kcal = entryCalories(item)
              return (
                <button
                  key={item.id || foodKey(item.name, item.brand)}
                  type="button"
                  className="food-suggest"
                  onClick={() => logMatch(item)}
                  aria-label={`Log ${entryName(item)}${kcal ? `, ${fmtEnergy(kcal, unit)}` : ''}`}
                >
                  <Icon name={item.aliases ? 'star' : 'plus'} size={14} strokeWidth={2.4} />
                  <span>{entryName(item)}</span>
                  {kcal > 0 && <small className="food-suggest-kcal" aria-hidden="true">{energyNumber(kcal, unit)}</small>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {loaded && phase === 'idle' && !recorder.recording && !matches.length && nowMeal && hasShortcuts(shortcuts) && (
        <div className="fq-shortcuts">
          <span className="fq-shortcuts-label" aria-hidden="true">{nowMeal.name}</span>
          <MealShortcuts shortcuts={shortcuts} meal={nowMeal} date={today} today={today} food={food} />
        </div>
      )}

      {phase === 'estimating' && (
        <div className="fq-panel" aria-busy="true">
          <p className="fq-status" role="status">
            <span className="spinner" aria-hidden="true" />
            {statusText(request)}
            <button type="button" className="fq-link" onClick={finish}>Cancel</button>
          </p>
          <div className="food-est-skel" aria-hidden="true">
            <div className="food-est-skel-row"><span className="skeleton" /><span className="skeleton" /></div>
            <div className="food-est-skel-row"><span className="skeleton" /><span className="skeleton" /></div>
          </div>
        </div>
      )}

      {phase === 'review' && review && (
        <div className="fq-panel">
          {request?.image && <img className="fq-thumb" src={request.image} alt="Your photo" />}
          <EstimateReview compact result={review} onChange={setReview} meal={meal} onMealChange={setMeal} date={today} meals={meals} onBusyChange={setFixing} />
          <div className="fq-actions">
            <Button variant="secondary" onClick={finish}>Cancel</Button>
            <Button className="btn-grow" icon="check" onClick={save} disabled={!count || fixing}>
              {count ? `Save · ${energyNumber(reviewTotalsNow.calories, unit)} ${unitLabel(unit)}` : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="fq-panel">
          <Callout tone="danger" role="alert">{error}</Callout>
          <div className="fq-actions is-wrap">
            {namedRequest && <Button variant="secondary" size="sm" icon="note" onClick={saveNameOnly}>Save without calories</Button>}
            {request && <Button variant="secondary" size="sm" icon="refresh" onClick={() => run(request)}>Try again</Button>}
            <Button variant="ghost" size="sm" onClick={finish}>Close</Button>
          </div>
        </div>
      )}
    </section>
  )
}
