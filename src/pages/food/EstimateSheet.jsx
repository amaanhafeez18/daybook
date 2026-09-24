import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { isISODate } from '../../lib/dates.js'
import { addEntries, estimateFood, useFood } from '../../lib/food/state.js'
import EstimateReview, { BARCODE_HINT, MealSelect, barcodeDigits, canAutoLog, logEstimate, prepareEstimate, reviewTotals } from './EstimateReview.jsx'
import { dayLabel, defaultMeal, energyNumber, mealIdFor, openDatePicker, unitLabel } from './format.js'

// The AI confirm card as a sheet: meal and day pickers, the review, and "Log N items · 297 kcal".
// request: { key, text?, image?, audio?, mimeType?, source, meal?, date, replace? (a name-only
// entry the estimate replaces) }. Text of only digits is a barcode lookup; a photo with the text
// 'barcode' is a photo of one. Nothing is saved until Log (or auto-log, when enabled); items with
// "Save to My foods" on are saved there on Log too.

function loadingText(request) {
  if (request.image && request.text === BARCODE_HINT) return 'Reading the barcode…'
  if (barcodeDigits(request.text) && !request.image && !request.audio) return 'Looking up the barcode…'
  if (request.audio) return 'Listening and estimating…'
  if (request.image) return 'Looking at your photo…'
  return 'Estimating…'
}

export default function EstimateSheet({ request, onClose, onManual, today }) {
  const food = useFood()
  const { meals, energyUnit: unit, aiReview } = food.prefs
  const [phase, setPhase] = useState('loading') // loading | ready | error
  const [review, setReview] = useState(null)
  const [error, setError] = useState(null)
  const [meal, setMeal] = useState(() => mealIdFor(request?.meal || defaultMeal(meals), meals))
  const [date, setDate] = useState(request?.date || today)
  const [run, setRun] = useState(0)
  const [fixing, setFixing] = useState(false) // a "Fix" request in the review is running
  const controllerRef = useRef(null)
  const lastRequest = useRef(request)
  if (request) lastRequest.current = request
  const shown = request || lastRequest.current // keeps the content while the sheet slides away
  const open = !!request

  // Each new request (or "Try again") starts a fresh estimate.
  useEffect(() => {
    if (!request) return undefined
    const controller = new AbortController()
    controllerRef.current = controller
    setPhase('loading')
    setReview(null)
    setError(null)
    const startMeal = mealIdFor(request.meal || defaultMeal(meals), meals)
    setMeal(startMeal)
    setDate(isISODate(request.date) ? request.date : today)
    estimateFood({ text: request.text, image: request.image, audio: request.audio, mimeType: request.mimeType, meal: request.meal || undefined, date: request.date, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        const prepared = prepareEstimate(result, request.text || result.transcript)
        const hint = !request.meal && prepared.items.find((item) => item.mealHint)?.mealHint
        const chosenMeal = hint ? mealIdFor(hint, meals) : startMeal
        setMeal(chosenMeal)
        if (aiReview === 'autoHigh' && canAutoLog(prepared)) {
          logEstimate({ review: prepared, meal: chosenMeal, date: request.date || today, source: request.source, replace: request.replace, today, meals, unit })
          onClose()
          return
        }
        setReview(prepared)
        setPhase('ready')
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return
        setError({ message: err?.message || 'Couldn’t estimate that right now.', status: err?.status ?? null })
        setPhase('error')
      })
    return () => controller.abort()
  }, [request?.key, run]) // eslint-disable-line react-hooks/exhaustive-deps

  function cancel() {
    controllerRef.current?.abort()
    onClose()
  }

  function log() {
    if (!review || !request || fixing) return
    if (logEstimate({ review, meal, date, source: request.source, replace: request.replace, today, meals, unit })) onClose()
  }

  function saveNameOnly() {
    const name = request?.text?.trim()
    if (!name || !request) return
    addEntries([{ name: name.slice(0, 120), meal, date, source: request.source || 'ai_text' }], { toastLabel: `Saved “${name.slice(0, 40)}” without calories` })
    onClose()
  }

  const items = review?.items || []
  const totals = reviewTotals(items)
  const shownText = shown?.text && shown.text !== BARCODE_HINT ? shown.text : ''
  const isBarcode = !!shown && (shown.text === BARCODE_HINT || !!barcodeDigits(shown.text))
  const count = items.length
  const logLabel = count
    ? `Log ${count === 1 ? '1 item' : `${count} items`} · ${energyNumber(totals.calories, unit)} ${unitLabel(unit)}`
    : 'Log'

  let footer
  if (phase === 'loading') footer = <Button variant="secondary" className="btn-grow" onClick={cancel}>Cancel</Button>
  else if (phase === 'ready') footer = <Button size="lg" className="btn-grow" icon="check" onClick={log} disabled={!count || fixing}>{logLabel}</Button>
  else footer = <Button variant="secondary" className="btn-grow" icon="refresh" onClick={() => setRun((n) => n + 1)}>Try again</Button>

  return (
    <Sheet open={open} onClose={cancel} title={shown?.replace ? 'Estimate calories' : 'Review'} initialFocus={false} footer={footer}>
      {shown && (
        <div className="food-est">
          <div className="food-est-pickers">
            <MealSelect meals={meals} value={meal} onChange={setMeal} />
            <label className="food-pick">
              <span className="sr-only">Day</span>
              <span className="food-pick-text">{dayLabel(date, today)}</span>
              <Icon name="chevronDown" size={15} strokeWidth={2.2} />
              <input type="date" value={date} onClick={openDatePicker} onChange={(event) => isISODate(event.target.value) && setDate(event.target.value)} />
            </label>
            {shown.image && <img className="food-est-thumb" src={shown.image} alt="Your photo" />}
            {shown.audio && !shown.image && <span className="food-est-kind"><Icon name="mic" size={15} />Voice</span>}
          </div>

          {phase === 'loading' && (
            <div aria-busy="true">
              <p className="food-est-status" role="status"><span className="spinner" aria-hidden="true" />{loadingText(shown)}</p>
              {shownText && <p className="food-rv-query">“{shownText}”</p>}
              <div className="food-est-skel" aria-hidden="true">
                <div className="food-est-skel-row"><span className="skeleton" /><span className="skeleton" /></div>
                <div className="food-est-skel-row"><span className="skeleton" /><span className="skeleton" /></div>
              </div>
            </div>
          )}

          {phase === 'ready' && review && (
            <EstimateReview result={review} onChange={setReview} meal={meal} date={date} meals={meals} onBusyChange={setFixing} />
          )}

          {phase === 'error' && error && (
            <div className="food-est-error">
              <p className="food-rv-note" role="alert"><Icon name="alert" size={16} />{error.message}</p>
              <div className="food-est-error-actions">
                {shownText.trim() && !shown.replace && !isBarcode && (
                  <Button variant="secondary" size="sm" icon="note" onClick={saveNameOnly}>Save without calories</Button>
                )}
                {onManual && (
                  <Button variant="secondary" size="sm" icon="pencil" onClick={() => { onClose(); onManual({ name: isBarcode ? '' : shownText.trim(), meal, date }) }}>Enter manually</Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
