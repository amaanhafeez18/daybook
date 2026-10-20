// Prints a session token for a zz- test account, so a browser can be signed in without typing a
// password (set localStorage 'daybook.session.token'). Only zz- accounts, by design: real accounts
// are never signed into this way. The token is signed with this machine's JWT_SECRET, so it only
// works against a local server (npm run dev:cloud), never the live site.
//
//   node scripts/test-login.mjs zz-claude
//
// Behind a proxy run it like dev-cloud.mjs does: NODE_USE_ENV_PROXY=1 on Node 22.21+.
import { getSupabase, signToken } from '../api/db.js'

const username = String(process.argv[2] || '').trim().toLowerCase()
if (!username.startsWith('zz-')) {
  console.error('Usage: node scripts/test-login.mjs zz-<name>   (only zz- test accounts)')
  process.exit(1)
}

const { data: user, error } = await getSupabase().from('users').select('*').eq('username', username).maybeSingle()
if (error) {
  console.error(`Database error: ${error.message}`)
  process.exit(1)
}
if (!user) {
  console.error(`No account named ${username}. Sign up once through the local server first.`)
  process.exit(1)
}
console.log(signToken(user))
