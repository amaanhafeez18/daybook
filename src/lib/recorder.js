import { useCallback, useEffect, useRef, useState } from 'react'

// Voice recording shared by the assistant composer and the food quick card: live level meter,
// a length cap, codec fallback (Safari records audio/mp4) and the iOS audio-context resume.

const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
const LEVEL_BARS = 28
const QUIET_LEVEL = 0.08
const MIN_AUDIO_BYTES = 2000
const quietLevels = () => Array(LEVEL_BARS).fill(QUIET_LEVEL)

export const recordingSupported = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && !!window.navigator?.mediaDevices?.getUserMedia

// start() must run from a tap (iOS only grants the microphone inside a user gesture).
// onAudio(base64, mimeType) receives the finished recording; the latest handler is always used.
export function useRecorder({ onAudio, maxSeconds = 120 } = {}) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [levels, setLevels] = useState(quietLevels)
  const [error, setError] = useState('')
  const sessionRef = useRef(null) // { recorder, discard } for the recording in progress (or just stopped)
  const cleanupRef = useRef(null)
  const mountedRef = useRef(false)
  const startingRef = useRef(false)
  // The recording finishes later; send it with the latest handler, not the one from when it started.
  const onAudioRef = useRef(onAudio)
  onAudioRef.current = onAudio
  const maxRef = useRef(maxSeconds)
  maxRef.current = maxSeconds

  useEffect(() => {
    mountedRef.current = true // set here too, for StrictMode's unmount/remount
    return () => {
      mountedRef.current = false
      const session = sessionRef.current
      if (session) {
        session.discard = true
        if (session.recorder.state === 'recording') session.recorder.stop()
      }
      cleanupRef.current?.() // release the microphone now, not when the recorder gets round to stopping
    }
  }, [])

  const record = useCallback(async () => {
    setError('')
    window.speechSynthesis?.cancel()
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError('Microphone access is blocked. Allow it in your browser settings to talk to Daybook.')
      return
    }
    // Left the page while the permission prompt was open: release the microphone.
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    let raf = 0
    let audioContext = null
    let timer = null
    let released = false
    const cleanup = () => {
      if (released) return
      released = true
      cancelAnimationFrame(raf)
      clearInterval(timer)
      stream.getTracks().forEach((track) => track.stop())
      try {
        audioContext?.close()?.catch?.(() => {})
      } catch {
        // already closed
      }
      if (cleanupRef.current === cleanup) cleanupRef.current = null
    }
    cleanupRef.current = cleanup

    // Live level meter.
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
      audioContext.resume?.()?.catch?.(() => {}) // iOS starts audio contexts suspended
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      audioContext.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      let lastPush = 0
      const tick = (time) => {
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
        if (time - lastPush > 70) {
          lastPush = time
          setLevels((current) => [...current.slice(1), Math.max(QUIET_LEVEL, level)])
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      // meter is decorative
    }

    const chunks = []
    let session = null
    try {
      const mimeType = RECORDING_TYPES.find((type) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined)
      session = { recorder, discard: false }
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data) }
      recorder.onstop = async () => {
        cleanup()
        // A newer recording may already be running (stop, then an instant restart): leave its UI alone.
        const latest = !sessionRef.current || sessionRef.current === session
        if (sessionRef.current === session) sessionRef.current = null
        if (latest) {
          setRecording(false)
          setLevels(quietLevels())
        }
        if (session.discard) return
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        if (blob.size < MIN_AUDIO_BYTES) {
          setError('That was too short — hold on a moment longer before sending.')
          return
        }
        try {
          await onAudioRef.current?.(await blobToBase64(blob), blob.type)
        } catch (err) {
          setError(err?.message || 'Could not send the recording.')
        }
      }
      sessionRef.current = session
      recorder.start()
    } catch {
      cleanup()
      if (session && sessionRef.current === session) sessionRef.current = null
      setLevels(quietLevels())
      setError('Recording isn’t supported in this browser.')
      return
    }

    const limit = Number(maxRef.current) > 0 ? Number(maxRef.current) : 120
    const { recorder } = session
    setSeconds(0)
    setRecording(true)
    let elapsed = 0
    timer = setInterval(() => {
      elapsed += 1
      setSeconds(elapsed)
      if (elapsed >= limit && recorder.state === 'recording') recorder.stop()
    }, 1000)
  }, [])

  const start = useCallback(async () => {
    if (!recordingSupported) {
      setError('Recording isn’t supported in this browser.')
      return
    }
    if (startingRef.current || sessionRef.current?.recorder.state === 'recording') return
    startingRef.current = true
    try {
      await record()
    } finally {
      startingRef.current = false
    }
  }, [record])

  // stop(true) throws the recording away; stop() / stop(false) sends it. Only a literal true discards,
  // so `onClick={stop}` (which passes the click event) still sends. The last call before the
  // recorder finishes wins, as in the original composer.
  const stop = useCallback((discard = false) => {
    const session = sessionRef.current
    if (!session) return
    session.discard = discard === true
    if (session.recorder.state === 'recording') session.recorder.stop()
  }, [])

  const clearError = useCallback(() => setError(''), [])

  return { supported: recordingSupported, recording, seconds, levels, error, start, stop, clearError }
}

// 'm:ss' for the recording timer.
export function formatSeconds(total) {
  const value = Math.max(0, Math.floor(Number(total) || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

// Base64 payload of a blob, without the data-URL prefix.
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('Could not read the recording.'))
    reader.readAsDataURL(blob)
  })
}
