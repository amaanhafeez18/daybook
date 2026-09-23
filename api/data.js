import { randomUUID } from 'crypto'
import { getSupabase, readJsonBody, selectAll, verifyRequestToken, verifyTokenVersion } from './db.js'
import { patchSettingsAtomic, saveSettings } from './_settings.js'

function isConfigError(error) {
  return /Missing SUPABASE_URL|Missing JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|Environment Variables/.test(error?.message || '')
}

// Client data keys the API may read or write, mapped to their tables.
const TABLES = {
  tasks: 'tasks',
  events: 'events',
  friends: 'friends',
  contactLogs: 'contact_logs',
  contact_logs: 'contact_logs',
  voiceNotes: 'voice_notes',
  classes: 'classes',
  settings: 'settings',
  journalEntries: 'journal_entries',
  gymSessions: 'gym_sessions',
  bodyWeights: 'body_weights',
  foodEntries: 'food_entries'
}

// Columns each table accepts (matches supabase/schema.sql). Unknown fields are dropped
// so a stray client field can never make a save fail.
const COLUMNS = {
  tasks: ['id', 'text', 'done', 'date', 'time', 'details', 'priority', 'archived', 'calendar_event_id', 'reminder_minutes', 'created_at'],
  events: ['id', 'date', 'time', 'title', 'task_id', 'created_at'],
  friends: ['id', 'name', 'relationship', 'reminder_days', 'organization', 'note', 'photo_url', 'birthday', 'current_status', 'facts', 'created_at'],
  contact_logs: ['id', 'friend_id', 'date', 'note', 'created_at'],
  voice_notes: ['id', 'text', 'created_at'],
  classes: ['id', 'name', 'days', 'time', 'room', 'end_date', 'day_details', 'created_at'],
  journal_entries: ['id', 'date', 'title', 'body', 'mood', 'created_at'],
  gym_sessions: ['id', 'date', 'name', 'routine_id', 'started_at', 'ended_at', 'duration_sec', 'exercises', 'note', 'planned', 'bodyweight_kg', 'is_deload', 'created_at'],
  body_weights: ['id', 'date', 'kg', 'created_at'],
  food_entries: ['id', 'date', 'time', 'meal', 'name', 'brand', 'amount', 'unit', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'extra', 'note', 'source', 'favorite_id', 'ai', 'created_at']
}

