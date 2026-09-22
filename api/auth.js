import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { getSupabase, readJsonBody, getJwtSecret, verifyRequestToken } from './db.js'

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

export default async function handler(req, res) {
  try {
    const method = req.method || 'GET'

    if (method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      return res.end()
    }

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    const supabase = getSupabase()

    if (method === 'GET') {
      const decoded = verifyRequestToken(req)
      if (!decoded) {
        return sendJson(res, 401, { error: 'Invalid session' })
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, username')
        .eq('id', decoded.id)
        .single()

      if (error || !user) {
        return sendJson(res, 401, { error: 'Invalid session' })
      }

      return sendJson(res, 200, { user: { id: user.id, username: user.username } })
    }

    const body = await readJsonBody(req)
    const action = body.action

    if (action === 'signup') {
      const username = String(body.username || '').trim()
      const password = String(body.password || '').trim()
      const recoveryAnswer = String(body.recoveryAnswer || '').trim()

      if (!username || !password || !recoveryAnswer) {
        return sendJson(res, 400, { error: 'Username, password and recovery answer are required.' })
      }

      const safeUsername = username.toLowerCase()
      const { data: existingUser } = await supabase
        .from('users')
        .select('id')
        .eq('username', safeUsername)
        .maybeSingle()

      if (existingUser) {
        return sendJson(res, 409, { error: 'That username is already taken.' })
      }

      const passwordHash = await bcrypt.hash(password, 10)
      const { data: user, error } = await supabase
        .from('users')
        .insert({
          username: safeUsername,
          password_hash: passwordHash,
          recovery_question: 'What is that you are worried about?',
          recovery_answer: recoveryAnswer.trim().toLowerCase()
        })
        .select('id, username')
        .single()

      if (error || !user) {
        return sendJson(res, 500, { error: 'Unable to create account.' })
      }

      return sendJson(res, 200, {
        token: buildToken(user),
        user: { id: user.id, username: user.username }
      })
    }

    if (action === 'login') {
      const username = String(body.username || '').trim().toLowerCase()
      const password = String(body.password || '').trim()

      if (!username || !password) {
        return sendJson(res, 400, { error: 'Username and password are required.' })
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, username, password_hash, recovery_question')
        .eq('username', username)
        .single()

      if (error || !user) {
        return sendJson(res, 401, { error: 'Invalid username or password.' })
      }

      const passwordMatches = await bcrypt.compare(password, user.password_hash)
      if (!passwordMatches) {
        return sendJson(res, 401, { error: 'Invalid username or password.' })
      }

      return sendJson(res, 200, {
        token: buildToken(user),
        user: { id: user.id, username: user.username }
      })
    }

    if (action === 'forgot') {
      const username = String(body.username || '').trim().toLowerCase()
      if (!username) {
        return sendJson(res, 400, { error: 'Username is required.' })
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, username, recovery_question')
        .eq('username', username)
        .single()

      if (error || !user) {
        return sendJson(res, 404, { error: 'No account found for that username.' })
      }

      return sendJson(res, 200, {
        question: user.recovery_question || 'What is that you are worried about?'
      })
    }

    if (action === 'reset') {
      const username = String(body.username || '').trim().toLowerCase()
      const answer = String(body.answer || '').trim().toLowerCase()
      const newPassword = String(body.newPassword || '').trim()

      if (!username || !answer || !newPassword) {
        return sendJson(res, 400, { error: 'Username, answer, and a new password are required.' })
      }

      if (answer !== 'me') {
        return sendJson(res, 400, { error: 'That answer is not correct.' })
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, username, recovery_answer')
        .eq('username', username)
        .single()

      if (error || !user) {
        return sendJson(res, 404, { error: 'No account found for that username.' })
      }

      const passwordHash = await bcrypt.hash(newPassword, 10)
      const { error: updateError } = await supabase
        .from('users')
        .update({ password_hash: passwordHash })
        .eq('id', user.id)

      if (updateError) {
        return sendJson(res, 500, { error: 'Unable to update password.' })
      }

      return sendJson(res, 200, {
        token: buildToken({ id: user.id, username: user.username }),
        user: { id: user.id, username: user.username }
      })
    }

    if (action === 'change') {
      const decoded = verifyRequestToken(req)
      if (!decoded) {
        return sendJson(res, 401, { error: 'Your session has expired. Please log in again.' })
      }

      const currentPassword = String(body.currentPassword || '').trim()
      const newPassword = String(body.newPassword || '').trim()
      if (!currentPassword || !newPassword) {
        return sendJson(res, 400, { error: 'Enter your current password and a new password.' })
      }
      if (newPassword.length < 6) {
        return sendJson(res, 400, { error: 'New password must be at least 6 characters.' })
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, password_hash')
        .eq('id', decoded.id)
        .single()

      if (error || !user) {
        return sendJson(res, 401, { error: 'Invalid session' })
      }

      const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash)
      if (!passwordMatches) {
        return sendJson(res, 400, { error: 'Current password is incorrect.' })
      }

      const passwordHash = await bcrypt.hash(newPassword, 10)
      const { error: updateError } = await supabase
        .from('users')
        .update({ password_hash: passwordHash })
        .eq('id', user.id)

      if (updateError) {
        return sendJson(res, 500, { error: 'Unable to update password.' })
      }

      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'Unknown auth action.' })
  } catch (error) {
    console.error('Auth API error:', error)
    if (isConfigError(error)) {
      return sendJson(res, 503, {
        error: 'Server is not configured yet. Add SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and JWT_SECRET in Vercel.'
      })
    }
    return sendJson(res, 500, { error: error.message || 'Unexpected auth error.' })
  }
}
