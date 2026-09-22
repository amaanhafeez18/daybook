import { createClient } from '@supabase/supabase-js'
import jwt from 'jsonwebtoken'

let warnedAboutKey = false

export function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. Add them in Vercel Project Settings → Environment Variables.')
  }

  // The server needs the secret key: with Row Level Security on, the public key can't see any rows.
  if (!warnedAboutKey && (key.startsWith('sb_publishable_') || isAnonJwt(key))) {
    warnedAboutKey = true
    console.warn('SUPABASE_SERVICE_ROLE_KEY looks like the public (publishable/anon) key. Use the secret key from Supabase → Project Settings → API Keys.')
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  })
}

function isAnonJwt(key) {
  if (!key.startsWith('eyJ')) return false
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'
  } catch {
    return false
  }
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

export function parseAuthHeader(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  return token
}

// No fallback secret: a default would let anyone forge tokens if the env var is missing.
export function getJwtSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('Missing JWT_SECRET environment variable. Add it in Vercel Project Settings → Environment Variables.')
  }
  return secret
}

// Returns the decoded token, or null when it is missing, expired, or invalid.
export function verifyRequestToken(req) {
  const secret = getJwtSecret()
  const token = parseAuthHeader(req)
  if (!token) return null
  try {
    return jwt.verify(token, secret)
  } catch {
    return null
  }
}

export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, tv: user.token_version ?? 0 }, getJwtSecret(), { expiresIn: '30d' })
}

// A token is only valid while its version matches the user's token_version, which goes up when
// the password changes — that signs out every other device. Returns the user row or null.
// Throws on database errors (callers answer 503, not "logged out").
export async function verifyTokenVersion(supabase, decoded) {
  const { data: user, error } = await supabase.from('users').select('*').eq('id', decoded.id).maybeSingle()
  if (error) throw Object.assign(new Error('Database unavailable. Please try again.'), { status: 503 })
  if (!user) return null
  if ('token_version' in user && (decoded.tv ?? 0) !== (user.token_version ?? 0)) return null
  return user
}

// Supabase returns at most 1000 rows per request; this pages through everything.
export async function selectAll(buildQuery, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) return rows
  }
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return String(req.headers['x-real-ip'] || forwarded || req.socket?.remoteAddress || 'unknown')
}

// Fixed-window rate limit backed by the daybook_throttle database function
// (supabase/migrations/2026-09-23-auth-hardening.sql). Allows the request if it isn't set up.
export async function underLimit(supabase, key, limit, windowSeconds) {
  const { data, error } = await supabase.rpc('daybook_throttle', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds })
  if (error) return true
  return data !== false
}
