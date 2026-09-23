import bcrypt from 'bcryptjs'
import { clientIp, getSupabase, readJsonBody, signToken, underLimit, verifyRequestToken, verifyTokenVersion } from './db.js'

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
const MIN_PASSWORD_LENGTH = 8
const MIN_ANSWER_LENGTH = 3
const MAX_FAILED_ATTEMPTS = 8
const LOCK_MINUTES = 15
// Compared against when a username doesn't exist, so a miss takes as long as a wrong password
// and response timing doesn't reveal which usernames are registered.
const DUMMY_HASH = '$2a$10$AaopJ0CtwTR277bCjvRU.e2P00I/cDSvK633BmiMUA.yRO0SsgWMm'
// Every account created before recovery answers were personal was told to answer "me".
const LEGACY_SHARED_ANSWER = 'me'
// "Clear all data" empties these for the user. users (the account and its sign-in) and
// push_subscriptions (devices that turned notifications on) are kept.
const WIPE_TABLES = [
  'tasks', 'events', 'friends', 'contact_logs', 'classes', 'journal_entries', 'voice_notes',
  'gym_sessions', 'body_weights', 'food_entries', 'assistant_memories', 'assistant_conversations',
  'notification_log', 'settings',
]
const WIPE_LIMIT = 5 // attempts per user per hour

