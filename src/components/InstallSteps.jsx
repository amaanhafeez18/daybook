import { AddHomeIcon, ShareIcon } from './welcome/visuals.jsx'
import './setup.css'

// How to add Daybook to the iPhone Home Screen (reminders on an iPhone need the Home Screen app).
// The same three steps as the welcome tour; used by Today's hint and Settings → Help.
export default function InstallSteps({ className = '' }) {
  return (
    <ol className={`su-steps ${className}`}>
      <li><span className="su-step-n">1</span><span>Tap <span className="su-kbd"><ShareIcon /> Share</span> in Safari</span></li>
      <li><span className="su-step-n">2</span><span>Choose <span className="su-kbd"><AddHomeIcon /> Add to Home Screen</span></span></li>
      <li><span className="su-step-n">3</span><span>Open Daybook from your Home Screen and turn on notifications</span></li>
    </ol>
  )
}
