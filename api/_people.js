// Finding the person the user means ("Hassan", "hasan bhai", "Mo", "Ali from work") among their People.
// Pure: no imports, no I/O. Friends are rows from the friends table (snake_case) or the app
// (camelCase); only id, name, organization, facts/note and current_status are read.

const isObj = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// Words that are not part of a name: honorifics, kinship terms used as titles, and fillers.
const FILLERS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'prof', 'professor', 'sir', 'madam', 'maam', 'dame', 'lord',
  'uncle', 'aunty', 'auntie', 'aunt', 'bro', 'bruh', 'bhai', 'bhaiya', 'bhaijan', 'bhaijaan', 'bhayya',
  'sahab', 'sahib', 'saab', 'ji', 'jee', 'baji', 'apa', 'appi', 'aapi', 'khala', 'mamu', 'mamoo', 'chacha', 'chachu',
  'phuppo', 'phupho', 'sheikh', 'shaikh', 'hajji', 'haji', 'ustad', 'ustadh', 'imam', 'maulana', 'moulana',
  'my', 'our', 'the', 'friend', 'buddy', 'mate', 'pal', 'dude', 'homie',
])

// A "name" made only of these describes someone instead ("my boss", "the guy from the gym").
const GENERIC = new Set([
  'someone', 'somebody', 'person', 'guy', 'girl', 'lady', 'man', 'woman', 'colleague', 'coworker', 'workmate',
  'boss', 'manager', 'teacher', 'classmate', 'neighbour', 'neighbor', 'that', 'this', 'one', 'a', 'an',
])

