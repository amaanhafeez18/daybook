import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { getSupabase, readJsonBody, getJwtSecret, verifyRequestToken } from './db.js'

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

function isConfigError(error) {
  return /Missing SUPABASE_URL|Missing JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY|Environment Variables/.test(error?.message || '')
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function buildToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, getJwtSecret(), { expiresIn: '30d' })
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

// Lockout uses users.failed_attempts / users.locked_until when those columns exist
// (supabase/migrations/2026-09-23-auth-hardening.sql); without them it is skipped.
function lockedMinutes(user) {
  if (!user?.locked_until) return 0
  const remaining = new Date(user.locked_until).getTime() - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 60000) : 0
}

async function recordFailure(supabase, user) {
  if (!user || !('failed_attempts' in user)) return
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

function lockedResponse(res, minutes) {
  return sendJson(res, 429, { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` })
}

async function findUserByUsername(supabase, username) {
  const { data } = await supabase.from('users').select('*').eq('username', username).maybeSingle()
  return data || null
}

async function answerMatches(user, answer) {
  const status = recoveryStatus(user)
  if (status === 'hashed') return bcrypt.compare(normalizeAnswer(answer), user.recovery_answer)
  if (status === 'legacy') return normalizeAnswer(answer) === normalizeAnswer(user.recovery_answer)
  return false
}

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

      const { data: user } = await supabase.from('users').select('*').eq('id', decoded.id).maybeSingle()
      if (!user) return sendJson(res, 401, { error: 'Invalid session' })

      return sendJson(res, 200, { user: publicUser(user) })
    }

    if (method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.' })

    const body = await readJsonBody(req)
    const action = body.action

    if (action === 'signup') {
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

      return sendJson(res, 200, { token: buildToken(user), user: publicUser(user) })
    }

    if (action === 'login') {
      const username = String(body.username || '').trim().toLowerCase()
      const password = String(body.password || '').trim()
      if (!username || !password) return sendJson(res, 400, { error: 'Enter your username and password.' })

      const user = await findUserByUsername(supabase, username)
      const minutes = lockedMinutes(user)
      if (minutes) return lockedResponse(res, minutes)

      const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH)
      if (!user || !passwordMatches) {
        await recordFailure(supabase, user)
        return sendJson(res, 401, { error: 'Incorrect username or password.' })
      }

      await clearFailures(supabase, user)
      return sendJson(res, 200, { token: buildToken(user), user: publicUser(user) })
    }

    if (action === 'forgot') {
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
      if (minutes) return lockedResponse(res, minutes)
      if (recoveryStatus(user) === 'none') {
        return sendJson(res, 409, { error: 'Password reset isn’t set up for this account.' })
      }

      if (!(await answerMatches(user, body.answer))) {
        await recordFailure(supabase, user)
        return sendJson(res, 400, { error: 'That answer doesn’t match.' })
      }

      const patch = { password_hash: await bcrypt.hash(newPassword, 10) }
      // Upgrade older plain-text answers to a hash now that we know the answer.
      if (recoveryStatus(user) === 'legacy') patch.recovery_answer = await bcrypt.hash(normalizeAnswer(body.answer), 10)
      if ('failed_attempts' in user) Object.assign(patch, { failed_attempts: 0, locked_until: null })

      const { error: updateError } = await supabase.from('users').update(patch).eq('id', user.id)
      if (updateError) return sendJson(res, 500, { error: 'Unable to update password.' })

      return sendJson(res, 200, { token: buildToken(user), user: publicUser({ ...user, ...patch }) })
    }

    // Everything below needs a signed-in user who confirms their current password.
    if (action === 'change' || action === 'set_recovery') {
      const decoded = verifyRequestToken(req)
      if (!decoded) return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })

      const { data: user } = await supabase.from('users').select('*').eq('id', decoded.id).maybeSingle()
      if (!user) return sendJson(res, 401, { error: 'Invalid session' })
      const minutes = lockedMinutes(user)
      if (minutes) return lockedResponse(res, minutes)

      const currentPassword = String(body.currentPassword || '').trim()
      if (!currentPassword) return sendJson(res, 400, { error: 'Enter your current password.' })
      if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
        await recordFailure(supabase, user)
        return sendJson(res, 400, { error: 'Current password is incorrect.' })
      }

      const patch = {}
      if (action === 'change') {
        const newPassword = String(body.newPassword || '').trim()
        const problem = passwordProblem(newPassword)
        if (problem) return sendJson(res, 400, { error: problem })
        patch.password_hash = await bcrypt.hash(newPassword, 10)
      } else {
        const question = String(body.question || '').trim()
        const answer = normalizeAnswer(body.answer)
        const problem = recoveryProblem(question, answer)
        if (problem) return sendJson(res, 400, { error: problem })
        patch.recovery_question = question
        patch.recovery_answer = await bcrypt.hash(answer, 10)
      }
      if ('failed_attempts' in user) Object.assign(patch, { failed_attempts: 0, locked_until: null })

      const { error: updateError } = await supabase.from('users').update(patch).eq('id', user.id)
      if (updateError) return sendJson(res, 500, { error: 'Unable to save that change.' })

      return sendJson(res, 200, { ok: true, user: publicUser({ ...user, ...patch }) })
    }

    return sendJson(res, 404, { error: 'Unknown auth action.' })
  } catch (error) {
    console.error('Auth API error:', error)
    if (isConfigError(error)) {
      return sendJson(res, 503, {
        error: 'Server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and JWT_SECRET in Vercel.'
      })
    }
    return sendJson(res, 500, { error: 'Something went wrong. Please try again.' })
  }
}