function isConfigError(error) {
  return /Missing SUPABASE_URL|Missing JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|Environment Variables/.test(error?.message || '')
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function normalizeAnswer(answer) {
  return String(answer || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// 'hashed' = personal answer stored with bcrypt; 'legacy' = older plain-text personal answer;
// 'none' = no usable recovery (empty, or the old shared answer everyone was told to use).
function recoveryStatus(user) {
  const stored = String(user?.recovery_answer || '')
  if (stored.startsWith('$2')) return 'hashed'
  if (!stored || stored === LEGACY_SHARED_ANSWER) return 'none'
  return 'legacy'
}

function publicUser(user) {
  return { id: user.id, username: user.username, hasRecovery: recoveryStatus(user) !== 'none' }
}

function passwordProblem(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`
  if (password.length > 200) return 'That password is too long.'
  return ''
}

function recoveryProblem(question, answer) {
  if (!question || question.length > 200) return 'Choose a recovery question.'
  if (answer.length < MIN_ANSWER_LENGTH) return `Your recovery answer needs at least ${MIN_ANSWER_LENGTH} characters.`
  if (answer.length > 200) return 'That recovery answer is too long.'
  return ''
}

// Account lockout uses users.failed_attempts / locked_until and the daybook_record_auth_failure
// function (supabase/migrations/2026-09-23-auth-hardening.sql). Without them it is skipped.
function lockedMinutes(user) {
  if (!user?.locked_until) return 0
  const remaining = new Date(user.locked_until).getTime() - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 60000) : 0
}

async function recordFailure(supabase, user) {
  if (!user || !('failed_attempts' in user)) return
  // Atomic in the database, so many parallel guesses can't slip past the limit.
  const { error } = await supabase.rpc('daybook_record_auth_failure', { p_user_id: user.id, p_max: MAX_FAILED_ATTEMPTS, p_lock_minutes: LOCK_MINUTES })
  if (!error) return
  const attempts = (user.failed_attempts || 0) + 1
  const patch = attempts >= MAX_FAILED_ATTEMPTS
    ? { failed_attempts: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() }
    : { failed_attempts: attempts }
  await supabase.from('users').update(patch).eq('id', user.id)
}

async function clearFailures(supabase, user) {
  if (!user || !('failed_attempts' in user)) return
  if (!user.failed_attempts && !user.locked_until) return
  await supabase.from('users').update({ failed_attempts: 0, locked_until: null }).eq('id', user.id)
}

function tooMany(res, minutes) {
  return sendJson(res, 429, { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` })
}

// A table from a migration the owner hasn't run yet: nothing to delete there.
function isMissingTable(error) {
  if (!error) return false
  if (error.code === 'PGRST205' || error.code === '42P01') return true
  return /Could not find the table|relation .* does not exist/i.test(String(error.message || ''))
}

// Deletes every row the user owns in WIPE_TABLES, all tables at once. Each delete is filtered by
// user_id only. Returns { cleared, failed } table names (missing tables are in neither).
async function wipeUserData(supabase, userId) {
  const results = await Promise.all(WIPE_TABLES.map(async (table) => {
    try {
      const { error } = await supabase.from(table).delete().eq('user_id', userId)
      if (!error) return { table, status: 'cleared' }
      if (isMissingTable(error)) return { table, status: 'missing' }
      console.error(`Clear all data: ${table} failed:`, error.message)
    } catch (error) {
      console.error(`Clear all data: ${table} failed:`, error.message)
    }
    return { table, status: 'failed' }
  }))
  const pick = (status) => results.filter((result) => result.status === status).map((result) => result.table)
  return { cleared: pick('cleared'), failed: pick('failed') }
}

async function findUserByUsername(supabase, username) {
  const { data, error } = await supabase.from('users').select('*').eq('username', username).maybeSingle()
  if (error) throw Object.assign(new Error('Database unavailable. Please try again.'), { status: 503 })
  return data || null
}

async function answerMatches(user, answer) {
  const status = recoveryStatus(user)
  if (status === 'hashed') return bcrypt.compare(normalizeAnswer(answer), user.recovery_answer)
  if (status === 'legacy') return normalizeAnswer(answer) === normalizeAnswer(user.recovery_answer)
  return false
}

// A password change or reset bumps token_version, signing out every other device.
function afterPasswordChange(user, patch) {
  if ('token_version' in user) patch.token_version = (user.token_version || 0) + 1
  if ('failed_attempts' in user) Object.assign(patch, { failed_attempts: 0, locked_until: null })
  return patch
}

// Signed-out devices must stop receiving reminders too; keep only the device making the change.
// Without token_version (older database) other devices stay signed in, so their reminders stay too.
async function forgetOtherDevices(supabase, user, keepEndpoint) {
  if (!('token_version' in user)) return
  let query = supabase.from('push_subscriptions').delete().eq('user_id', user.id)
  const keep = typeof keepEndpoint === 'string' ? keepEndpoint.slice(0, 1000) : ''
  if (keep) query = query.neq('endpoint', keep)
  const { error } = await query
  if (error && !/push_subscriptions|42P01|PGRST205/.test(`${error.code} ${error.message}`)) console.error('Push cleanup failed:', error.message)
}

// Sessions slide: a check more than a day after the token was issued returns a fresh one,
// so people who use the app are never signed out by the 30-day expiry.
const RENEW_AFTER_SECONDS = 86400

export default async function handler(req, res) {
  try {
    const method = req.method || 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Cache-Control', 'no-store')

    if (method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }

    const supabase = getSupabase()

    if (method === 'GET') {
      const decoded = verifyRequestToken(req)
      if (!decoded) return sendJson(res, 401, { error: 'Invalid session' })
      const user = await verifyTokenVersion(supabase, decoded)
      if (!user) return sendJson(res, 401, { error: 'Invalid session' })
      const renew = Date.now() / 1000 - (decoded.iat || 0) > RENEW_AFTER_SECONDS
      return sendJson(res, 200, { user: publicUser(user), ...(renew ? { token: signToken(user) } : {}) })
    }

    if (method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.' })

    const body = await readJsonBody(req)
    const action = body.action
    const ip = clientIp(req)

    if (action === 'signup') {
      if (process.env.ALLOW_SIGNUPS === 'false') {
        return sendJson(res, 403, { error: 'New sign-ups are closed.' })
      }
      if (!(await underLimit(supabase, `signup:${ip}`, 5, 3600))) return tooMany(res, 60)

      const username = String(body.username || '').trim().toLowerCase()
      const password = String(body.password || '').trim()
      const question = String(body.recoveryQuestion || '').trim()
      const answer = normalizeAnswer(body.recoveryAnswer)

      if (!USERNAME_PATTERN.test(username)) {
        return sendJson(res, 400, { error: 'Usernames are 3–32 characters: letters, numbers, dots, dashes or underscores.' })
      }
      const problem = passwordProblem(password) || recoveryProblem(question, answer)
      if (problem) return sendJson(res, 400, { error: problem })

      if (await findUserByUsername(supabase, username)) {
        return sendJson(res, 409, { error: 'That username is already taken.' })
      }

      const [passwordHash, answerHash] = await Promise.all([bcrypt.hash(password, 10), bcrypt.hash(answer, 10)])
      const { data: user, error } = await supabase
        .from('users')
        .insert({ username, password_hash: passwordHash, recovery_question: question, recovery_answer: answerHash })
        .select('*')
        .single()

      if (error?.code === '23505') return sendJson(res, 409, { error: 'That username is already taken.' })
      if (error || !user) return sendJson(res, 500, { error: 'Unable to create account.' })

      return sendJson(res, 200, { token: signToken(user), user: publicUser(user) })
    }

    if (action === 'login') {
      if (!(await underLimit(supabase, `login:${ip}`, 30, 600))) return tooMany(res, 10)

      const username = String(body.username || '').trim().toLowerCase()
      const password = String(body.password || '').trim()
      if (!username || !password) return sendJson(res, 400, { error: 'Enter your username and password.' })

      const user = await findUserByUsername(supabase, username)
      const minutes = lockedMinutes(user)
      if (minutes) return tooMany(res, minutes)

      const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH)
      if (!user || !passwordMatches) {
        await recordFailure(supabase, user)
        return sendJson(res, 401, { error: 'Incorrect username or password.' })
      }

      await clearFailures(supabase, user)
      return sendJson(res, 200, { token: signToken(user), user: publicUser(user) })
    }

    if (action === 'forgot') {
      if (!(await underLimit(supabase, `recover:${ip}`, 20, 600))) return tooMany(res, 10)

      const username = String(body.username || '').trim().toLowerCase()
      if (!username) return sendJson(res, 400, { error: 'Enter your username.' })

      const user = await findUserByUsername(supabase, username)
      if (!user) return sendJson(res, 404, { error: 'No account found with that username.' })
      if (recoveryStatus(user) === 'none') {
        return sendJson(res, 409, { error: 'Password reset isn’t set up for this account. If you can still log in, add a recovery question in Settings → Security.' })
      }

      return sendJson(res, 200, { question: user.recovery_question || 'Your recovery question' })
    }

    if (action === 'reset') {
      if (!(await underLimit(supabase, `recover:${ip}`, 20, 600))) return tooMany(res, 10)

      const username = String(body.username || '').trim().toLowerCase()
      const newPassword = String(body.newPassword || '').trim()
      if (!username || !normalizeAnswer(body.answer) || !newPassword) {
        return sendJson(res, 400, { error: 'Enter your answer and a new password.' })
      }
      const problem = passwordProblem(newPassword)
      if (problem) return sendJson(res, 400, { error: problem })

      const user = await findUserByUsername(supabase, username)
      if (!user) return sendJson(res, 404, { error: 'No account found with that username.' })
      const minutes = lockedMinutes(user)
      if (minutes) return tooMany(res, minutes)
      if (recoveryStatus(user) === 'none') {
        return sendJson(res, 409, { error: 'Password reset isn’t set up for this account.' })
      }

      if (!(await answerMatches(user, body.answer))) {
        await recordFailure(supabase, user)
        return sendJson(res, 400, { error: 'That answer doesn’t match.' })
      }

      const patch = afterPasswordChange(user, { password_hash: await bcrypt.hash(newPassword, 10) })
      // Upgrade older plain-text answers to a hash now that we know the answer.
      if (recoveryStatus(user) === 'legacy') patch.recovery_answer = await bcrypt.hash(normalizeAnswer(body.answer), 10)

      const { error: updateError } = await supabase.from('users').update(patch).eq('id', user.id)
      if (updateError) return sendJson(res, 500, { error: 'Unable to update password.' })
      await forgetOtherDevices(supabase, user, body.keepEndpoint)

      const updated = { ...user, ...patch }
      return sendJson(res, 200, { token: signToken(updated), user: publicUser(updated) })
    }

    // Everything below needs a signed-in user who confirms their current password.
    if (action === 'change' || action === 'set_recovery') {
      const decoded = verifyRequestToken(req)
      if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      const user = await verifyTokenVersion(supabase, decoded)
      if (!user) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      const minutes = lockedMinutes(user)
      if (minutes) return tooMany(res, minutes)

      const currentPassword = String(body.currentPassword || '').trim()
      if (!currentPassword) return sendJson(res, 400, { error: 'Enter your current password.' })
      if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
        await recordFailure(supabase, user)
        return sendJson(res, 400, { error: 'Current password is incorrect.' })
      }

      let patch
      if (action === 'change') {
        const newPassword = String(body.newPassword || '').trim()
        const problem = passwordProblem(newPassword)
        if (problem) return sendJson(res, 400, { error: problem })
        patch = afterPasswordChange(user, { password_hash: await bcrypt.hash(newPassword, 10) })
      } else {
        const question = String(body.question || '').trim()
        const answer = normalizeAnswer(body.answer)
        const problem = recoveryProblem(question, answer)
        if (problem) return sendJson(res, 400, { error: problem })
        patch = { recovery_question: question, recovery_answer: await bcrypt.hash(answer, 10) }
        if ('failed_attempts' in user) Object.assign(patch, { failed_attempts: 0, locked_until: null })
      }

      const { error: updateError } = await supabase.from('users').update(patch).eq('id', user.id)
      if (updateError) return sendJson(res, 500, { error: 'Unable to save that change.' })
      if (action === 'change') await forgetOtherDevices(supabase, user, body.keepEndpoint)

      const updated = { ...user, ...patch }
      // A new token keeps this device signed in after other devices are signed out.
      return sendJson(res, 200, { ok: true, token: signToken(updated), user: publicUser(updated) })
    }

    // Settings → Danger zone → "Clear all data". Deletes everything the user has added and keeps
    // the account, its sign-in and push registrations. The session (token) is left unchanged.
    if (action === 'wipe') {
      const decoded = verifyRequestToken(req)
      if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      const user = await verifyTokenVersion(supabase, decoded)
      if (!user?.id) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      const minutes = lockedMinutes(user)
      if (minutes) return tooMany(res, minutes)

      const password = String(body.password || '').trim()
      if (!password) return sendJson(res, 400, { error: 'Enter your password.' })
      if (!(await underLimit(supabase, `wipe:${user.id}`, WIPE_LIMIT, 3600))) return tooMany(res, 60)

      // Always a full bcrypt compare, so a missing hash takes as long as a wrong password.
      const passwordMatches = await bcrypt.compare(password, user.password_hash || DUMMY_HASH)
      if (!user.password_hash || !passwordMatches) {
        await recordFailure(supabase, user)
        // `code` tells the app this 401 is a wrong password, not an expired session.
        return sendJson(res, 401, { error: 'Wrong password.', code: 'wrong_password' })
      }
      await clearFailures(supabase, user)

      const { cleared, failed } = await wipeUserData(supabase, user.id)
      if (failed.length) {
        // Safe to retry: deleting again only removes what is left.
        return sendJson(res, 500, { error: 'Some of your data couldn’t be cleared. Please try again.', cleared, failed })
      }
      return sendJson(res, 200, { ok: true, cleared })
    }

    return sendJson(res, 404, { error: 'Unknown auth action.' })
  } catch (error) {
    console.error('Auth API error:', error)
    if (isConfigError(error)) {
      return sendJson(res, 503, {
        error: error.message.startsWith('Server setup problem') ? error.message : 'Server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and JWT_SECRET in Vercel.'
      })
    }
    if (error.status === 503) return sendJson(res, 503, { error: error.message })
    return sendJson(res, 500, { error: 'Something went wrong. Please try again.' })
  }
}
