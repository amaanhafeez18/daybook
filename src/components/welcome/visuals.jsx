import Icon, { BrandMark } from '../ui/Icon.jsx'
import { formatDue, greeting } from '../../lib/dates.js'

// Decorative mock-ups for the welcome tour, drawn in the app's own colours (so they follow the
// accent theme and light/dark). All aria-hidden: each slide's text says what they show.

// The brand mark with a task, a class, a reminder and the assistant floating around it. Each
// float sits in a wrapper: the wrapper handles the staggered entrance, the float itself the bob
// (two animations on one element would fight over transform).
export function HeroVisual() {
  return (
    <div className="wl-hero" aria-hidden="true">
      <span className="wl-hero-ring" />
      <span className="wl-hero-ring is-outer" />
      <span className="wl-hero-mark"><BrandMark size={92} /></span>
      <span className="wl-float-in is-a"><span className="wl-float is-a"><span className="wl-tick"><Icon name="check" size={11} strokeWidth={3} /></span>Plan my week</span></span>
      <span className="wl-float-in is-b"><span className="wl-float is-b"><Icon name="calendar" size={14} />9:00 Lecture</span></span>
      <span className="wl-float-in is-c"><span className="wl-float is-c"><Icon name="bell" size={14} />Call mom · 5 PM</span></span>
      <span className="wl-float-in is-d"><span className="wl-float is-d is-icon"><Icon name="sparkles" size={18} /></span></span>
    </div>
  )
}

// A Today card: the tasks added on this screen first, then a sample day built from the picks.
export function TodayVisual({ name, picks, added }) {
  const now = new Date()
  const rows = added.slice(0, 2).map((task) => ({ id: task.id, kind: 'task', title: task.text, meta: formatDue(task.date, task.time) || 'Today', fresh: true }))
  if (picks.has('classes')) rows.push({ id: 'class', kind: 'icon', icon: 'graduation', title: 'Biology lecture', meta: '9:00 AM · Room 204' })
  if (!added.length) rows.push({ id: 'plan', kind: 'task', title: 'Plan my week', meta: 'Today' })
  if (picks.has('people')) rows.push({ id: 'sam', kind: 'person', title: 'Catch up with Sam', meta: 'Due this week' })
  if (picks.has('gym')) rows.push({ id: 'gym', kind: 'icon', icon: 'dumbbell', title: 'Push day', meta: '5 exercises · 50 min' })
  rows.push({ id: 'dentist', kind: 'task', title: 'Book the dentist', meta: 'Today · 6:00 PM' })
  rows.push({ id: 'essay', kind: 'task', title: 'Submit essay draft', meta: 'Today · 10:00 AM', done: true })

  return (
    <div className="wl-phone" aria-hidden="true">
      <div className="wl-today-head">
        <span>
          <small>{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</small>
          <strong>{greeting(now)}{name ? `, ${name}` : ''}</strong>
        </span>
        <span className="wl-weather"><Icon name="sun" size={15} />24°</span>
      </div>
      <ul className="wl-rows">
        {rows.slice(0, 4).map((row) => (
          <li key={row.id} className={`wl-row ${row.fresh ? 'is-fresh' : ''} ${row.done ? 'is-done' : ''}`}>
            {row.kind === 'task' && <span className="wl-check">{row.done && <Icon name="check" size={12} strokeWidth={3} />}</span>}
            {row.kind === 'icon' && <span className="wl-badge"><Icon name={row.icon} size={15} /></span>}
            {row.kind === 'person' && <span className="wl-face">S</span>}
            <span className="wl-row-text"><strong>{row.title}</strong><small>{row.meta}</small></span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AssistantVisual() {
  return (
    <div className="wl-chat" aria-hidden="true">
      <span className="wl-bubble is-me">Remind me to call mom at 5</span>
      <span className="wl-bubble is-ai"><span className="wl-ai-mark"><Icon name="sparkles" size={13} /></span>Sure, here’s the plan:</span>
      <div className="wl-proposal">
        <span className="wl-proposal-row">
          <span className="wl-badge"><Icon name="plus" size={15} /></span>
          <span className="wl-row-text"><strong>Call mom</strong><small>Today · 5:00 PM · reminder 15 min before</small></span>
        </span>
        <span className="wl-proposal-actions"><span>No</span><span className="is-yes">Yes</span></span>
      </div>
      <span className="wl-composer">Ask anything…<span className="wl-mic"><Icon name="mic" size={15} /></span></span>
    </div>
  )
}

const TILES = {
  classes: { title: 'Classes', text: 'Your timetable, right on Today.', art: () => (
    <span className="wl-art-week">{['M', 'T', 'W', 'T', 'F'].map((day, i) => <span key={i}><small>{day}</small><i className={i % 2 ? '' : 'is-on'} /><i className={i === 1 || i === 4 ? 'is-on' : ''} /></span>)}</span>
  ) },
  people: { title: 'People', text: 'A nudge when it’s time to catch up.', art: () => (
    <span className="wl-art-faces"><span className="wl-face">S</span><span className="wl-face is-2">A</span><span className="wl-face is-3">M</span><em>Due</em></span>
  ) },
  gym: { title: 'Gym', text: 'Plan routines and log every set.', art: () => (
    <span className="wl-art-streak">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, i) => <span key={i} className={i < 4 && i !== 2 ? 'is-on' : ''}>{day}</span>)}</span>
  ) },
  food: { title: 'Food', text: 'Describe a meal; see the day’s totals.', art: () => (
    <span className="wl-art-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" /><circle cx="18" cy="18" r="15" className="is-fill" pathLength="100" /></svg><small>1,240<br />kcal</small></span>
  ) },
  journal: { title: 'Journal', text: 'A mood and a few lines a day.', art: () => (
    <span className="wl-art-moods">{['😄', '🙂', '😐', '😕'].map((mood, i) => <span key={mood} className={i === 1 ? 'is-on' : ''}>{mood}</span>)}</span>
  ) },
}

export const TILE_IDS = Object.keys(TILES)

export function ExtrasVisual({ picks }) {
  const ids = TILE_IDS.filter((id) => picks.has(id))
  return (
    <div className="wl-tiles" aria-hidden="true">
      {ids.map((id) => (
        <span key={id} className="wl-tile">
          <span className="wl-tile-art">{TILES[id].art()}</span>
          <strong>{TILES[id].title}</strong>
          <small>{TILES[id].text}</small>
        </span>
      ))}
    </div>
  )
}

export function NotifyVisual() {
  return (
    <div className="wl-notes" aria-hidden="true">
      <span className="wl-note">
        <BrandMark size={34} />
        <span className="wl-note-text"><span><strong>Good morning</strong><small>8:00 AM</small></span>3 things today. First up: Plan my week.</span>
      </span>
      <span className="wl-note is-2">
        <BrandMark size={34} />
        <span className="wl-note-text"><span><strong>Call mom</strong><small>4:45 PM</small></span>In 15 minutes</span>
      </span>
    </div>
  )
}

export function DoneVisual() {
  return (
    <div className="wl-done" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i }} />)}
      <span className="wl-done-badge"><Icon name="check" size={44} strokeWidth={2.6} /></span>
    </div>
  )
}

// iOS Safari's toolbar icons, for the Add to Home Screen steps.
export function ShareIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12M8 7l4-4 4 4" /><path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2" />
    </svg>
  )
}

export function AddHomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="M12 8v8M8 12h8" />
    </svg>
  )
}
