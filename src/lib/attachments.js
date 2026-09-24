// Photos and PDFs pinned to a task, a note or a person. The rows live in the store's `attachments`
// list (loaded and cached with everything else); the files sit in a private bucket, so viewing one
// needs a short-lived signed link from /api/files (cached here in memory for most of its hour).
//
//   useAttachmentsFor('task', task.id)        → rows for that target, newest first
//   attachFile(file, 'task', task.id, opts)   → uploads, keeps and adds the row (throws a friendly Error)
//   removeAttachment(id)                       → drops the row; the server removes the file too
//   useSignedUrl(id) / signedUrlsFor(ids)      → links to view the files

import { useEffect, useMemo, useState } from 'react'
import { apiRequest } from './api.js'
import { getState, updateData, useData, useStore } from './store.js'
import { prepareAttachment, revokePreview, uploadAttachment } from './media.js'

export const ATTACHMENT_TARGETS = ['task', 'note', 'friend']
// Photos and PDFs only (no `capture`: iOS then offers the photo library, the camera and Files).
// Never image/heic: Safari would convert every JPEG and PNG to HEIC.
export const attachmentAccept = 'image/*,application/pdf,.pdf'
export const MAX_PER_TARGET = 30

const NOT_SET_UP = 'Attachments aren’t set up yet.'
const ONLY_PHOTOS_PDFS = 'Only photos and PDFs can be attached here.'
const URL_CACHE_MS = 50 * 60 * 1000 // links last an hour; refetch well before that
const BATCH_MS = 20 // thumbnails mounting together share one request
const BATCH_MAX = 100 // the API's cap per request

const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))

export function attachmentsFor(list, targetType, targetId) {
  if (!Array.isArray(list) || !targetId) return []
  return list.filter((item) => item && item.targetType === targetType && item.targetId === targetId).sort(byNewest)
}

export function useAttachmentsFor(targetType, targetId) {
  const all = useData('attachments')
  return useMemo(() => attachmentsFor(all, targetType, targetId), [all, targetType, targetId])
}

// How many files a target has (a number, so rows re-render only when it changes).
export function useAttachmentCount(targetType, targetId) {
  return useStore((state) => (targetId ? state.data.attachments.reduce((count, item) => (item?.targetType === targetType && item.targetId === targetId ? count + 1 : count), 0) : 0))
}

