import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './ui/Icon.jsx'
import { Button } from './ui/primitives.jsx'
import { toast } from './ui/feedback.jsx'
import { imageToJpegDataUrl } from '../lib/media.js'
import { formatSeconds, useRecorder } from '../lib/recorder.js'
import { dayTotals } from '../lib/food/nutrition.js'
import { addEntries, dayEntries, estimateFood, useFood, useFoodEntries } from '../lib/food/state.js'
import { useStore } from '../lib/store.js'
import EstimateReview, { canAutoLog, logEstimate, prepareEstimate, reviewTotals } from '../pages/food/EstimateReview.jsx'
import { Ring, ringState } from '../pages/food/ring.jsx'
import PhotoInput from '../pages/food/PhotoInput.jsx'
import { defaultMeal, energyNumber, isSubmitKey, mealIdFor, unitLabel } from '../pages/food/format.js'
import './food-quick.css'

// Today-page food card: today's total against the goal with a tiny ring, and one line to log
// food by text, photo or voice. The AI estimate opens right here as an editable review with
// Save / Cancel (or logs straight away when "auto-log if sure" is on).

export default function FoodQuickCard({ today, loaded }) {
  const food = useFood()
  const entries = useFoodEntries()
  const offline = useStore((state) => state.offline)
  const { meals, energyUnit: unit, aiReview } = food.prefs
  const goal = food.goals.calories
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

  const totals = useMemo(() => dayTotals(dayEntries(entries, today, meals)), [entries, today, meals])
  const eaten = totals.calories
  const ring = ringState(eaten, goal)
  const left = goal ? goal - eaten : null

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
      if (next.text && !next.image && !next.audio) {
        addEntries([{ name: next.text.slice(0, 120), meal: startMeal, date: today, source: 'ai_text' }], {
          toastLabel: `You’re offline — saved “${next.text.slice(0, 32)}” without calories. Estimate it on the Food page later.`,
        })
        setText('')
        setPhase('idle')
      } else {
        setError('You’re offline — photos and voice need a connection.')
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
    run({ text: words, source: 'ai_text' })
  }

  async function onPhoto(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPreparing(true)
    try {
      const image = await imageToJpegDataUrl(file, { maxDim: 1280, quality: 0.72 })
      run({ image, text: text.trim() || undefined, source: 'ai_photo' })
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

  function saveNameOnly() {
    const name = request?.text?.trim()
    if (!name) return
    addEntries([{ name: name.slice(0, 120), meal, date: today, source: 'ai_text' }], { toastLabel: `Saved “${name.slice(0, 40)}” without calories` })
    finish()
  }

  const busy = phase === 'estimating'
  const reviewTotalsNow = review ? reviewTotals(review.items) : null
  const count = review?.items.length || 0

  let summary
  if (!loaded) summary = <span className="skeleton fq-skel" aria-hidden="true" />
  else if (!totals.count) summary = <span className="fq-sum">{goal ? `${energyNumber(goal, unit)} ${unitLabel(unit)} to go` : 'Nothing logged yet'}</span>
  else {
    summary = (
      <span className="fq-sum">
        {energyNumber(eaten, unit)} {unitLabel(unit)}
        {goal ? <span className={left < 0 ? 'is-over' : ''}> · {energyNumber(Math.abs(left), unit)} {left < 0 ? 'over' : 'left'}</span> : null}
      </span>
    )
  }

  return (
    <section className="card fq-card" aria-labelledby="fq-title">
      <header className="fq-head">
        <Ring size={30} stroke={4} progress={loaded ? ring.progress : 0} tone={ring.tone} className="fq-ring" />
        <div className="fq-head-text">
          <h3 id="fq-title">Food</h3>
          {summary}
        </div>
        <a href="#/food" className="fq-all">See all<Icon name="chevronRight" size={16} /></a>
      </header>

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
            aria-label="What did you eat?"
            enterKeyHint="send"
            autoComplete="off"
            maxLength={1000}
            disabled={busy}
          />
          <button type="button" className="fq-btn" onClick={() => fileRef.current?.click()} disabled={busy || preparing} aria-label="Add a photo of your food">
            {preparing ? <span className="spinner" aria-hidden="true" /> : <Icon name="camera" size={20} />}
          </button>
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

      {phase === 'estimating' && (
        <div className="fq-panel" aria-busy="true">
          <p className="fq-status" role="status">
            <span className="spinner" aria-hidden="true" />
            {request?.audio ? 'Listening and estimating…' : request?.image ? 'Looking at your photo…' : 'Estimating…'}
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
          <p className="fq-error" role="alert"><Icon name="alert" size={16} />{error}</p>
          <div className="fq-actions is-wrap">
            {request?.text?.trim() && <Button variant="secondary" size="sm" icon="note" onClick={saveNameOnly}>Save without calories</Button>}
            {request && <Button variant="secondary" size="sm" icon="refresh" onClick={() => run(request)}>Try again</Button>}
            <Button variant="ghost" size="sm" onClick={finish}>Dismiss</Button>
          </div>
        </div>
      )}
    </section>
  )
}
