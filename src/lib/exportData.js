import { apiRequest } from './api.js'
import { todayISO } from './dates.js'
import { flushAll } from './store.js'
import { shareOrDownload } from './share.js'

// Settings → "Export my data": everything this account has in Daybook as one JSON file (the share
// sheet on iPhone, a download elsewhere). Edits still waiting to be saved go first, so the file has
// them. Photos and files attached to tasks, notes and people are listed by name (the files
// themselves stay private in storage). Nothing secret is in it: no password or recovery answer.
const LISTS = ['tasks', 'events', 'classes', 'friends', 'contactLogs', 'journalEntries', 'voiceNotes', 'gymSessions', 'bodyWeights', 'foodEntries', 'attachments']

// prepareExport fetches and builds the file; saveExport hands it to the share sheet, which iPhone
// only opens from a tap, hence two steps (Settings shows a Save button once it's ready).
export async function prepareExport(username) {
  await flushAll().catch(() => {})
  const [data, assistant] = await Promise.all([
    apiRequest(`/api/data?keys=${[...LISTS, 'settings'].join(',')}`),
    apiRequest('/api/assistant').catch(() => null), // the chat isn't essential to the export
  ])
  const today = todayISO()
  const file = {
    app: 'Daybook',
    format: 1,
    exportedAt: new Date().toISOString(),
    account: { username },
    settings: data.settings || {},
    ...Object.fromEntries(LISTS.map((key) => [key, Array.isArray(data[key]) ? data[key] : []])),
    assistant: assistant ? { memories: assistant.memories || [], messages: assistant.messages || [] } : null,
  }
  return {
    text: JSON.stringify(file, null, 2),
    filename: `daybook-${username || 'export'}-${today}.json`,
    items: LISTS.reduce((sum, key) => sum + file[key].length, 0),
  }
}

export function saveExport(prepared) {
  return shareOrDownload(prepared.text, prepared.filename, 'application/json')
}
