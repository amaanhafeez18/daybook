// When the first-run welcome tour shows. Pure (no browser or React code), so tests/welcome.test.mjs
// can check it; the shell (components/Welcome.jsx) applies it to the store's state.

export const WELCOME_EVENT = 'daybook:welcome'

// Lists whose rows mean the account has been used.
const USED_LISTS = ['tasks', 'events', 'friends', 'contactLogs', 'classes', 'journalEntries', 'voiceNotes', 'gymSessions', 'bodyWeights', 'foodEntries']
// Settings only a person sets (in Settings, the gym or food pages, or through the assistant), so
// someone who has only set up a gym plan or food goals isn't greeted as new. Not every setting:
// the app writes some itself for every account (the time zone, on the first load).
const USED_SETTINGS = ['displayName', 'theme', 'appearance', 'darkMode', 'gym', 'food', 'notifications', 'assistantConfirm', 'assistantWeb', 'showPrayerTimes', 'prayerMethod', 'prayerSchool']

export function accountIsEmpty(data) {
  const settings = data?.settings && typeof data.settings === 'object' ? data.settings : {}
  return USED_LISTS.every((key) => !Array.isArray(data?.[key]) || data[key].length === 0)
    && !USED_SETTINGS.some((key) => settings[key] !== undefined && settings[key] !== null && settings[key] !== '')
}

// 'wait' (not known yet) | 'done' (seen it, or it was marked done) | 'mark-done' (an account with
// data that never saw it: an existing user, so it's marked done quietly) | 'show' (a brand-new account).
// Showing needs a successful load from the server this session, not just the device cache: a
// cache can be partial (storage full), and an empty-looking one mustn't greet an existing user.
export function welcomeDecision({ data, hydrated, lastSyncedAt } = {}) {
  if (!hydrated) return 'wait'
  if (data?.settings?.welcomeDone === true) return 'done'
  if (!accountIsEmpty(data)) return 'mark-done'
  return lastSyncedAt ? 'show' : 'wait'
}

// Reopens the tour (e.g. from a Settings row). The shell listens for this.
export function openWelcome() {
  window.dispatchEvent(new Event(WELCOME_EVENT))
}
