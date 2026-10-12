// The WebRTC link to OpenAI's realtime API: the microphone goes up as a track, Daybook's voice
// comes back as a track (played by the hidden <audio>), and events travel over the 'oai-events'
// data channel. The browser connects with a short-lived client secret the server minted
// (/api/voice?op=start); the account's own key never reaches the device.

export const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
const OPEN_TIMEOUT_MS = 20000

export class RtcError extends Error {
  // code: 'expired' (mint again), 'invalid_offer' (fatal), 'network', 'failed'
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

const noop = () => {}

// Connects and resolves once the data channel is open.
//   getSecret()  → Promise<{ clientSecret }>; called again once if the secret expired before use
//                  (a slow permission prompt)
//   onEvent(evt) every parsed data-channel event; onState('connected'|'disconnected'|'failed'|'closed')
export async function connectRealtime({ getSecret, micTrack, audioEl, onEvent = noop, onState = noop, signal }) {
  const pc = new RTCPeerConnection()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      dc.close()
    } catch {
      // ignore
    }
    try {
      pc.close()
    } catch {
      // ignore
    }
    onState('closed')
  }
  signal?.addEventListener('abort', close, { once: true })

  pc.addTrack(micTrack, new MediaStream([micTrack]))
  const dc = pc.createDataChannel('oai-events')
  pc.ontrack = (event) => {
    if (!audioEl) return
    audioEl.srcObject = event.streams?.[0] || new MediaStream([event.track])
    audioEl.play?.().catch(noop)
  }
  pc.onconnectionstatechange = () => {
    if (!closed) onState(pc.connectionState)
  }
  dc.onmessage = (message) => {
    let event = null
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    if (event && typeof event === 'object') onEvent(event)
  }

  const opened = new Promise((resolve, reject) => {
    dc.onopen = () => resolve()
    dc.onclose = () => {
      if (!closed) onState('closed')
      reject(new RtcError('The voice connection closed.', 'network'))
    }
  })
  opened.catch(noop)

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    let answer = null
    for (let attempt = 0; attempt < 2 && !answer; attempt += 1) {
      const { clientSecret } = await getSecret(attempt)
      if (closed) throw new RtcError('Stopped.', 'failed')
      let response
      try {
        response = await fetch(CALLS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
          body: offer.sdp,
          signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new RtcError('Couldn’t reach the voice service. Check your connection.', 'network')
      }
      const text = await response.text().catch(() => '')
      if (response.ok) {
        answer = text
        break
      }
      const expired = response.status === 401 || /expired/i.test(text)
      if (expired && attempt === 0) continue // mint a fresh secret once, quietly
      if (response.status === 400 && /invalid_offer/.test(text)) throw new RtcError('This browser’s audio setup isn’t supported for voice chat.', 'invalid_offer')
      throw new RtcError(expired ? 'The voice link expired. Please try again.' : `The voice service didn’t answer (${response.status}).`, expired ? 'expired' : 'failed')
    }
    if (!answer) throw new RtcError('The voice link expired. Please try again.', 'expired')
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    // A network that blocks the media path never opens the channel: give up rather than spin.
    let openTimer = 0
    const tooSlow = new Promise((resolve, reject) => {
      openTimer = setTimeout(() => reject(new RtcError('The voice connection didn’t open. Check your connection and try again.', 'network')), OPEN_TIMEOUT_MS)
    })
    try {
      await Promise.race([opened, tooSlow])
    } finally {
      clearTimeout(openTimer)
    }
  } catch (error) {
    close()
    throw error
  }

  return {
    pc,
    dc,
    send(event) {
      if (closed || dc.readyState !== 'open') return false
      try {
        dc.send(JSON.stringify(event))
        return true
      } catch {
        return false
      }
    },
    close,
    get closed() {
      return closed
    },
  }
}
