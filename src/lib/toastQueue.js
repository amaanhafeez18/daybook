// The list of visible toasts (Toaster in components/ui/feedback.jsx), kept pure so it can be tested.

const LONG_TOAST_MS = 10000 // longer than this (e.g. "A new version is ready") isn't pushed out first

// How long a toast stays: errors ~8s, toasts with a button (Undo) 7s, the rest 4.5s.
export function toastDuration({ tone, action } = {}) {
  if (tone === 'error') return 8000
  return action ? 7000 : 4500
}

// Adds `item` to `list`, at most `limit` showing. A toast with the same `key` as one still showing
// replaces it; without a key, the same message and tone counts up instead ("Completed (3)") and
// keeps the newest action, so Undo undoes the last one. A replaced toast keeps its id (no new
// entrance) and moves to the newest place. Over the limit, the oldest short toast goes first.
export function addToast(list, item, limit = 3) {
  const same = list.find((entry) => (item.key
    ? entry.key === item.key
    : !entry.key && entry.message === item.message && entry.tone === item.tone))
  const added = same
    ? { ...item, id: same.id, count: item.key ? 1 : (same.count || 1) + 1 }
    : { ...item, count: 1 }
  const next = [...list.filter((entry) => entry !== same), added]
  while (next.length > Math.max(1, limit)) {
    const short = next.findIndex((entry) => entry !== added && !(entry.duration > LONG_TOAST_MS))
    next.splice(short === -1 ? 0 : short, 1)
  }
  return next
}

// The text a toast shows: its message, with the number of repeats once there are several.
export function toastText({ message, count }) {
  return count > 1 ? `${message} (${count})` : message
}
