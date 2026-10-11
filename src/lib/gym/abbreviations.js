// Short routine codes for tight spaces (the Gym calendar grid, the Today week strip). Pure: no
// browser or React code, so it can be tested and imported anywhere.
//
// 1–2 characters, unique among the user's routines (in their order): the first letter, then the
// first letters of later words ('Upper B' → 'UB'), then the first letter plus a later consonant,
// digit or vowel ('Push' → 'P', 'Pull' → 'Pl').

const ALNUM = /[\p{L}\p{N}]/u
const LETTER = /\p{L}/u
const DIGIT = /\p{N}/u
const VOWEL = /[aeiouyàáâäãåæèéêëìíîïòóôöõøùúûüÿ]/i

export function abbreviationOptions(name) {
  const text = String(name || '').trim()
  const chars = [...text].filter((char) => ALNUM.test(char))
  if (!chars.length) return []
  const first = chars[0].toLocaleUpperCase()
  const options = [first]
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  for (const word of words.slice(1)) options.push(first + [...word][0].toLocaleUpperCase())
  const rest = chars.slice(1).map((char) => char.toLocaleLowerCase())
  const consonants = rest.filter((char) => LETTER.test(char) && !VOWEL.test(char))
  const digits = rest.filter((char) => DIGIT.test(char))
  const vowels = rest.filter((char) => VOWEL.test(char))
  for (const char of [...consonants, ...digits, ...vowels]) options.push(first + char)
  return [...new Set(options)]
}

// Map of routine id → code.
export function routineAbbreviations(routines) {
  const used = new Set()
  const out = new Map()
  for (const routine of Array.isArray(routines) ? routines : []) {
    const options = abbreviationOptions(routine?.name)
    if (!options.length) {
      out.set(routine?.id, '•') // no letters or digits to use
      continue
    }
    let pick = options.find((option) => !used.has(option.toLocaleUpperCase()))
    for (let n = 2; n <= 9 && !pick; n++) {
      const candidate = `${[...options[0]][0]}${n}`
      if (!used.has(candidate.toLocaleUpperCase())) pick = candidate
    }
    pick = pick || options[0]
    used.add(pick.toLocaleUpperCase())
    out.set(routine?.id, pick)
  }
  return out
}
