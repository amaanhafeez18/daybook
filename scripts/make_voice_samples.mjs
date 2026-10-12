// Makes the short voice samples Settings → Voice plays (public/voices/<voice>.mp3), one per realtime
// voice in src/lib/voice/prefs.js. Run once, by hand, when the voice list changes:
//   node scripts/make_voice_samples.mjs            (skips samples that already exist)
//   node scripts/make_voice_samples.mjs --force    (makes them all again)
// Needs OPENAI_API_KEY in the environment or in .env (never printed). Uses gpt-4o-mini-tts, which has
// the same named voices as the realtime model; ten 3-second samples cost about a cent in total.
// The files are fetched only when a ▶ is tapped and stay out of the offline precache (vite.config.js).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VOICE_NAMES } from '../src/lib/voice/prefs.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'voices')
const force = process.argv.includes('--force')

function apiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  try {
    const line = readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).find((row) => /^\s*OPENAI_API_KEY\s*=/.test(row))
    return line ? line.replace(/^\s*OPENAI_API_KEY\s*=\s*/, '').replace(/^["']|["']$/g, '').trim() : ''
  } catch {
    return ''
  }
}

const key = apiKey()
if (!key) {
  console.error('OPENAI_API_KEY is missing (environment or .env).')
  process.exit(1)
}
mkdirSync(out, { recursive: true })

const name = (id) => id.charAt(0).toUpperCase() + id.slice(1)
let made = 0
for (const voice of VOICE_NAMES) {
  const file = join(out, `${voice}.mp3`)
  if (!force && existsSync(file)) {
    console.log(`${voice}: already there`)
    continue
  }
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice,
      input: `Hi, I'm ${name(voice)}. Want me to plan your day?`,
      instructions: 'Warm, relaxed and natural, like a friendly assistant on a phone call. Normal pace.',
      response_format: 'mp3',
    }),
  })
  if (!response.ok) {
    console.error(`${voice}: failed (${response.status}) ${(await response.text()).slice(0, 200)}`)
    process.exitCode = 1
    continue
  }
  const audio = Buffer.from(await response.arrayBuffer())
  writeFileSync(file, audio)
  made += 1
  console.log(`${voice}: ${Math.round(audio.length / 1024)} KB`)
}
console.log(`Made ${made} sample${made === 1 ? '' : 's'} in public/voices/.`)