// Spelling variants and nicknames that name the same person. A name can sit in several groups
// (Chris: Christopher and Christine), so two names match only when they share a group.
const NAME_GROUPS = [
  // Arabic / South Asian spellings
  ['hassan', 'hasan', 'hasaan'],
  ['hussain', 'husain', 'hussein', 'husein', 'hossein', 'hosain', 'husayn'],
  ['muhammad', 'mohammad', 'mohammed', 'muhammed', 'mohamed', 'mohamad', 'muhamad', 'mohd', 'md', 'mo', 'moh', 'mhd'],
  ['ahmed', 'ahmad', 'ahmet'],
  ['usman', 'osman', 'uthman', 'othman', 'usmaan', 'osmaan'],
  ['umar', 'omar', 'omer', 'umer'],
  ['yusuf', 'yousuf', 'yousaf', 'yousef', 'youssef', 'yusef', 'yosef', 'yusof'],
  ['ibrahim', 'ebrahim', 'ibraheem', 'ebraheem', 'ibrahem'],
  ['zain', 'zayn', 'zane', 'zein', 'zayne'],
  ['ayesha', 'aisha', 'aysha', 'aishah', 'ayisha', 'aesha', 'ayeshah'],
  ['fatima', 'fatimah', 'fatema', 'fathima', 'fatma'],
  ['hamza', 'hamzah', 'hamzeh'],
  ['ali', 'aly'],
  ['abdullah', 'abdallah', 'abdulla'],
  ['abdulrahman', 'abdurrahman', 'abdurahman', 'abdelrahman', 'abdalrahman', 'abdulrehman'],
  ['mustafa', 'mustapha', 'mostafa', 'moustafa'],
  ['khalid', 'khaled'],
  ['tariq', 'tarik', 'tareq', 'tarek'],
  ['bilal', 'belal'],
  ['imran', 'emran'],
  ['irfan', 'erfan'],
  ['faisal', 'faysal', 'feisal', 'faizal'],
  ['zubair', 'zubayr', 'zobair', 'zubeir'],
  ['junaid', 'junayd', 'junaed'],
  ['owais', 'uwais', 'awais', 'uways', 'owais'],
  ['yasir', 'yasser', 'yaser', 'yassir'],
  ['nasir', 'nasser', 'naser', 'nassir'],
  ['mahmood', 'mahmud', 'mehmood', 'mahmoud', 'mehmud'],
  ['mahdi', 'mehdi'],
  ['sulaiman', 'suleman', 'sulayman', 'suleiman', 'soliman', 'sulaman', 'sulemaan'],
  ['idris', 'idrees', 'edris'],
  ['ismail', 'ismael', 'esmail', 'ismaeel'],
  ['yahya', 'yahia', 'yehya'],
  ['musa', 'moosa', 'mousa'],
  ['isa', 'eesa', 'essa'],
  ['haris', 'harris', 'haaris'],
  ['maryam', 'mariam', 'miriam', 'mariyam', 'maryum'],
  ['khadija', 'khadijah', 'khadeeja', 'khadeejah'],
  ['zainab', 'zaynab', 'zeinab', 'zenab'],
  ['noor', 'nur', 'nour'],
  ['sara', 'sarah'],
  ['hina', 'heena'],
  ['rabia', 'rabiya', 'rabiah', 'rabiaa'],
  ['sumaya', 'sumayya', 'sumaiya', 'somaya', 'sumayyah'],
  ['ruqayya', 'ruqaya', 'rukaya', 'ruqaiya', 'ruqayyah'],
  ['aaliyah', 'aliya', 'aliyah', 'alia', 'aaliya'],
  ['rehan', 'rayhan', 'raihan', 'rehaan', 'reyhan'],
  ['shoaib', 'shuaib', 'shuayb', 'shoaib'],
  ['qasim', 'kasim', 'qassim', 'kassim'],
  ['qadir', 'kadir', 'qader'],
  ['naveed', 'navid'],
  ['waleed', 'walid'],
  ['saeed', 'said', 'sayeed', 'saeid', 'saied'],
  ['sadiq', 'sadik', 'saadiq'],
  ['tahir', 'taher'],
  ['zahid', 'zahed'],
  ['shahid', 'shaheed', 'shahed'],
  ['amir', 'ameer', 'aamir', 'emir'],
  ['asad', 'assad', 'asaad'],
  ['raza', 'rida', 'reza', 'ridha', 'riza'],
  ['haider', 'haidar', 'hyder', 'heydar', 'haidar'],
  ['jafar', 'jaffar', 'jaafar'],
  ['fahad', 'fahd'],
  ['huzaifa', 'hudhayfah', 'huzaifah', 'hudaifa', 'huzefa'],
  ['ubaid', 'obaid', 'ubayd'],
  ['uzair', 'uzayr', 'ozair'],
  ['sohail', 'suhail', 'suhayl'],
  ['ayub', 'ayoub', 'ayyub', 'ayoob'],
  ['yaqub', 'yakub', 'yaqoob', 'yakoob', 'yacoub', 'yaqoub'],
  ['dawood', 'dawud', 'daud', 'dawoud', 'davood'],
  ['zakaria', 'zakariya', 'zakariyya', 'zakariah', 'zakariyah'],
  ['anwar', 'anwer'],
  ['rizwan', 'ridwan', 'rezwan'],
  ['luqman', 'lukman', 'loqman'],
  ['nouman', 'noman', 'numan', 'nauman', 'noaman'],
  ['sufyan', 'sufian', 'sofian', 'sofyan'],
  ['moiz', 'muiz', 'moez'],
  ['ehsan', 'ihsan'],
  ['hasnain', 'husnain'],
  ['shahzad', 'shehzad'],
  ['shahbaz', 'shehbaz'],
  ['yasmin', 'yasmeen', 'yasmine', 'jasmin', 'jasmine'],
  ['mohsin', 'muhsin'],
  ['mujtaba', 'mojtaba'],
  ['hafsa', 'hafsah'],
  ['talha', 'talhah'],
  // English nicknames
  ['alexander', 'alex', 'alec', 'xander', 'sasha'],
  ['alexandra', 'alex', 'lexi', 'sasha', 'alexa'],
  ['michael', 'mike', 'mikey', 'mick', 'mickey'],
  ['christopher', 'chris', 'kris', 'topher'],
  ['christine', 'christina', 'chris', 'kris', 'tina', 'kristina', 'kristin'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['matthew', 'matt', 'matty'],
  ['william', 'will', 'bill', 'billy', 'liam', 'willy'],
  ['robert', 'rob', 'bob', 'bobby', 'robbie', 'bert'],
  ['elizabeth', 'liz', 'lizzie', 'lizzy', 'beth', 'betty', 'eliza', 'libby', 'lisa'],
  ['katherine', 'catherine', 'kathryn', 'katharine', 'kate', 'katie', 'kathy', 'cathy', 'kat', 'kitty'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davey'],
  ['thomas', 'tom', 'tommy'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['joseph', 'joe', 'joey'],
  ['nicholas', 'nick', 'nicky', 'nico'],
  ['benjamin', 'ben', 'benny', 'benji'],
  ['anthony', 'tony', 'ant'],
  ['andrew', 'andy', 'drew'],
  ['stephen', 'steven', 'steve', 'stevie'],
  ['jennifer', 'jen', 'jenny', 'jenn'],
  ['richard', 'rich', 'rick', 'ricky', 'richie'],
  ['edward', 'ed', 'eddie', 'ted', 'teddy', 'ned'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'trish', 'tricia'],
  ['gregory', 'greg'],
  ['jonathan', 'jon', 'jonny', 'johnny'],
  ['john', 'jon', 'johnny', 'jack'],
  ['abigail', 'abby', 'abbie', 'gail'],
  ['rebecca', 'becky', 'becca'],
  ['margaret', 'meg', 'maggie', 'peggy', 'marge'],
  ['susan', 'sue', 'suzie', 'suzy'],
  ['jessica', 'jess', 'jessie'],
  ['victoria', 'vicky', 'vicki', 'tori'],
  ['nathan', 'nathaniel', 'nate'],
  ['zachary', 'zach', 'zack', 'zak'],
  ['joshua', 'josh'],
  ['charles', 'charlie', 'chuck', 'chaz'],
  ['henry', 'harry', 'hank'],
  ['harold', 'harry', 'hal'],
  ['frederick', 'fred', 'freddie', 'freddy'],
  ['timothy', 'tim', 'timmy'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['lawrence', 'laurence', 'larry', 'laurie'],
  ['peter', 'pete'],
  ['philip', 'phillip', 'phil'],
  ['raymond', 'ray'],
  ['samira', 'sami'],
  ['deborah', 'debra', 'debbie', 'deb'],
  ['pamela', 'pam'],
  ['jacqueline', 'jackie'],
  ['natalie', 'nat', 'natalia'],
  ['olivia', 'liv', 'livvy'],
  ['isabella', 'isabel', 'isabelle', 'bella', 'izzy'],
  ['gabriel', 'gabe'],
  ['gabriella', 'gabrielle', 'gabby', 'gabi'],
]

// ---- normalising ---------------------------------------------------------------------------------

// Lower case, accents dropped, possessive "'s" dropped, anything else non-alphanumeric → one space.
function plain(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]s\b/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function stripFillers(tokens) {
  // "my friend", "from work" etc. are handled by the caller; here single filler words go.
  const kept = tokens.filter((token) => !FILLERS.has(token))
  return kept.length ? kept : tokens // a name that is only "filler" words keeps them
}

// A person's name or a reference to one, cleaned for matching: 'Hassan bhai's' → 'hassan'.
export function normalizeName(text) {
  const tokens = plain(String(text ?? '').replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean)
  return stripFillers(tokens).join(' ')
}

// "Ali from work" → { name: 'ali', context: 'work' }; "Sara (uni)" → { name: 'sara', context: 'uni' }.
function parseQuery(query) {
  let source = String(query ?? '')
  const contexts = []
  source = source.replace(/\(([^)]*)\)/g, (_, inner) => {
    contexts.push(inner)
    return ' '
  })
  const split = /\s(?:from|at|of|who works at|who works in|who works for|in)\s/i.exec(` ${source} `)
  if (split) {
    const at = split.index
    const padded = ` ${source} `
    contexts.push(padded.slice(at + split[0].length))
    source = padded.slice(0, at)
  }
  return { name: normalizeName(source), context: contexts.map(plain).filter(Boolean).join(' ') }
}

// Lighter spelling key: doubled letters, trailing h, ee/ea → i, oo/ou → u, aa → a, ph → f.
// Hassan/Hasan, Saleem/Salim, Yousuf/Yusuf and Fatimah/Fatima share a key; Hassan/Hussain don't.
function spellKey(token) {
  let s = String(token || '')
  s = s.replace(/ph/g, 'f').replace(/ee|ea/g, 'i').replace(/oo|ou/g, 'u').replace(/aa/g, 'a')
  s = s.replace(/(.)\1+/g, '$1')
  if (s.length > 3) s = s.replace(/h$/, '')
  return s
}

// Loose consonant skeleton (Hassan and Hussain both → 'hsn'): only for suggestions, never a match.
function skeleton(text) {
  const s = spellKey(String(text || '').replace(/\s+/g, ''))
    .replace(/[ck]h/g, 'k').replace(/q|c/g, 'k').replace(/gh/g, 'g').replace(/th|dh/g, 't').replace(/z/g, 's').replace(/w/g, 'v')
  if (!s) return ''
  const first = /[aeiouy]/.test(s[0]) ? 'a' : s[0]
  return (first + s.slice(1).replace(/[aeiouyh]/g, '')).replace(/(.)\1+/g, '$1')
}

const groupIndex = new Map()
NAME_GROUPS.forEach((group, index) => {
  for (const name of group) {
    const key = spellKey(name)
    if (!groupIndex.has(key)) groupIndex.set(key, new Set())
    groupIndex.get(key).add(index)
  }
})

function sameGroup(a, b) {
  const ga = groupIndex.get(spellKey(a))
  const gb = groupIndex.get(spellKey(b))
  if (!ga || !gb) return false
  for (const index of ga) if (gb.has(index)) return true
  return false
}

// Optimal-string-alignment Damerau-Levenshtein distance (a transposition counts as one edit).
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

// Edits allowed between two names (measured on their spelling keys): none up to 3 letters (Ali/Adi/Avi
// are different people), 1 up to 5 letters, 2 beyond. Hassan/Hussain (hasan/husain) stay apart.
function allowedEdits(a, b) {
  const length = Math.min(a.length, b.length)
  return length <= 3 ? 0 : length <= 5 ? 1 : 2
}

// ---- friends ------------------------------------------------------------------------------------

function friendView(friend) {
  const name = normalizeName(friend.name)
  const tokens = name ? name.split(' ') : []
  const about = plain([
    friend.organization, friend.facts, friend.note, friend.current_status ?? friend.currentStatus, friend.relationship,
    ...(String(friend.name || '').match(/\(([^)]*)\)/g) || []),
  ].filter((part) => typeof part === 'string').join(' '))
  return { friend, name, tokens, compact: tokens.join(''), first: tokens[0] || '', last: tokens.length > 1 ? tokens[tokens.length - 1] : '', org: plain(friend.organization), about }
}

const WORK_WORDS = ['work', 'office', 'job', 'colleague', 'coworker', 'workmate', 'team', 'company']
const STUDY_WORDS = ['uni', 'university', 'college', 'school', 'class', 'campus', 'classmate', 'course']
const CONTEXT_STOP = new Set(['the', 'my', 'a', 'an', 'our', 'his', 'her', 'their', 'one', 'that', 'this', 'someone', 'somebody', 'person'])

function contextWords(context) {
  return context.split(' ').filter((word) => word && !CONTEXT_STOP.has(word))
}

// Every context word (or a synonym, for work and study) appears in what we know about the person.
function matchesContext(view, words) {
  if (!words.length) return false
  const about = ` ${view.about} `
  return words.every((word) => {
    const options = WORK_WORDS.includes(word) ? WORK_WORDS : STUDY_WORDS.includes(word) ? STUDY_WORDS : [word]
    return options.some((option) => about.includes(` ${option} `) || (option.length >= 4 && about.includes(` ${option}`)))
  })
}

// The views that fit "from work" / "at Acme"; for work, someone with an organisation fits when nobody's
// details mention it.
function narrowByContext(views, words) {
  if (!words.length) return []
  const direct = views.filter((view) => matchesContext(view, words))
  if (direct.length || !words.some((word) => WORK_WORDS.includes(word))) return direct
  return views.filter((view) => view.org)
}

// Name tiers, strongest first. Each takes (query, friend view) → boolean.
const TIERS = [
  {
    how: 'exact',
    test: (q, f) => q.name === f.name || (q.compact.length > 3 && q.compact === f.compact),
  },
  {
    how: 'name', // first name or surname, or every word of a longer query
    test: (q, f) => (q.tokens.length === 1
      ? q.name === f.first || q.name === f.last
      : q.tokens.every((token) => f.tokens.includes(token))),
  },
  {
    how: 'spelling', // Hassan/Hasan, Saleem/Salim
    test: (q, f) => {
      const eq = (a, b) => !!a && !!b && spellKey(a) === spellKey(b)
      if (q.tokens.length === 1) return eq(q.name, f.first) || eq(q.name, f.last) || eq(q.compact, f.compact)
      return eq(q.compact, f.compact) || q.tokens.every((token) => f.tokens.some((part) => eq(token, part)))
    },
  },
  {
    how: 'nickname', // Mohammad/Muhammad/Mo, Mike/Michael
    test: (q, f) => {
      const eq = (a, b) => !!a && !!b && (a === b || spellKey(a) === spellKey(b) || sameGroup(a, b))
      if (q.tokens.length === 1) return eq(q.name, f.first) || eq(q.name, f.last) || sameGroup(q.compact, f.compact)
      return q.tokens.every((token) => f.tokens.some((part) => eq(token, part)))
    },
  },
]

// Edits between two names when within the allowance (0 for spelling or nickname variants), else null.
function nameDistance(a, b) {
  if (!a || !b) return null
  if (spellKey(a) === spellKey(b) || sameGroup(a, b)) return 0
  const distance = Math.min(editDistance(a, b), editDistance(spellKey(a), spellKey(b)))
  return distance <= allowedEdits(spellKey(a), spellKey(b)) ? distance : null
}

// Typo distance to a friend: a one-word query against the first name or surname; a longer one word by
// word against first name and surname (Ali Hamza is not Ali Raza), or as a whole with one edit.
function fuzzyDistance(q, f) {
  if (q.tokens.length === 1) {
    const found = [nameDistance(q.name, f.first), nameDistance(q.name, f.last)].filter((d) => d !== null)
    return found.length ? Math.min(...found) : null
  }
  const whole = Math.min(editDistance(q.compact, f.compact), editDistance(spellKey(q.compact), spellKey(f.compact)))
  if (whole <= 1) return whole
  if (!f.last) return null
  const first = nameDistance(q.tokens[0], f.first)
  const last = nameDistance(q.tokens[q.tokens.length - 1], f.last)
  return first === null || last === null ? null : first + last
}

function uniqueFriends(list) {
  const seen = new Set()
  return list.filter((friend) => {
    const key = friend.id ?? friend
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Close but not a match, best first: the same consonant skeleton (Hassan/Hussain), a looser edit
// distance, a shared start, or the name mentioned in someone's details.
function suggest(q, views, limit = 3) {
  const token = q.tokens[0] || ''
  if (token.length < 2) return []
  const qSkeleton = skeleton(token)
  const scored = []
  for (const view of views) {
    if (!view.first) continue
    const distance = Math.min(editDistance(spellKey(token), spellKey(view.first)), view.last ? editDistance(spellKey(token), spellKey(view.last)) : 99)
    let score = null
    if (qSkeleton.length >= 2 && (skeleton(view.first) === qSkeleton || (view.last && skeleton(view.last) === qSkeleton))) score = 1
    else if (distance <= 2 && Math.min(token.length, view.first.length) >= 4) score = 2
    else if (token.length >= 4 && view.first.startsWith(token.slice(0, 3))) score = 3
    else if (token.length >= 3 && ` ${view.about} `.includes(` ${token} `)) score = 4
    if (score !== null) scored.push({ view, score, distance })
  }
  return scored
    .sort((a, b) => a.score - b.score || a.distance - b.distance)
    .slice(0, limit)
    .map((item) => item.view.friend)
}

function refTarget(refs, key) {
  if (refs instanceof Map) return refs.get(key)
  return isObj(refs) ? refs[key] : undefined
}

const FIRM = new Set(['id', 'ref', 'exact', 'name'])

// Who the user means. query: a friend id, a staged ref ('$1', looked up in refs: a Map or object of
// ref → id or friend-like object), or a name as the user said it ("hassan bhai", "Ali from work").
// → { match, how, assumed, narrowedBy? } | { ambiguous: [friend] } | { none: true, similar: [friend] }
// how: 'id' | 'ref' | 'exact' | 'name' | 'spelling' | 'nickname' | 'fuzzy' | 'org'. assumed is true
// from 'spelling' on: say so ("I assumed Hasan Raza"). narrowedBy 'context': "from work" picked one
// of several. A ref that isn't in refs (or points nowhere) gives { none: true, similar: [] }.
export function resolveFriend(friends, query, refs) {
  const people = (Array.isArray(friends) ? friends : []).filter((friend) => isObj(friend) && (friend.id !== undefined || friend.name))
  const raw = typeof query === 'number' ? String(query) : typeof query === 'string' ? query.trim() : ''
  if (!raw) return { none: true, similar: [] }

  // 1. ids and staged refs
  const byId = people.find((friend) => friend.id !== undefined && friend.id !== null && String(friend.id) === raw)
  if (byId) return { match: byId, how: 'id', assumed: false }
  if (/^\$\d+$/.test(raw)) {
    const target = refTarget(refs, raw)
    if (isObj(target)) {
      const known = target.id !== undefined ? people.find((friend) => String(friend.id) === String(target.id)) : null
      return { match: known || target, how: 'ref', assumed: false }
    }
    if (typeof target === 'string' || typeof target === 'number') {
      const known = people.find((friend) => String(friend.id) === String(target))
      if (known) return { match: known, how: 'ref', assumed: false }
    }
    return { none: true, similar: [] }
  }

  const parsed = parseQuery(raw)
  let tokens = parsed.name ? parsed.name.split(' ') : []
  let context = parsed.context
  // "my boss", "the guy from the gym": a description, not a name.
  if (tokens.length && tokens.every((token) => GENERIC.has(token) || FILLERS.has(token))) {
    context = [tokens.join(' '), context].filter(Boolean).join(' ')
    tokens = []
  }
  const q = { name: tokens.join(' '), tokens, compact: tokens.join('') }
  const words = contextWords(context)
  const views = people.map(friendView)

  // Several hits: "from work" / "at Acme" may pick one.
  const settle = (hits, how) => {
    const assumed = !FIRM.has(how)
    const unique = uniqueFriends(hits.map((view) => view.friend))
    if (unique.length === 1) return { match: unique[0], how, assumed }
    const narrowed = uniqueFriends(narrowByContext(hits, words).map((view) => view.friend))
    if (narrowed.length === 1) return { match: narrowed[0], how, assumed, narrowedBy: 'context' }
    return { ambiguous: (narrowed.length > 1 ? narrowed : unique).slice(0, 6) }
  }

  if (q.name) {
    // 2–5. exact name, first name or surname, spelling variant, nickname
    for (const tier of TIERS) {
      const hits = views.filter((view) => view.name && tier.test(q, view))
      if (hits.length) return settle(hits, tier.how)
    }
    // 6. a small typo (the closest ones)
    let best = null
    let fuzzyHits = []
    for (const view of views) {
      const distance = view.name ? fuzzyDistance(q, view) : null
      if (distance === null) continue
      if (best === null || distance < best) {
        best = distance
        fuzzyHits = [view]
      } else if (distance === best) fuzzyHits.push(view)
    }
    if (fuzzyHits.length) return settle(fuzzyHits, 'fuzzy')
    return { none: true, similar: suggest(q, views) }
  }

  // 7. no name, only a description: organisation or details ("someone from Acme", "my boss")
  const hits = narrowByContext(views, words)
  if (hits.length === 1) return { match: hits[0].friend, how: 'org', assumed: true }
  if (hits.length > 1) return { ambiguous: uniqueFriends(hits.map((view) => view.friend)).slice(0, 6) }
  return { none: true, similar: [] }
}

// People who may already be `name` (before adding someone: "Hassan" when Hasan Raza exists). The same
// name up to spelling or nickname, a small typo, or a one-word name that is someone's first name.
// Best first, at most `limit`.
export function similarFriends(friends, name, limit = 3) {
  const people = (Array.isArray(friends) ? friends : []).filter((friend) => isObj(friend) && typeof friend.name === 'string' && friend.name.trim())
  const cleaned = normalizeName(name)
  if (!cleaned) return []
  const tokens = cleaned.split(' ')
  const q = { name: cleaned, tokens, compact: tokens.join('') }
  const eq = (a, b) => !!a && !!b && (a === b || spellKey(a) === spellKey(b) || sameGroup(a, b))
  const near = (a, b) => nameDistance(a, b) !== null
  const scored = []
  for (const view of people.map(friendView)) {
    if (!view.name) continue
    const single = q.tokens.length === 1 || view.tokens.length === 1
    let score = null
    if (q.name === view.name || q.compact === view.compact) score = 0
    else if (eq(q.compact, view.compact) || (q.tokens.length === view.tokens.length && q.tokens.every((token, i) => eq(token, view.tokens[i])))) score = 1
    else if (single && eq(q.tokens[0], view.first)) score = 2
    else if (!single && near(q.tokens[0], view.first) && near(q.tokens[q.tokens.length - 1], view.last)) score = 3
    else if (single && near(q.tokens[0], view.first)) score = 4
    if (score !== null) scored.push({ friend: view.friend, score })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, Math.max(0, limit)).map((item) => item.friend)
}
