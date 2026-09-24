// Attachments for the assistant and food estimates. Photos are downscaled to JPEG on the device
// (which also strips EXIF/GPS). Photos and PDFs upload straight to storage (prepareAttachment →
// uploadAttachment), so they skip Vercel's 4.5 MB request limit; when storage isn't available they
// travel inside the request as data URLs (inlineAttachment / readAttachment). Text files always
// travel as plain text. Browser-only at call time (canvas, FileReader, XHR); nothing touches window
// at import.

import { apiRequest } from './api.js'

export const MAX_ATTACHMENTS = 10 // per message
export const MAX_PDF_BYTES = 50_000_000 // one PDF, uploaded to storage
export const MAX_UPLOAD_TOTAL = 50_000_000 // everything one message uploads to storage
export const MAX_IMAGE_UPLOAD_BYTES = 15_000_000 // the server's cap for one photo (ours are well under 1 MB)
// The inline fallback (data URLs inside the chat request): base64 adds a third, and Vercel refuses
// request bodies over 4.5 MB.
export const MAX_ATTACHMENT_BYTES = 3_200_000 // inline bytes per message (text files count too)
export const MAX_INLINE_PDF_BYTES = 3_000_000
export const MAX_TEXT_CHARS = 60_000
export const UPLOAD_ENDPOINT = '/api/assistant?upload=1'
// Never add image/heic here: Safari 17+ would then convert every JPEG and PNG to HEIC.
export const attachmentAccept = 'image/*,application/pdf,text/plain,text/csv,text/markdown,.txt,.csv,.md,.json'
export const photoAccept = 'image/*'
export const fileAccept = 'application/pdf,text/plain,text/csv,text/markdown,.pdf,.txt,.csv,.md,.json'

const UNSUPPORTED = 'Only photos, PDFs and text files can be attached.'
const UNDECODABLE = 'This photo format isn’t supported here — try a JPEG or PNG.'
const PROCESS_FAILED = 'Couldn’t process that photo — try another one.'
const READ_FAILED = 'Couldn’t read that file.'
const EMPTY = 'That file is empty.'
const DAMAGED_PDF = 'That PDF looks damaged — try exporting it again.'
const UPLOAD_FAILED = 'Couldn’t upload that file. Check your connection and try again.'
const TRUNCATED = '\n[…truncated]'
const UPLOAD_TYPES = { image: 'image/jpeg', pdf: 'application/pdf' }

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

export async function imageToJpegDataUrl(file, options) {
  return readAsDataUrl(await renderJpeg(file, options))
}

// The same downscaled JPEG as a Blob, for uploading.
export async function imageToJpegBlob(file, options) {
  const out = await renderJpeg(file, options)
  return typeof out === 'string' ? dataUrlToBlob(out) : out
}

// Blob, or a data URL on browsers without canvas.toBlob.
async function renderJpeg(file, { maxDim = 1600, quality = 0.8 } = {}) {
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
    return await canvasToJpeg(canvas, q)
  } finally {
    canvas.width = 0 // release iOS canvas memory
    canvas.height = 0
    URL.revokeObjectURL(url)
  }
}

// → { kind: 'image'|'pdf'|'text', name, dataUrl?|text?, bytes } for sending inside the request.
// Throws a friendly Error.
export async function readAttachment(file) {
  if (!isBlob(file)) throw new Error(UNSUPPORTED)
  const kind = attachmentKind(file)
  if (!kind) throw new Error(UNSUPPORTED)
  const name = displayName(file.name, kind)
  if (!file.size) throw new Error(EMPTY)

  if (kind === 'image') {
    const dataUrl = await imageToJpegDataUrl(file)
    return { kind, name, dataUrl, bytes: dataUrlBytes(dataUrl) }
  }

  if (kind === 'pdf') {
    if (file.size > MAX_INLINE_PDF_BYTES) throw new Error(`PDFs can be up to ${formatBytes(MAX_INLINE_PDF_BYTES)}.`)
    await checkPdf(file)
    return { kind, name, dataUrl: await pdfDataUrl(file), bytes: file.size }
  }

  const text = await readText(file)
  return { kind, name, text, bytes: utf8Bytes(text) }
}

