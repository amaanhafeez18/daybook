import jwt from 'jsonwebtoken'
import { getSupabase, parseAuthHeader, readJsonBody } from './db.js'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const MAX_MESSAGES = 40

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function id() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
}

function today() {
  const date = new Date()
  return date.toISOString().slice(0, 10)
}

function normalizeMessage(message) {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    createdAt: message.createdAt || new Date().toISOString(),
  }
}

function responseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim()
  }

  return (response?.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

const tools = [
  {
    type: 'function',
    name: 'create_task',
    description: 'Create a task or reminder for the user.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD. Use today when the user says today.' },
        time: { type: 'string', description: '24-hour HH:MM, or empty.' },
        details: { type: 'string' },
        priority: { type: 'string', enum: ['urgent', 'medium', 'low'] },
      },
      required: ['text', 'date', 'priority'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_event',
    description: 'Create a calendar event.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' },
      },
      required: ['title', 'date'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_friend',
    description: 'Add a friend or acquaintance to People.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, relationship: { type: 'string', enum: ['friend', 'acquaintance'] },
        organization: { type: 'string' }, birthday: { type: 'string' },
        currentStatus: { type: 'string' }, facts: { type: 'string' },
      },
      required: ['name', 'relationship'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'log_contact',
    description: 'Record that the user talked with a friend or acquaintance.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { friendName: { type: 'string' }, date: { type: 'string' } },
      required: ['friendName', 'date'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'create_voice_note',
    description: 'Save a voice or text note.',
    strict: false,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'create_class',
    description: 'Add a recurring class. schedules contains one object per selected day.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, endDate: { type: 'string' },
        schedules: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, time: { type: 'string' }, room: { type: 'string' } }, required: ['day', 'time'], additionalProperties: false } },
      },
      required: ['name', 'schedules'], additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'complete_task',
    description: 'Mark a matching task complete.',
    strict: false,
    parameters: { type: 'object', properties: { taskText: { type: 'string' } }, required: ['taskText'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'list_items',
    description: 'Read the user\'s tasks, events, friends, classes, or notes when answering a question.',
    strict: false,
    parameters: { type: 'object', properties: { type: { type: 'string', enum: ['tasks', 'events', 'friends', 'classes', 'voiceNotes'] } }, required: ['type'], additionalProperties: false },
  },
  {
    type: 'function',
    name: 'update_settings',
    description: 'Change the user\'s Daybook display settings.',
    strict: false,
    parameters: { type: 'object', properties: { theme: { type: 'string' }, darkMode: { type: 'boolean' }, displayName: { type: 'string' } }, additionalProperties: false },
  },
]

async function loadData(supabase, userId) {
  const names = ['tasks', 'events', 'friends', 'contact_logs', 'voice_notes', 'classes', 'settings']
  const results = await Promise.all(names.map((name) => supabase.from(name).select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50)))
  const data = {}
  names.forEach((name, index) => { data[name] = results[index].data || [] })
  data.settings = data.settings[0]?.value || {}
  return data
}

async function executeTool(supabase, userId, name, args, data) {
  if (name === 'create_task') {
    const row = { id: id(), user_id: userId, text: args.text, date: args.date || today(), time: args.time || '', details: args.details || '', priority: args.priority || 'medium', done: false, created_at: new Date().toISOString() }
    const { error } = await supabase.from('tasks').insert(row)
    if (error) throw error
    return { ok: true, message: `Created task "${row.text}".`, item: row }
  }

  if (name === 'create_event') {
    const row = { id: id(), user_id: userId, title: args.title, date: args.date, time: args.time || '', created_at: new Date().toISOString() }
    const { error } = await supabase.from('events').insert(row)
    if (error) throw error
    return { ok: true, message: `Added calendar event "${row.title}".`, item: row }
  }

  if (name === 'create_friend') {
    const row = { id: id(), user_id: userId, name: args.name, relationship: args.relationship || 'friend', organization: args.organization || '', birthday: args.birthday || '', current_status: args.currentStatus || '', facts: args.facts || '', created_at: new Date().toISOString() }
    const { error } = await supabase.from('friends').insert(row)
    if (error) throw error
    return { ok: true, message: `Added ${row.relationship} "${row.name}".`, item: row }
  }

  if (name === 'log_contact') {
    const friend = (data.friends || []).find((item) => item.name.toLowerCase() === args.friendName.toLowerCase())
    if (!friend) return { ok: false, message: `I could not find someone named "${args.friendName}".` }
    const row = { id: id(), user_id: userId, friend_id: friend.id, date: args.date || today(), created_at: new Date().toISOString() }
    const { error } = await supabase.from('contact_logs').insert(row)
    if (error) throw error
    return { ok: true, message: `Logged contact with ${friend.name}.` }
  }

  if (name === 'create_voice_note') {
    const row = { id: id(), user_id: userId, text: args.text, created_at: new Date().toISOString() }
    const { error } = await supabase.from('voice_notes').insert(row)
    if (error) throw error
    return { ok: true, message: 'Saved your voice note.' }
  }

  if (name === 'create_class') {
    const row = { id: id(), user_id: userId, name: args.name, days: args.schedules, end_date: args.endDate || null, created_at: new Date().toISOString() }
    const { error } = await supabase.from('classes').insert(row)
    if (error) throw error
    return { ok: true, message: `Added class "${row.name}".` }
  }

  if (name === 'complete_task') {
    const task = (data.tasks || []).find((item) => item.text.toLowerCase().includes(args.taskText.toLowerCase()) && !item.done)
    if (!task) return { ok: false, message: `I could not find an open task matching "${args.taskText}".` }
    const { error } = await supabase.from('tasks').update({ done: true }).eq('id', task.id).eq('user_id', userId)
    if (error) throw error
    return { ok: true, message: `Completed task "${task.text}".` }
  }

  if (name === 'list_items') {
    const key = name === 'list_items' && args.type === 'voiceNotes' ? 'voice_notes' : args.type
    return { ok: true, items: data[key] || [] }
  }

  if (name === 'update_settings') {
    const settings = { ...data.settings, ...args }
    const { error } = await supabase.from('settings').delete().eq('user_id', userId)
    if (error) throw error
    const { error: insertError } = await supabase.from('settings').insert({ id: id(), user_id: userId, value: settings, created_at: new Date().toISOString() })
    if (insertError) throw insertError
    return { ok: true, message: 'Updated your Daybook settings.', item: settings }
  }

  throw new Error(`Unknown assistant tool: ${name}`)
}

