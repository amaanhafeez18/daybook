import AssistantWidget from './AssistantWidget.jsx'

export default function AITab({ onDataChanged }) {
  return (
    <section className="tab-panel ai-tab-panel">
      <div className="ai-tab-heading">
        <div>
          <p className="eyebrow">Personal assistant</p>
          <h2>Talk to Daybook</h2>
          <p className="empty-note">Chat normally, ask for help, or let the assistant manage your planner.</p>
        </div>
      </div>
      <AssistantWidget embedded onDataChanged={onDataChanged} />
    </section>
  )
}