// A picked or pasted file, ready to upload: photos downscaled to a JPEG Blob (with an object URL for
// the preview; revoke it with revokePreview), PDFs checked. Text files are read as text.
// → { kind: 'image'|'pdf', name, type, blob, bytes, previewUrl? } | { kind: 'text', name, text, bytes }.
// Throws a friendly Error.
export async function prepareAttachment(file) {
  if (!isBlob(file)) throw new Error(UNSUPPORTED)
  const kind = attachmentKind(file)
  if (!kind) throw new Error(UNSUPPORTED)
  const name = displayName(file.name, kind)
  if (!file.size) throw new Error(EMPTY)

  if (kind === 'image') {
    const blob = await imageToJpegBlob(file)
    if (!blob.size) throw new Error(PROCESS_FAILED)
    if (blob.size > MAX_IMAGE_UPLOAD_BYTES) throw new Error('That photo is too big — try another one.')
    return { kind, name: jpegName(name), type: UPLOAD_TYPES.image, blob, bytes: blob.size, previewUrl: objectUrl(blob) }
  }

  if (kind === 'pdf') {
    if (file.size > MAX_PDF_BYTES) throw new Error(`PDFs can be up to ${formatBytes(MAX_PDF_BYTES)}.`)
    await checkPdf(file)
    // iOS can report an empty or generic type; slicing re-labels it without copying the bytes.
    return { kind, name, type: UPLOAD_TYPES.pdf, blob: file.slice(0, file.size, UPLOAD_TYPES.pdf), bytes: file.size }
  }

  const text = await readText(file)
  return { kind, name, text, bytes: utf8Bytes(text) }
}

// A prepared photo or PDF as a data URL, for when uploading isn't possible (inline limits apply).
// → { kind, name, dataUrl, bytes } (text passes through as { kind, name, text, bytes }).
// A PDF over the inline limit throws an Error with code 'too_big_inline'.
export async function inlineAttachment(prepared) {
  const { kind, name } = prepared || {}
  if (kind === 'text' && typeof prepared.text === 'string') return { kind, name, text: prepared.text, bytes: utf8Bytes(prepared.text) }
  if (!UPLOAD_TYPES[kind] || !isBlob(prepared.blob)) throw new Error(UNSUPPORTED)
  if (kind === 'pdf' && prepared.blob.size > MAX_INLINE_PDF_BYTES) {
    throw Object.assign(new Error(`${name} is over ${formatBytes(MAX_INLINE_PDF_BYTES)}, and big files can’t be uploaded right now. Try a smaller PDF, or try again later.`), { code: 'too_big_inline' })
  }
  const dataUrl = kind === 'pdf' ? await pdfDataUrl(prepared.blob) : relabel(await readAsDataUrl(prepared.blob), UPLOAD_TYPES.image)
  return { kind, name, dataUrl, bytes: prepared.blob.size }
}

