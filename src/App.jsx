import { useState } from 'react'
import TabBar from './components/TabBar.jsx'
import TasksTab from './components/TasksTab.jsx'
import CalendarTab from './components/CalendarTab.jsx'
import FriendsTab from './components/FriendsTab.jsx'
import VoiceTab from './components/VoiceTab.jsx'

const TABS = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'friends', label: 'Friends' },
  { id: 'voice', label: 'Voice' },
]

export default function App() {
  const [tab, setTab] = useState('tasks')

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-mark" aria-hidden="true" />
        <h1>Daybook</h1>
      </header>

      <main className="app-main">
        {tab === 'tasks' && <TasksTab />}
        {tab === 'calendar' && <CalendarTab />}
        {tab === 'friends' && <FriendsTab />}
        {tab === 'voice' && <VoiceTab />}
      </main>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />
    </div>
  )
}
