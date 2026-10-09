// Pure list helpers for the gym's drag to reorder (src/pages/gym/reorder.js). No imports, so the
// tests can load them without React or CSS.

// `list` in the order of `ids` (rows matched by id); rows not in `ids` follow in their own order.
// The same array when nothing moved.
export function orderByIds(list, ids) {
  const rows = Array.isArray(list) ? list : []
  const byId = new Map()
  for (const row of rows) if (row?.id != null && !byId.has(row.id)) byId.set(row.id, row)
  const used = new Set()
  const out = []
  for (const id of Array.isArray(ids) ? ids : []) {
    const row = byId.get(id)
    if (row && !used.has(row)) {
      used.add(row)
      out.push(row)
    }
  }
  for (const row of rows) if (!used.has(row)) out.push(row)
  return out.length === rows.length && out.every((row, i) => row === rows[i]) ? rows : out
}

// After a drag: a row dropped between two rows of the same superset joins it (so the superset isn't
// split). Anything else is left to the caller's normalizeSupersets, which unlinks a row moved away
// from its partners and keeps one dropped next to them.
export function joinDropped(list, id) {
  const k = list.findIndex((row) => row?.id === id)
  if (k <= 0 || k >= list.length - 1) return list
  const group = list[k - 1]?.supersetId
  if (group == null || group === '' || list[k + 1]?.supersetId !== group || list[k].supersetId === group) return list
  const next = list.slice()
  next[k] = { ...list[k], supersetId: group }
  return next
}
