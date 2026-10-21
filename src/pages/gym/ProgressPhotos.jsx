import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Viewer } from '../../components/AttachmentStrip.jsx'
import Icon from '../../components/ui/Icon.jsx'
import Sheet from '../../components/ui/Sheet.jsx'
import { toast } from '../../components/ui/feedback.jsx'
import { Button } from '../../components/ui/primitives.jsx'
import { attachFile, useSignedUrl } from '../../lib/attachments.js'
import { diffDays, formatDateShort, relativeDay } from '../../lib/dates.js'
import { useBodyWeights } from '../../lib/gym/state.js'
import { formatNumber, fromKg } from '../../lib/gym/units.js'
import { PHOTO_TARGET, agoText, apartText, defaultPair, photoNudge, progressPhotos, weightNear } from '../../lib/progressPhotos.js'
import { useData } from '../../lib/store.js'
import './progress-photos.css'

// Progress photos on Gym → Progress: private photos, one tap to add (dated today), newest first in
// a strip, a nudge after four weeks, and Compare = two photos side by side with the time between
// them and the weight change. Only this account can see them (private bucket, short-lived links).
export default function ProgressPhotos({ today, unit }) {
  const attachments = useData('attachments')
  const photos = useMemo(() => progressPhotos(attachments), [attachments])
  const weights = useBodyWeights()
  const [upload, setUpload] = useState(null) // { preview, progress: -1 preparing | 0…1 }
  const [viewing, setViewing] = useState(null)
  const [comparing, setComparing] = useState(false)
  const inputRef = useRef(null)
  const previews = useRef(new Map())
  const newestFirst = useMemo(() => [...photos].reverse(), [photos])
  const nudge = photoNudge(photos, today)

  useEffect(() => () => { for (const url of previews.current.values()) revoke(url) }, [])

  const pick = () => inputRef.current?.click()
  async function onPick(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || upload) return
    let preview = ''
    setUpload({ preview, progress: -1 })
    try {
      const row = await attachFile(file, PHOTO_TARGET, today, {
        onPrepared: ({ kind, blob }) => {
          if (kind !== 'image') throw new Error('Progress photos are photos only.')
          preview = objectUrl(blob)
          setUpload({ preview, progress: 0 })
        },
        onProgress: (progress) => setUpload((current) => (current ? { ...current, progress } : current)),
      })
      if (preview) previews.current.set(row.id, preview)
      toast('Progress photo saved', { tone: 'success' })
    } catch (error) {
      revoke(preview)
      if (error?.name !== 'AbortError') toast(error?.message || 'Couldn’t save that photo.', { tone: 'error', duration: 7000 })
    } finally {
      setUpload(null)
    }
  }

  const kgText = (kg) => (kg === null ? '' : `${formatNumber(fromKg(kg, unit), 1)} ${unit}`)
  const titleOf = (item) => formatDateShort(item.targetId)
  const metaOf = (item) => [whenText(item.targetId, today), kgText(weightNear(weights, item.targetId))].filter(Boolean).join(' · ')

  return (
    <section className="card wi-card gym-ph" aria-labelledby="gym-ph-title">
      <div className="wi-head">
        <span className="wi-icon" aria-hidden="true"><Icon name="camera" size={20} /></span>
        <h3 id="gym-ph-title" className="wi-title">Progress photos</h3>
        <Button variant="secondary" size="sm" icon="plus" className="wi-capsule" onClick={pick} disabled={!!upload}>Add</Button>
      </div>

      {photos.length === 0 && !upload ? (
        <p className="gym-ph-empty">A photo every few weeks shows changes the scale misses. Only you can see them.</p>
      ) : (
        <ul className="gym-ph-strip" aria-label="Progress photos, newest first">
          {upload && (
            <li>
              <div className="gym-ph-tile is-uploading" role="status" aria-label={upload.progress < 0 ? 'Preparing the photo' : `Uploading, ${Math.round(upload.progress * 100)}%`}>
                {upload.preview && <img src={upload.preview} alt="" />}
                <span className="gym-ph-veil"><span className="spinner" /></span>
              </div>
              <span className="gym-ph-date">Today</span>
            </li>
          )}
          {newestFirst.map((photo) => (
            <li key={photo.id}>
              <Thumb photo={photo} preview={previews.current.get(photo.id)} label={`View the photo from ${formatDateShort(photo.targetId)}`} onOpen={() => setViewing(photo.id)} />
              <span className="gym-ph-date">{shortDay(photo.targetId, today)}</span>
            </li>
          ))}
        </ul>
      )}

      {nudge && !upload && (
        <div className="wi-nudge">
          <button type="button" className="wi-nudge-main" onClick={pick}>
            <Icon name="camera" size={16} />
            <span><strong>Last photo {agoText(nudge.days)}</strong> · Take another</span>
          </button>
        </div>
      )}

      {photos.length >= 2 && (
        <Button variant="secondary" icon="layers" className="gym-ph-compare" onClick={() => setComparing(true)}>Compare</Button>
      )}

      {typeof document !== 'undefined' && createPortal(
        // Outside .shell, so the open picker never counts as typing (which hides the tab bar).
        <input ref={inputRef} type="file" accept="image/*" className="att-input" tabIndex={-1} aria-hidden="true" onChange={onPick} />,
        document.body,
      )}
      {viewing && (
        <Viewer items={newestFirst} currentId={viewing} previews={previews.current} onChange={setViewing} onClose={() => setViewing(null)} titleOf={titleOf} metaOf={metaOf} />
      )}
      {photos.length >= 2 && (
        <CompareSheet open={comparing} onClose={() => setComparing(false)} photos={photos} weights={weights} today={today} unit={unit} previews={previews.current} />
      )}
    </section>
  )
}

