export default function TabBar({ tabs, active, onChange, children }) {
  return (
    <nav className="tab-bar" role="tablist" aria-label="Sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={`tab-btn ${active === t.id ? 'is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
      {children}
    </nav>
  )
}