// camelCase client field -> snake_case column
const FIELD_TO_COLUMN = {
  friendId: 'friend_id',
  photoUrl: 'photo_url',
  currentStatus: 'current_status',
  endDate: 'end_date',
  calendarEventId: 'calendar_event_id',
  taskId: 'task_id',
  reminderDays: 'reminder_days',
  dayDetails: 'day_details',
  reminderMinutes: 'reminder_minutes',
  routineId: 'routine_id',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  durationSec: 'duration_sec',
  bodyweightKg: 'bodyweight_kg',
  isDeload: 'is_deload',
  proteinG: 'protein_g',
  carbsG: 'carbs_g',
  fatG: 'fat_g',
  fiberG: 'fiber_g',
  sugarG: 'sugar_g',
  sodiumMg: 'sodium_mg',
  favoriteId: 'favorite_id',
  createdAt: 'created_at'
}
const COLUMN_TO_FIELD = Object.fromEntries(Object.entries(FIELD_TO_COLUMN).map(([field, column]) => [column, field]))

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// Gym and food columns with a strict type are coerced both ways, so a float duration, a null list or
// a number sent as text can't fail a save and an odd stored value can't reach the client. Other jsonb
// passes through as is.
const FOOD_NUMBERS = ['amount', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg']
const COERCE = {
  gym_sessions: { duration_sec: 'integer', bodyweight_kg: 'number', exercises: 'list', is_deload: 'boolean' },
  body_weights: { kg: 'number' },
  food_entries: {
    ...Object.fromEntries(FOOD_NUMBERS.map((column) => [column, 'number'])),
    extra: 'object',
    ai: 'objectOrNull',
    source: 'foodSource'
  }
}

function toNumber(value) {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

function toInteger(value) {
  const number = toNumber(value)
  if (number === null) return null
  const rounded = Math.round(number)
  return Math.abs(rounded) <= 2147483647 ? rounded : null // Postgres integer range
}

function coerce(type, value) {
  if (type === 'number') return toNumber(value)
  if (type === 'integer') return toInteger(value)
  if (type === 'list') return Array.isArray(value) ? value : []
  if (type === 'boolean') return value === true
  if (type === 'object') return isPlainObject(value) ? value : {}
  if (type === 'objectOrNull') return isPlainObject(value) ? value : null
  if (type === 'foodSource') return typeof value === 'string' && value.trim() ? value : 'manual' // column is not null
  return value
}

function coerceRow(row, tableName) {
  for (const [column, type] of Object.entries(COERCE[tableName] || {})) {
    if (column in row) row[column] = coerce(type, row[column])
  }
  return row
}

// Tables added by a later migration. Until it has run, reads return an empty list (the app loads
// every key in one request, so one missing table must not break sign-in) and saves explain the fix.
const GYM_MIGRATION = 'Gym data can’t sync until the database is updated. Run supabase/migrations/2026-09-26-gym.sql in Supabase.'
const FOOD_MIGRATION = 'Food data can’t sync until the database is updated. Run supabase/migrations/2026-09-27-food.sql in Supabase.'
const OPTIONAL_TABLES = {
  gym_sessions: GYM_MIGRATION,
  body_weights: GYM_MIGRATION,
  food_entries: FOOD_MIGRATION
}
const warnedMissing = new Set()

function isMissingTable(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  const message = String(error.message || '')
  if (MISSING_COLUMN.test(message)) return false
  return /Could not find the table|relation .* does not exist|schema cache/i.test(message)
}

function warnMissingTable(tableName) {
  if (warnedMissing.has(tableName)) return
  warnedMissing.add(tableName)
  console.warn(`Table "${tableName}" is missing; returning no rows. ${OPTIONAL_TABLES[tableName]}`)
}

// Runs a save and turns "table missing" on an optional table into a 503 with instructions.
async function forTable(tableName, run) {
  try {
    return await run()
  } catch (error) {
    if (OPTIONAL_TABLES[tableName] && isMissingTable(error)) {
      throw Object.assign(new Error(OPTIONAL_TABLES[tableName]), { status: 503 })
    }
    throw error
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function toIsoString(value) {
  if (!value) return new Date().toISOString()
  if (typeof value === 'string') return value
  return new Date(value).toISOString()
}

function normalizeRowForDb(item, tableName, userId) {
  const allowed = COLUMNS[tableName]
  const next = {}
  for (const [key, value] of Object.entries(item || {})) {
    const column = FIELD_TO_COLUMN[key] || key
    if (!allowed.includes(column)) continue
    if (column in next && key === column) continue // prefer the camelCase value when both are present
    next[column] = value
  }
  next.id = next.id ? String(next.id) : randomUUID()
  next.created_at = toIsoString(next.created_at)
  next.user_id = userId
  return coerceRow(next, tableName)
}

function normalizeRowForClient(item, tableName) {
  if (!item) return item
  const next = {}
  for (const [key, value] of Object.entries(coerceRow({ ...item }, tableName))) {
    next[COLUMN_TO_FIELD[key] || key] = value
  }
  return next
}

// Settings saves (whole value for PUT, field-level patch for PATCH) live in _settings.js, shared with
// the assistant.

function toDbRows(value, tableName, userId) {
  const rows = []
  const seen = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const row = normalizeRowForDb(item, tableName, userId)
    if (seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

function chunks(list, size = 100) {
  const result = []
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size))
  return result
}

async function ownedIdsFor(supabase, tableName, userId, ids) {
  // Small batches check just those ids; large ones read every id the user owns (keeps URLs short).
  if (ids && ids.length <= 100) {
    const { data, error } = await supabase.from(tableName).select('id').eq('user_id', userId).in('id', ids)
    if (error) throw error
    return new Set((data || []).map((row) => row.id))
  }
  const rows = await selectAll(() => supabase.from(tableName).select('id').eq('user_id', userId).order('id'))
  return new Set(rows.map((row) => row.id))
}

// Rows the user already owns are updated in place. New rows use a plain insert, so an id that
// belongs to another user fails instead of being taken over.
const MISSING_COLUMN = /Could not find the '([^']+)' column/

// Retries without columns the live database doesn't have yet (a migration not yet run),
// so a new optional field can never make saving fail. Returns the columns it left out.
async function tolerant(run, rows) {
  const dropped = new Set()
  let { error } = await run(rows)
  while (error) {
    const missing = MISSING_COLUMN.exec(error.message || '')
    if (!missing || dropped.has(missing[1]) || dropped.size >= 5) break
    dropped.add(missing[1])
    console.warn(`Column "${missing[1]}" is missing; saving without it. Run the latest Supabase migration.`)
    rows = rows.map(({ [missing[1]]: _dropped, ...rest }) => rest)
    ;({ error } = await run(rows))
  }
  if (error) throw error
  return dropped
}

// Returns the set of columns left out of any batch.
async function writeRows(supabase, tableName, rows, ownedIds) {
  const existingRows = rows.filter((row) => ownedIds.has(row.id))
  const newRows = rows.filter((row) => !ownedIds.has(row.id))
  const dropped = new Set()

  for (const batch of chunks(existingRows)) {
    const left = await tolerant((rows) => supabase.from(tableName).upsert(rows, { onConflict: 'id', defaultToNull: false }), batch)
    left.forEach((column) => dropped.add(column))
  }
  for (const batch of chunks(newRows)) {
    const left = await tolerant((rows) => supabase.from(tableName).insert(rows, { defaultToNull: false }), batch)
    left.forEach((column) => dropped.add(column))
  }
  return dropped
}

// Columns a save left out, as client field names, for the reply ({ ok, dropped }): the app keeps
// those values on the device until the database has the column (see src/lib/store.js).
function droppedFields(dropped) {
  return [...dropped].map((column) => COLUMN_TO_FIELD[column] || column).sort()
}

function savedReply(dropped) {
  const fields = droppedFields(dropped)
  return fields.length ? { ok: true, dropped: fields } : { ok: true }
}

async function deleteRows(supabase, tableName, userId, ids) {
  for (const batch of chunks(ids)) {
    const { error } = await supabase.from(tableName).delete().eq('user_id', userId).in('id', batch)
    if (error) throw error
  }
}

// PUT: replaces the user's rows with `value` without ever deleting first. Write the new list,
// and only once that succeeds remove rows that are no longer in it.
async function replaceRows(supabase, tableName, userId, value) {
  const rows = toDbRows(value, tableName, userId)
  const ownedIds = await ownedIdsFor(supabase, tableName, userId, null)
  const dropped = await writeRows(supabase, tableName, rows, ownedIds)
  const keep = new Set(rows.map((row) => row.id))
  await deleteRows(supabase, tableName, userId, [...ownedIds].filter((id) => !keep.has(id)))
  return dropped
}

// PATCH: applies only what changed on the client. Items created elsewhere (another device, the
// assistant) are never touched, so concurrent edits can't delete each other's work.
async function patchRows(supabase, tableName, userId, upsert, remove) {
  const rows = toDbRows(upsert, tableName, userId)
  let dropped = new Set()
  if (rows.length) {
    const ownedIds = await ownedIdsFor(supabase, tableName, userId, rows.map((row) => row.id))
    dropped = await writeRows(supabase, tableName, rows, ownedIds)
  }
  const ids = [...new Set((Array.isArray(remove) ? remove : []).map(String))]
  if (ids.length) await deleteRows(supabase, tableName, userId, ids)
  return dropped
}

async function readKey(supabase, key, userId) {
  const tableName = TABLES[key]
  let rows
  try {
    rows = await selectAll(() => supabase
      .from(tableName)
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .order('id'))
  } catch (error) {
    if (!OPTIONAL_TABLES[tableName] || !isMissingTable(error)) throw error
    warnMissingTable(tableName)
    return []
  }
  if (tableName === 'settings') return rows[0]?.value || {}
  return rows.map((row) => normalizeRowForClient(row, tableName))
}

export default async function handler(req, res) {
  try {
    const method = req.method || 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Cache-Control', 'no-store')

    if (method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }

    const decoded = verifyRequestToken(req)
    if (!decoded) {
      return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
    }

    const supabase = getSupabase()
    const expired = () => sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })

    if (method === 'GET') {
      // ?keys=tasks,events,... loads several lists in one request (one cold start instead of many).
      const keys = req.query?.keys
        ? [...new Set(String(req.query.keys).split(',').map((key) => key.trim()).filter(Boolean))]
        : [req.query?.key || 'tasks']
      if (!keys.length || keys.some((key) => !TABLES[key])) return sendJson(res, 400, { error: 'Unknown data key.' })

      // The session check runs alongside the reads; nothing is returned unless it passes.
      const [user, ...values] = await Promise.all([verifyTokenVersion(supabase, decoded), ...keys.map((key) => readKey(supabase, key, decoded.id))])
      if (!user) return expired()
      if (!req.query?.keys) return sendJson(res, 200, values[0])
      return sendJson(res, 200, Object.fromEntries(keys.map((key, index) => [key, values[index]])))
    }

    if (!(await verifyTokenVersion(supabase, decoded))) return expired()

    if (method === 'PATCH') {
      const body = await readJsonBody(req)
      const tableName = TABLES[body.key]
      if (!tableName) return sendJson(res, 400, { error: 'Unknown data key.' })
      if (tableName === 'settings') {
        await patchSettingsAtomic(supabase, decoded.id, body.set)
        return sendJson(res, 200, { ok: true })
      }
      const dropped = await forTable(tableName, () => patchRows(supabase, tableName, decoded.id, body.upsert, body.delete))
      return sendJson(res, 200, savedReply(dropped))
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req)
      const tableName = TABLES[body.key]
      if (!tableName) return sendJson(res, 400, { error: 'Unknown data key.' })

      let dropped = new Set()
      if (tableName === 'settings') {
        await saveSettings(supabase, decoded.id, body.value)
      } else {
        // A missing or malformed list must never be treated as "delete everything".
        if (!Array.isArray(body.value)) return sendJson(res, 400, { error: 'Expected a list.' })
        dropped = await forTable(tableName, () => replaceRows(supabase, tableName, decoded.id, body.value))
      }

      return sendJson(res, 200, savedReply(dropped))
    }

    return sendJson(res, 404, { error: 'Unsupported method.' })
  } catch (error) {
    console.error('Data API error:', error)
    if (error.status === 503) return sendJson(res, 503, { error: error.message })
    if (isConfigError(error)) {
      return sendJson(res, 503, {
        error: error.message.startsWith('Server setup problem') ? error.message : 'Server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and JWT_SECRET in Vercel.'
      })
    }
    return sendJson(res, 500, { error: error.message || 'Unexpected data error.' })
  }
}