// 'Today', 'Yesterday', else '5 weeks ago' (shown under the date itself).
function whenText(date, today) {
  const label = relativeDay(date, today)
  return label === 'Today' || label === 'Yesterday' ? label : agoText(Math.max(0, diffDays(date, today)))
}

// 'Today', 'Yesterday', else 'Oct 3'.
function shortDay(date, today) {
  const label = relativeDay(date, today)
  return label === 'Today' || label === 'Yesterday' ? label : formatDateShort(date)
}

function Thumb({ photo, preview, label, onOpen, selected = false, className = '' }) {
  const link = useSignedUrl(preview ? null : photo.id)
  const [failed, setFailed] = useState(false)
  const src = preview || link.url
  return (
    <button type="button" className={`gym-ph-tile${selected ? ' is-selected' : ''}${!src && link.status === 'loading' ? ' is-loading' : ''} ${className}`} onClick={onOpen} aria-label={label} aria-pressed={selected || undefined}>
      {src && !failed ? <img src={src} alt="" decoding="async" loading="lazy" onError={() => { setFailed(true); if (!preview) link.retry() }} />
        : link.status !== 'loading' && <Icon name="image" size={22} />}
    </button>
  )
}

// Two photos side by side. Tap a side, then a photo in the strip below to swap it in.
function CompareSheet({ open, onClose, photos, weights, today, unit, previews }) {
  const [pair, setPair] = useState(() => defaultPair(photos))
  const [side, setSide] = useState(1) // 0 = left (before), 1 = right (after)
  useEffect(() => {
    if (open) {
      setPair(defaultPair(photos))
      setSide(1)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const byId = (id) => photos.find((photo) => photo.id === id)
  let [a, b] = (pair || []).map(byId)
  if (!a || !b) [a, b] = (defaultPair(photos) || []).map(byId)
  if (!a || !b) return null
  // Older on the left, whichever side was picked.
  if (a.targetId > b.targetId) [a, b] = [b, a]
  const kgA = weightNear(weights, a.targetId)
  const kgB = weightNear(weights, b.targetId)
  const change = kgA !== null && kgB !== null ? Math.round(fromKg(kgB - kgA, unit) * 10) / 10 : null
  const summary = [apartText(a.targetId, b.targetId), change === null ? '' : change === 0 ? 'same weight' : `${change > 0 ? '+' : '−'}${formatNumber(Math.abs(change), 1)} ${unit}`].filter(Boolean).join(' · ')

  const choose = (id) => {
    const next = side === 0 ? [id, b.id] : [a.id, id]
    if (next[0] === next[1]) return
    setPair(next)
  }
  const kgText = (kg) => (kg === null ? '' : `${formatNumber(fromKg(kg, unit), 1)} ${unit}`)

  return (
    <Sheet open={open} onClose={onClose} title="Compare" description={summary} size="lg">
      <div className="gym-ph-pair">
        {[a, b].map((photo, index) => (
          <figure key={index} className={`gym-ph-side${side === index ? ' is-active' : ''}`}>
            <Thumb photo={photo} preview={previews.get(photo.id)} selected={side === index} label={`${index ? 'After' : 'Before'}: ${formatDateShort(photo.targetId)}. Tap, then pick another photo below`} onOpen={() => setSide(index)} className="is-large" />
            <figcaption>
              <strong>{formatDateShort(photo.targetId)}</strong>
              <small>{[whenText(photo.targetId, today), kgText(weightNear(weights, photo.targetId))].filter(Boolean).join(' · ')}</small>
            </figcaption>
          </figure>
        ))}
      </div>
      <p className="gym-ph-pick-hint">Tap a side, then a photo to swap it in.</p>
      <ul className="gym-ph-strip is-picker" data-no-sheet-drag aria-label={`Pick the ${side ? 'after' : 'before'} photo`}>
        {photos.map((photo) => {
          const inUse = photo.id === a.id || photo.id === b.id
          return (
            <li key={photo.id}>
              <Thumb photo={photo} preview={previews.get(photo.id)} selected={inUse} label={`Use the photo from ${formatDateShort(photo.targetId)}`} onOpen={() => choose(photo.id)} />
              <span className="gym-ph-date">{shortDay(photo.targetId, today)}</span>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
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
    try { URL.revokeObjectURL(url) } catch { /* already gone */ }
  }
}
