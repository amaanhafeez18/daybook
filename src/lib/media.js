// Attachments for the assistant and food estimates. Photos are downscaled to JPEG on the device
// (which also strips EXIF/GPS), PDFs travel as data URLs and text files as plain text.
// Browser-only at call time (canvas, FileReader); nothing touches window at import.

export const MAX_ATTACHMENT_BYTES = 3_200_000 // total raw bytes per message (base64 adds a third; Vercel caps bodies at 4.5 MB)
export const MAX_PDF_BYTES = 3_000_000
export const MAX_TEXT_CHARS = 60_000
// Never add image/heic here: Safari 17+ would then convert every JPEG and PNG to HEIC.
export const attachmentAccept = 'image/*,application/pdf,text/plain,text/csv,text/markdown,.txt,.csv,.md,.json'

const UNSUPPORTED = 'Only photos, PDFs and text files can be attached.'
const UNDECODABLE = 'This photo format isn’t supported here — try a JPEG or PNG.'
const PROCESS_FAILED = 'Couldn’t process that photo — try another one.'
const READ_FAILED = 'Couldn’t read that file.'
const TRUNCATED = '\n[…truncated]'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp'])
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'md', 'markdown', 'json'])
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/x-markdown', 'application/json'])
const DEFAULT_NAMES = { image: 'photo.jpg', pdf: 'document.pdf', text: 'file.txt' }

function extension(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || '').trim())
  return match ? match[1].toLowerCase() : ''
}

// 'image' | 'pdf' | 'text' | null. The extension wins over the MIME type: iOS often reports an
// empty type for .md/.csv, and Windows labels .csv as application/vnd.ms-excel.
export function attachmentKind(file) {
  const ext = extension(file?.name)
  const type = String(file?.type || '').toLowerCase().split(';')[0].trim()
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('image/')) return 'image'
  if (TEXT_TYPES.has(type)) return 'text'
  return null
}

// Decoded size of a data URL (or bare base64) without decoding it.
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return 0
  let payload = dataUrl
  if (dataUrl.startsWith('data:')) {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return 0
    payload = dataUrl.slice(comma + 1)
    if (!/;base64$/i.test(dataUrl.slice(0, comma))) {
      try {
        return utf8Bytes(decodeURIComponent(payload))
      } catch {
        return payload.length
      }
    }
  }
  if (/\s/.test(payload)) payload = payload.replace(/\s+/g, '')
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(((payload.length - padding) * 3) / 4))
}

// Raw bytes a list of attachments will send (uses `bytes` when present, else measures the content).
export function totalBytes(attachments) {
  if (!Array.isArray(attachments)) return 0
  let sum = 0
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue
    if (Number.isFinite(item.bytes) && item.bytes >= 0) sum += item.bytes
    else if (typeof item.dataUrl === 'string') sum += dataUrlBytes(item.dataUrl)
    else if (typeof item.text === 'string') sum += utf8Bytes(item.text)
  }
  return sum
}

export async function imageToJpegDataUrl(file, { maxDim = 1600, quality = 0.8 } = {}) {
  if (!isBlob(file)) throw new Error(UNSUPPORTED)
  const limit = Number(maxDim) > 0 ? Number(maxDim) : 1600
  const q = Number(quality) > 0 ? Math.min(1, Number(quality)) : 0.8
  const url = URL.createObjectURL(file)
  const canvas = document.createElement('canvas')
  try {
    const img = await decodeImage(url)
    const scale = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * scale))
    const height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(PROCESS_FAILED)
    ctx.fillStyle = '#fff' // transparent PNGs become white, not black
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height) // modern Safari/Chrome apply EXIF orientation here
    return await readAsDataUrl(await canvasToJpeg(canvas, q))
  } finally {
    canvas.width = 0 // release iOS canvas memory
    canvas.height = 0
    URL.revokeObjectURL(url)
  }
}

