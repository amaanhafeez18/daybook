// Which one of your people a piece of text is about ("Coffee with Sam" → Sam), for offering to
// log a catch-up when such a task is ticked off. Pure and browser-free (no store, no React).
//
// personInText(text, friends) → { friend, name } | null
//   - whole words only, any case ("Ali" never matches inside "Alignment");
//   - a full name ("Sam Lee") wins over first names; otherwise a first name of 3+ letters;
//   - only when exactly ONE person matches (two Sams and "Call Sam" → null);
//   - first names that are also everyday words ("May", "Will", "Mark") count only when written
//     with a capital letter in the middle of the text ("Dinner with Will", not "Will call back");
//   - text can be a task: the app's own "Talk to …" reminders (details "friend-reminder:…") are
//     skipped, since ticking those logs the catch-up already.

const COMMON_WORDS = new Set([
  'amber', 'april', 'art', 'ash', 'august', 'autumn', 'bill', 'blue', 'brook', 'buck', 'carol', 'cat', 'chase',
  'chip', 'christian', 'clay', 'cliff', 'crystal', 'dale', 'dash', 'dawn', 'dean', 'dell', 'destiny', 'don', 'dot',
  'drew', 'eve', 'faith', 'fern', 'frank', 'gene', 'glen', 'grace', 'grant', 'guy', 'hazel', 'heath', 'holly',
  'honey', 'hope', 'hunter', 'iris', 'ivy', 'jack', 'jade', 'jan', 'jasmine', 'jay', 'jewel', 'joy', 'june', 'king',
  'kit', 'lane', 'lily', 'mark', 'march', 'mason', 'matt', 'max', 'may', 'melody', 'miles', 'misty', 'nick',
  'olive', 'pat', 'patience', 'pearl', 'penny', 'pepper', 'piper', 'rain', 'ray', 'reed', 'rich', 'river', 'robin',
  'rock', 'rose', 'ruby', 'rusty', 'sage', 'sandy', 'scott', 'skip', 'sky', 'sue', 'summer', 'sunny', 'tag', 'tank',
  'terry', 'violet', 'wade', 'will', 'win', 'winter', 'wolf', 'young',
])

const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isReminder = (details) => typeof details === 'string' && details.startsWith('friend-reminder:')

// Where `name` (already folded) appears as a whole word in `text` (folded), as [{ index, word }].
// Not as a contraction ("Don't" isn't Don). No lookbehind: Safari before 16.4 can't parse one.
function wordHits(text, name, flags = 'giu') {
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(${escape(name).replace(/\s+/g, '\\s+')})(?![\\p{L}\\p{N}]|['’]t(?![\\p{L}\\p{N}]))`, flags)
  return [...text.matchAll(pattern)].map((match) => ({ index: match.index + match[0].length - match[1].length, word: match[1] }))
}

// Title Case text ("Pay Electricity Bill"): its capitals don't say what's a name. Looks at the
// words of 3+ letters other than the first one and the name itself.
function titleCase(text, hitIndex) {
  const words = [...text.matchAll(/\p{L}{3,}/gu)].filter((match, i) => i > 0 && match.index !== hitIndex)
  if (!words.length) return false
  return words.filter((match) => /^\p{Lu}/u.test(match[0])).length * 3 >= words.length * 2
}

// A capital letter where a sentence starts doesn't say it's a name.
const sentenceStart = (text, index) => /^[\s"'“‘([-]*$/.test(text.slice(0, index)) || /[.!?:;]\s*["'“‘(]*\s*$/.test(text.slice(0, index))

const MONTHS = new Set(['april', 'august', 'jan', 'june', 'march', 'may'])
// Set phrases where the word is capitalised but no one: "Christmas Eve", "New Year's Eve".
const NOT_AFTER = { eve: /\b(?:christmas|year['’]?s|hallows)\s+$/i }
const DATE_WORDS = /(?:^|\s)(?:in|on|by|until|till|from|since|of|before|after|early|mid|late|end|next|last|this)\s+$/i

// Whether a one-word name that's also a common word is used as a name here: capitalised as
// written, not at the start of a sentence and, for a month, not a date ("in May", "June 3").
function usedAsName(text, name) {
  const capital = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
  const month = MONTHS.has(name.toLowerCase())
  return wordHits(text, capital, 'gu').some((hit) => {
    if (!/^\p{Lu}/u.test(hit.word) || sentenceStart(text, hit.index) || titleCase(text, hit.index)) return false
    if (NOT_AFTER[name.toLowerCase()]?.test(text.slice(0, hit.index))) return false
    if (month && (DATE_WORDS.test(text.slice(0, hit.index)) || /^\s*\d/.test(text.slice(hit.index + hit.word.length)))) return false
    return true
  })
}

// Whether `name` is in the text as a whole word: text is case-folded as written, lower the same
// in lower case (same length, so the two line up).
function nameMatches(text, lower, name) {
  const folded = fold(name).trim().replace(/\s+/g, ' ')
  if (!folded) return false
  const single = !folded.includes(' ')
  if (single && folded.length < 3) return false
  if (!wordHits(lower, folded.toLowerCase()).length) return false
  if (single && COMMON_WORDS.has(folded.toLowerCase())) return usedAsName(text, folded)
  return true
}

// Blanks out where `name` appears, so "Sam Lee" isn't counted again as a "Sam".
function blank(text, name) {
  let out = text
  for (const hit of wordHits(text.toLowerCase(), fold(name).trim().toLowerCase())) {
    out = `${out.slice(0, hit.index)}${' '.repeat(hit.word.length)}${out.slice(hit.index + hit.word.length)}`
  }
  return out
}

export function personInText(text, friends = []) {
  let value = text
  if (value && typeof value === 'object') {
    if (isReminder(value.details)) return null
    value = value.text
  }
  if (typeof value !== 'string' || !value.trim() || !Array.isArray(friends) || !friends.length) return null
  let folded = fold(value)
  const people = friends.filter((friend) => friend && typeof friend.name === 'string' && friend.name.trim())

  // Full names first ("Sam Lee"); then first names in what's left of the text.
  const found = new Set(people.filter((friend) => friend.name.trim().includes(' ') && nameMatches(folded, folded.toLowerCase(), friend.name)))
  for (const friend of found) folded = blank(folded, friend.name)
  const lower = folded.toLowerCase()
  for (const friend of people) {
    if (!found.has(friend) && nameMatches(folded, lower, firstName(friend.name))) found.add(friend)
  }
  if (found.size !== 1) return null
  const [friend] = found
  return { friend, name: firstName(friend.name) }
}

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || ''
}
