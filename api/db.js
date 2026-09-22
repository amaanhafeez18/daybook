import { createClient } from '@supabase/supabase-js'
import jwt from 'jsonwebtoken'

export function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. Add them in Vercel Project Settings → Environment Variables.')
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  })
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