// → { kind: 'image'|'pdf'|'text', name, dataUrl?|text?, bytes }. Throws a friendly Error.
export async function readAttachment(file) {
  if (!isBlob(file)) throw new Error(UNSUPPORTED)
  const kind = attachmentKind(file)
  if (!kind) throw new Error(UNSUPPORTED)
  const name = displayName(file.name, kind)
  if (!file.size) throw new Error('That file is empty.')

  if (kind === 'image') {
    const dataUrl = await imageToJpegDataUrl(file)
    return { kind, name, dataUrl, bytes: dataUrlBytes(dataUrl) }
  }

  if (kind === 'pdf') {
    if (file.size > MAX_PDF_BYTES) throw new Error('PDFs can be up to 3 MB.')
    // The PDF header must sit in the first 1024 bytes; catching junk here beats an opaque API error.
    const head = decodeText(new Uint8Array(await readBuffer(file.slice(0, 1024))))
    if (!head.includes('%PDF')) throw new Error('That PDF looks damaged — try exporting it again.')
    const encoded = await readAsDataUrl(file)
    // iOS can report an empty or generic type, so set the MIME type ourselves.
    const dataUrl = `data:application/pdf;base64,${encoded.slice(encoded.indexOf(',') + 1)}`
    return { kind, name, dataUrl, bytes: file.size }
  }

  const text = await readText(file)
  return { kind, name, text, bytes: utf8Bytes(text) }
}

function isBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function displayName(name, kind) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!clean) return DEFAULT_NAMES[kind]
  return clean.length > 120 ? `${clean.slice(0, 100)}…${clean.slice(-19)}` : clean
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length
}

async function decodeImage(url) {
  const img = new Image()
  img.decoding = 'async'
  const loaded = new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
  })
  loaded.catch(() => {}) // only awaited on the fallback path
  img.src = url
  try {
    if (typeof img.decode === 'function') await img.decode()
    else await loaded
  } catch {
    // decode() can reject for images that still load (very large ones in some browsers): trust the load events.
    try {
      await loaded
    } catch {
      throw new Error(UNDECODABLE) // e.g. HEIC on desktop Chrome/Firefox
    }
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error(UNDECODABLE)
  return img
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof canvas.toBlob !== 'function') {
        const dataUrl = canvas.toDataURL('image/jpeg', quality)
        if (!dataUrl.startsWith('data:image/jpeg')) throw new Error(PROCESS_FAILED)
        resolve(dataUrl)
        return
      }
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(PROCESS_FAILED))), 'image/jpeg', quality)
    } catch {
      reject(new Error(PROCESS_FAILED)) // tainted or oversized canvas
    }
  })
}

// Accepts a Blob, or passes an already-encoded data URL straight through.
function readAsDataUrl(blob) {
  if (typeof blob === 'string') return Promise.resolve(blob)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(READ_FAILED))
    reader.readAsDataURL(blob)
  })
}

function readBuffer(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().catch(() => { throw new Error(READ_FAILED) })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error(READ_FAILED))
    reader.readAsArrayBuffer(blob)
  })
}

// UTF-8 unless a UTF-16 byte-order mark says otherwise (Notepad's "Unicode"). BOMs are dropped.
function decodeText(bytes) {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  try {
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

async function readText(file) {
  // Read only what can survive the cap (≤ 4 bytes per character) so a huge CSV never loads whole.
  const limit = MAX_TEXT_CHARS * 4 + 4
  const bytes = new Uint8Array(await readBuffer(file.size > limit ? file.slice(0, limit) : file))
  const text = decodeText(bytes).replace(/\r\n?/g, '\n')
  if (text.includes('\u0000')) throw new Error('That file doesn’t look like text.')
  if (!text.trim()) throw new Error('That file is empty.')
  return capText(text)
}

function capText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text
  let cut = MAX_TEXT_CHARS - TRUNCATED.length
  const newline = text.lastIndexOf('\n', cut)
  if (newline > cut - 2000) cut = newline // end on a whole line (keeps CSV rows intact)
  else if (text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) cut -= 1 // don't split an emoji
  return text.slice(0, cut) + TRUNCATED
}