async function callOpenAI(input, instructions, debug) {
  debug.push({ step: 'openai.request', model: OPENAI_MODEL, inputItems: input.length })
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions,
      input,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_output_tokens: 500,
      store: false,
    }),
  })
  const payload = await response.json()
  debug.push({
    step: 'openai.response',
    httpStatus: response.status,
    status: payload.status || 'unknown',
    outputTypes: (payload.output || []).map((item) => item.type),
    incomplete: payload.incomplete_details || null,
    toolCount: tools.length,
    hasText: Boolean(responseText(payload)),
  })
  if (!response.ok) throw new Error(payload.error?.message || `OpenAI request failed (${response.status})`)
  if (payload.error) throw new Error(payload.error.message || 'OpenAI response failed')
  return payload
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()

  const debug = []
  try {
    if (!process.env.OPENAI_API_KEY) {
      debug.push({ step: 'assistant.config', ok: false, message: 'OPENAI_API_KEY is missing' })
      return sendJson(res, 503, { error: 'Assistant is not configured. Add OPENAI_API_KEY in Vercel.', debug })
    }
    const token = parseAuthHeader(req)
    if (!token) return sendJson(res, 401, { error: 'Missing auth token.' })
    const user = jwt.verify(token, JWT_SECRET)
    const supabase = getSupabase()
    const { data: record } = await supabase.from('assistant_conversations').select('*').eq('user_id', user.id).maybeSingle()
    const history = Array.isArray(record?.messages) ? record.messages.map(normalizeMessage).slice(-MAX_MESSAGES) : []

    if (req.method === 'GET') return sendJson(res, 200, { messages: history })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Unsupported method.' })

    const body = await readJsonBody(req)
    const text = String(body.message || '').trim()
    if (!text) return sendJson(res, 400, { error: 'Message is required.' })

    debug.push({ step: 'supabase.authenticated', userId: user.id })
    const data = await loadData(supabase, user.id)
    debug.push({ step: 'supabase.snapshot', counts: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Array.isArray(value) ? value.length : 'object'])) })
    const system = `You are Daybook Assistant, a fast personal planner assistant. Today is ${today()}. Be concise and warm. You know the user data snapshot below. Use tools for every create, update, completion, or lookup. Never claim an action succeeded unless its tool returns ok. Dates must be YYYY-MM-DD and times should be 24-hour HH:MM in tool arguments. Ask one short clarification when required information is missing.\nData snapshot: ${JSON.stringify(data)}`
    const instructions = system
    const openInput = [...history.map((item) => ({ role: item.role, content: item.content })), { role: 'user', content: text }]
    let response = await callOpenAI(openInput, instructions, debug)
    const results = []

    for (let round = 0; round < 3; round += 1) {
      const functionCalls = (response.output || []).filter((item) => item.type === 'function_call')
      if (functionCalls.length === 0) break

      openInput.push(...(response.output || []))
      for (const call of functionCalls) {
        debug.push({ step: 'tool.request', name: call.name })
        let result
        try {
          result = await executeTool(supabase, user.id, call.name, JSON.parse(call.arguments || '{}'), data)
        } catch (error) {
          result = { ok: false, message: error.message || 'The action failed.' }
        }
        debug.push({ step: 'tool.result', name: call.name, ok: result.ok, message: result.message || null })
        results.push(result)
        openInput.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(result),
        })
      }
      response = await callOpenAI(openInput, instructions, debug)
    }

    const reply = responseText(response) || results.map((result) => result.message).filter(Boolean).join(' ') || `I could not complete that request (${response.status || 'no assistant text'}).`
    const nextHistory = [...history, { role: 'user', content: text, createdAt: new Date().toISOString() }, { role: 'assistant', content: reply, createdAt: new Date().toISOString() }].slice(-MAX_MESSAGES)
    await supabase.from('assistant_conversations').upsert({ id: record?.id || id(), user_id: user.id, messages: nextHistory, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    debug.push({ step: 'assistant.complete', hasReply: Boolean(reply), resultCount: results.length })
    return sendJson(res, 200, { reply, results, debug })
  } catch (error) {
    console.error('Assistant API error:', error)
    debug.push({ step: 'assistant.error', message: error.message || 'Unknown error' })
    return sendJson(res, 500, { error: error.message || 'Assistant request failed.', debug })
  }
}