// Uploads a prepared photo or PDF straight to storage: asks the server for a signed upload URL, then
// PUTs the bytes there (XHR, for progress). onProgress(0…1); abort with `signal` (rejects with an
// AbortError). → { kind, name, path, bytes }.
// Failures are Errors with `status`/`code`, and `fallback: true` when sending the file inline instead
// might still work (storage isn't set up, or the upload itself failed).
export async function uploadAttachment(prepared, { onProgress, signal } = {}) {
  const { kind, name } = prepared || {}
  if (!UPLOAD_TYPES[kind] || !isBlob(prepared.blob)) throw new Error(UNSUPPORTED)
  if (signal?.aborted) throw abortError()
  const type = prepared.type || UPLOAD_TYPES[kind]
  const size = prepared.blob.size
  let target
  try {
    target = await apiRequest(UPLOAD_ENDPOINT, { method: 'POST', body: { action: 'upload', name, type, size }, signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const code = error?.payload?.code || ''
    throw uploadError(error?.message || UPLOAD_FAILED, { status: error?.status ?? 0, code, fallback: code === 'storage_unavailable' })
  }
  const path = typeof target?.path === 'string' ? target.path : ''
  const uploadUrl = typeof target?.uploadUrl === 'string' ? target.uploadUrl : ''
  if (!path || !uploadUrl) throw uploadError(UPLOAD_FAILED, { code: 'bad_response', fallback: true })
  onProgress?.(0)
  await putBlob(uploadUrl, prepared.blob, type, { onProgress, signal })
  onProgress?.(1)
  return { kind, name, path, bytes: size }
}

// Frees a preview made by prepareAttachment.
export function revokePreview(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url)
    } catch {
      // already gone
    }
  }
}

// "2.4 MB" (decimal, as iOS and macOS show file sizes).
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1000) return `${value} B`
  if (value < 1_000_000) return `${Math.round(value / 1000)} KB`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}

function putBlob(url, blob, type, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof XMLHttpRequest === 'undefined') {
      reject(uploadError(UPLOAD_FAILED, { fallback: true }))
      return
    }
    const xhr = new XMLHttpRequest()
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    function onAbort() {
      finish(abortError())
      try {
        xhr.abort()
      } catch {
        // not started
      }
    }
    if (signal?.aborted) {
      finish(abortError())
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) finish()
      else finish(uploadError(xhr.status === 413 ? 'That file is too big to upload.' : UPLOAD_FAILED, { status: xhr.status, code: 'upload_failed', fallback: true }))
    }
    xhr.onerror = () => finish(uploadError(UPLOAD_FAILED, { code: 'network', fallback: true }))
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => finish(abortError())
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (event) => {
        // Never report 1 before the storage server has answered.
        if (event.lengthComputable && event.total > 0) onProgress(Math.min(0.99, event.loaded / event.total))
      }
    }
    try {
      xhr.open('PUT', url)
      xhr.setRequestHeader('Content-Type', type)
      xhr.setRequestHeader('x-upsert', 'false')
      xhr.send(blob)
    } catch {
      finish(uploadError(UPLOAD_FAILED, { code: 'network', fallback: true }))
    }
  })
}

function uploadError(message, { status = 0, code = '', fallback = false } = {}) {
  return Object.assign(new Error(message), { status, code, fallback })
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The upload was cancelled.', 'AbortError')
  return Object.assign(new Error('The upload was cancelled.'), { name: 'AbortError' })
}

function isBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function objectUrl(blob) {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : ''
  } catch {
    return ''
  }
}

// "IMG_1234.HEIC" → "IMG_1234.jpg": the photo is a JPEG once it has been downscaled.
function jpegName(name) {
  return IMAGE_EXTENSIONS.has(extension(name)) ? name.replace(/\.[a-z0-9]+$/i, '.jpg') : `${name}.jpg`
}

// The PDF header must sit in the first 1024 bytes; catching junk here beats an opaque API error.
async function checkPdf(blob) {
  const head = decodeText(new Uint8Array(await readBuffer(blob.slice(0, 1024))))
  if (!head.includes('%PDF')) throw new Error(DAMAGED_PDF)
}

// iOS can report an empty or generic type, so set the MIME type ourselves.
async function pdfDataUrl(blob) {
  return relabel(await readAsDataUrl(blob), UPLOAD_TYPES.pdf)
}

function relabel(dataUrl, mime) {
  return `data:${mime};base64,${dataUrl.slice(dataUrl.indexOf(',') + 1)}`
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',')
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: /^data:([^;,]+)/.exec(dataUrl)?.[1] || UPLOAD_TYPES.image })
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