// "2 photos", "1 file", "3 files" (files when any PDF is among them).
export function attachmentSummary(items) {
  const count = items.length
  if (!count) return ''
  const noun = items.some((item) => item.kind === 'pdf') ? 'file' : 'photo'
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// Uploads the file (photos are downscaled on the device), keeps it on the server and adds the
// row to the store. onPrepared({ kind, name, bytes, blob }) runs once the file is ready to go up
// (a preview can be made from the blob); onProgress(0…1) covers the upload; `signal` cancels it.
// Returns the row. Throws an Error whose message can be shown as it is (including the "not set
// up yet" notice when the database lacks the table; its code is 'attachments_missing').
export async function attachFile(file, targetType, targetId, { onPrepared, onProgress, signal, caption } = {}) {
  if (!ATTACHMENT_TARGETS.includes(targetType) || !targetId) throw new Error('Nothing to attach this to.')
  if (attachmentsFor(getState().data.attachments, targetType, targetId).length >= MAX_PER_TARGET) {
    throw new Error(`Up to ${MAX_PER_TARGET} files can be attached here.`)
  }
  const prepared = await prepareAttachment(file)
  try {
    if (prepared.kind !== 'image' && prepared.kind !== 'pdf') throw new Error(ONLY_PHOTOS_PDFS)
    onPrepared?.({ kind: prepared.kind, name: prepared.name, bytes: prepared.bytes, blob: prepared.blob })
    let uploaded
    try {
      uploaded = await uploadAttachment(prepared, { onProgress, signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new Error(error?.code === 'storage_unavailable' ? 'Uploads aren’t available right now. Try again later.' : error?.message || 'Couldn’t upload that file.')
    }
    let reply
    try {
      reply = await apiRequest('/api/files', {
        method: 'POST',
        body: { action: 'keep', path: uploaded.path, name: uploaded.name, kind: uploaded.kind, bytes: uploaded.bytes, targetType, targetId, ...(caption ? { caption } : {}) },
        signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      const code = error?.payload?.code || ''
      const message = code === 'attachments_missing' ? error.message || NOT_SET_UP : error?.status === 0 ? error.message : 'Couldn’t save that file. Try again.'
      throw Object.assign(new Error(message), { code, status: error?.status })
    }
    const attachment = reply?.attachment
    if (!attachment?.id) throw new Error('Couldn’t save that file. Try again.')
    // The server has the row already; the store's save of it is a harmless re-upsert.
    updateData('attachments', (list) => [attachment, ...list.filter((item) => item.id !== attachment.id)])
    return attachment
  } finally {
    revokePreview(prepared.previewUrl)
  }
}

// Removes the row (the server deletes the file with it). Not undoable.
export function removeAttachment(id) {
  urlCache.delete(id)
  updateData('attachments', (list) => (list.some((item) => item.id === id) ? list.filter((item) => item.id !== id) : list))
}

// When a task, note or person is deleted the server removes its files; drop the rows here too.
export function dropAttachmentsFor(targetType, targetIds) {
  const ids = new Set(Array.isArray(targetIds) ? targetIds : [targetIds])
  updateData('attachments', (list) => {
    const match = (item) => item?.targetType === targetType && ids.has(item.targetId)
    if (!list.some(match)) return list
    for (const item of list) if (match(item)) urlCache.delete(item.id)
    return list.filter((item) => !match(item))
  })
}

// ---- signed links ---------------------------------------------------------------------------------
// One request for every thumbnail that mounts in the same tick; results are cached per id (the
// link, not the session token, so it can go into an <img>). null means the server has no such file.

const urlCache = new Map() // id → { url, until }
const inFlight = new Map() // id → Promise<string | null>
let queued = new Map() // id → { resolve, reject }
let queueTimer = null

function cachedUrl(id) {
  const hit = urlCache.get(id)
  if (!hit) return undefined
  if (hit.until > Date.now()) return hit.url
  urlCache.delete(id)
  return undefined
}

function requestUrl(id) {
  const hit = cachedUrl(id)
  if (hit !== undefined) return Promise.resolve(hit)
  if (inFlight.has(id)) return inFlight.get(id)
  const promise = new Promise((resolve, reject) => {
    queued.set(id, { resolve, reject })
    if (!queueTimer) queueTimer = setTimeout(sendQueue, BATCH_MS)
  }).finally(() => inFlight.delete(id))
  inFlight.set(id, promise)
  return promise
}

async function sendQueue() {
  queueTimer = null
  const batch = queued
  queued = new Map()
  const ids = [...batch.keys()]
  for (let start = 0; start < ids.length; start += BATCH_MAX) {
    const slice = ids.slice(start, start + BATCH_MAX)
    try {
      const reply = await apiRequest(`/api/files?ids=${encodeURIComponent(slice.join(','))}`)
      const urls = reply?.urls && typeof reply.urls === 'object' ? reply.urls : {}
      const seconds = Number(reply?.expiresIn) > 0 ? Number(reply.expiresIn) : 3600
      const until = Date.now() + Math.min(URL_CACHE_MS, Math.max(30_000, seconds * 1000 - 5 * 60 * 1000))
      for (const id of slice) {
        const url = typeof urls[id] === 'string' && urls[id] ? urls[id] : null
        urlCache.set(id, { url, until: url ? until : Date.now() + 30_000 })
        batch.get(id)?.resolve(url)
      }
    } catch (error) {
      for (const id of slice) batch.get(id)?.reject(error)
    }
  }
}

// { [id]: url | null } for the given ids (cached where possible).
export async function signedUrlsFor(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean))]
  const urls = await Promise.all(list.map((id) => requestUrl(id)))
  return Object.fromEntries(list.map((id, index) => [id, urls[index]]))
}

// Forgets a cached link (e.g. after an <img> failed to load it) so the next request fetches anew.
export function forgetSignedUrl(id) {
  urlCache.delete(id)
}

// { url, status: 'loading' | 'ready' | 'missing' | 'error', retry }. `missing`: the server has
// no such file (removed elsewhere). retry() fetches a fresh link.
export function useSignedUrl(id) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState(() => initialUrlState(id))

  useEffect(() => {
    if (!id) return undefined
    let live = true
    const hit = cachedUrl(id)
    if (hit !== undefined) {
      setState({ url: hit || '', status: hit ? 'ready' : 'missing' })
      return undefined
    }
    setState((current) => (current.status === 'loading' && !current.url ? current : { url: '', status: 'loading' }))
    requestUrl(id)
      .then((url) => live && setState({ url: url || '', status: url ? 'ready' : 'missing' }))
      .catch(() => live && setState({ url: '', status: 'error' }))
    return () => { live = false }
  }, [id, attempt])

  const retry = () => {
    if (id) urlCache.delete(id)
    setAttempt((count) => count + 1)
  }
  return { url: state.url, status: state.status, retry }
}

function initialUrlState(id) {
  if (!id) return { url: '', status: 'missing' }
  const hit = cachedUrl(id)
  if (hit === undefined) return { url: '', status: 'loading' }
  return { url: hit || '', status: hit ? 'ready' : 'missing' }
}
