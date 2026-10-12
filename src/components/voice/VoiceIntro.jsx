import Sheet from '../ui/Sheet.jsx'
import Icon from '../ui/Icon.jsx'
import { cancelIntro, startFromIntro } from '../../lib/voice/session.js'

// Shown before the first voice chat on a device (pref voice.introSeen). Its Start button is the tap
// that starts the call, so the microphone prompt follows straight after it.
const LINES = [
  { icon: 'waveform', text: 'Talk with Daybook like a phone call.' },
  { icon: 'calculator', text: 'About 4–5¢ a minute; limits are in Settings.' },
  { icon: 'lock', text: 'Your voice and today’s plan go to OpenAI, like typed chat.' },
  { icon: 'headphones', text: 'With AirPods just talk; on the speaker, Hold to talk works best. iPhone may ask for the mic each time you open the app.' },
]

export default function VoiceIntro({ open }) {
  return (
    <Sheet
      open={open}
      onClose={cancelIntro}
      title="Voice chat"
      size="sm"
      initialFocus={false}
      footer={(
        <button type="button" className="btn btn-primary btn-block voice-intro-start" onClick={startFromIntro}>
          <Icon name="mic" size={18} />
          Start
        </button>
      )}
    >
      <ul className="voice-intro-list">
        {LINES.map((line) => (
          <li key={line.icon}>
            <span className="voice-intro-icon" aria-hidden="true"><Icon name={line.icon} size={18} /></span>
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
