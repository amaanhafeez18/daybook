import AssistantWidget from './AssistantWidget.jsx'

const SUGGESTIONS = [
  'What’s on my plate today?',
  'Who haven’t I talked to in a while?',
  'Help me plan the rest of this week.',
]

export default function AITab({ onDataChanged }) {
  return (
    <section className="tab-panel ai-tab-panel">
      <div className="ai-tab-heading">
        <div>
          <p className="eyebrow">Personal assistant</p>
          <h2>Talk to Daybook</h2>
        </div>
      </div>
      <AssistantWidget onDataChanged={onDataChanged} suggestions={SUGGESTIONS} />
    </section>
  )
}
