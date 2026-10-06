// Unsaved form drafts: when a form sheet is closed by a stray tap or swipe, what was typed is kept
// for this browser session, so reopening the same form brings it back ("Draft kept · Reopen").
// Keyed per form, e.g. 'task:new', 'class:new', 'person:new', 'catchup:<friendId>:<date>'.
// Holds only what the user typed into the form, never anything secret.
const PREFIX = 'daybook.draft.'
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function saveDraft(key, value) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify({ value, at: Date.now() }))
  } catch {
    // storage full or blocked: the draft is simply not kept
  }
}

// The draft without removing it, or null (missing, unreadable or older than a day).
export function peekDraft(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return null
    const { value, at } = JSON.parse(raw)
    if (!at || Date.now() - at > MAX_AGE_MS) {
      sessionStorage.removeItem(PREFIX + key)
      return null
    }
    return value ?? null
  } catch {
    return null
  }
}

// The draft, removed (call when the form opens and takes it over).
export function takeDraft(key) {
  const value = peekDraft(key)
  clearDraft(key)
  return value
}

export function clearDraft(key) {
  try {
    sessionStorage.removeItem(PREFIX + key)
  } catch {
    // nothing to clear
  }
}
