// The voice chat's audio on the device: what must happen inside the tap (iPhone only allows sound
// and the microphone from a user's gesture), level meters for the orb, and the screen wake lock.
import { readPref } from '../api.js'
import { routeFromLabel } from './policy.js'

const noop = () => {}

export const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }

export const supportsVoice = () => typeof window !== 'undefined'
  && typeof window.RTCPeerConnection === 'function'
  && !!navigator.mediaDevices?.getUserMedia

// The one hidden <audio> that plays Daybook's voice. Remote audio plays only through it, never
// through the AudioContext, so Safari's echo cancellation keeps working.
function audioElement() {
  let element = document.getElementById('voice-out')
  if (!element) {
    element = document.createElement('audio')
    element.id = 'voice-out'
    element.autoplay = true
    element.setAttribute('playsinline', '')
    element.setAttribute('aria-hidden', 'true')
    element.style.display = 'none'
    document.body.appendChild(element)
  }
  return element
}

// Sets navigator.audioSession (Safari 17+): 'play-and-record' for the call so the loudspeaker is
// used at full volume, 'auto' afterwards. The per-device 'voice.audioSession' pref can turn it off.
export function setAudioSession(type) {
  try {
    if (!navigator.audioSession) return
    if (type !== 'auto' && readPref('voice.audioSession', 'play-and-record') === 'auto') return
    navigator.audioSession.type = type
  } catch {
    // not supported
  }
}

// Everything that has to run synchronously inside the tap, in this order. Returns the context,
// the unlocked <audio> and the microphone's promise.
export function primeAudio() {
  let audioCtx = null
  try {
    const Context = window.AudioContext || window.webkitAudioContext
    if (Context) {
      audioCtx = new Context()
      audioCtx.resume?.().catch(noop)
    }
  } catch {
    audioCtx = null
  }
  const audioEl = audioElement()
  try {
    audioEl.srcObject = new MediaStream()
    audioEl.play().catch(noop)
  } catch {
    // older browsers: the remote track still autoplays after this tap
  }
  setAudioSession('play-and-record')
  let micP
  try {
    micP = navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
  } catch (error) {
    micP = Promise.reject(error)
  }
  micP.catch(noop) // handled by the caller; never an unhandled rejection
  return { audioCtx, audioEl, micP }
}

// A level meter (0..1) on a stream. Its analyser is connected to nothing, so it never plays.
export function levelMeter(audioCtx, stream) {
  if (!audioCtx || !stream) return { level: () => 0, close: noop }
  let source = null
  let analyser = null
  try {
    source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
  } catch {
    return { level: () => 0, close: noop }
  }
  const data = new Float32Array(analyser.fftSize)
  return {
    level() {
      try {
        analyser.getFloatTimeDomainData(data)
      } catch {
        return 0
      }
      let sum = 0
      for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index]
      return Math.min(1, Math.sqrt(sum / data.length) * 4)
    },
    close() {
      try {
        source.disconnect()
      } catch {
        // already gone
      }
    },
  }
}

// Whether this device is a touch phone or tablet (the speaker case) rather than a computer.
const touchDevice = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true

export function routeOf(track) {
  return routeFromLabel(track?.label || '', { touch: touchDevice() })
}

// Keeps the screen on during a call (iOS 18.4+, Chrome). Returns release(); re-requested by the
// caller when the page is visible again.
export async function holdWakeLock() {
  try {
    if (!navigator.wakeLock?.request || document.visibilityState !== 'visible') return noop
    const sentinel = await navigator.wakeLock.request('screen')
    return () => {
      sentinel.release?.().catch?.(noop)
    }
  } catch {
    return noop
  }
}

export function stopStream(stream) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop()
  } catch {
    // ignore
  }
}

// Headphones or not, for the mint's noise-reduction hint (the label is only readable once the mic
// was allowed, so the last call's answer is remembered per device).
export function lastRoute() {
  return readPref('voice.lastRoute', touchDevice() ? 'speaker' : 'desktop')
}
