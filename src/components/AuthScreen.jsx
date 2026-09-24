import { useState } from 'react'
import Icon, { BrandMark } from './ui/Icon.jsx'
import { Button, Field, PasswordInput } from './ui/primitives.jsx'
import { authRequest } from '../lib/api.js'
import { currentSubscription } from '../lib/notifications.js'
import './auth.css'

export const RECOVERY_QUESTIONS = [
  'What was the name of your first pet?',
  'What city were you born in?',
  'What was the name of your first school?',
  'What is your favourite childhood book?',
]
const CUSTOM = '__custom__'

const FEATURES = [
  { icon: 'tasks', title: 'Tasks and calendar together', body: 'Plan the day, see the week, never lose a to-do.' },
  { icon: 'people', title: 'Stay close to your people', body: 'Gentle nudges when it’s time to catch up.' },
  { icon: 'sparkles', title: 'An assistant that knows your day', body: 'Talk or type — it plans, reminds, and remembers.' },
]

const EMPTY = { username: '', password: '', question: RECOVERY_QUESTIONS[0], customQuestion: '', answer: '', newPassword: '' }

// One screen, one thing to do at a time: log in (the default), create an account, or get back in
// with the recovery question. Each mode has a single primary button; switching is a plain link.
export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login') // login | signup | forgot | reset
  const [form, setForm] = useState(EMPTY)
  const [resetQuestion, setResetQuestion] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }))
    setError('')
  }

  function switchMode(next) {
    setMode(next)
    setError('')
    setForm((current) => ({ ...EMPTY, username: current.username }))
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') {
        const response = await authRequest('login', { username: form.username, password: form.password })
        onAuthenticated(response.user)
      } else if (mode === 'signup') {
        const question = form.question === CUSTOM ? form.customQuestion.trim() : form.question
        const response = await authRequest('signup', { username: form.username, password: form.password, recoveryQuestion: question, recoveryAnswer: form.answer })
        onAuthenticated(response.user)
      } else if (mode === 'forgot') {
        const response = await authRequest('forgot', { username: form.username })
        setResetQuestion(response.question)
        setMode('reset')
      } else if (mode === 'reset') {
        // Other devices are signed out and stop getting reminders; this one keeps its subscription.
        const keepEndpoint = (await currentSubscription().catch(() => null))?.endpoint
        const response = await authRequest('reset', { username: form.username, answer: form.answer, newPassword: form.newPassword, keepEndpoint })
        onAuthenticated(response.user)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const isRecovery = mode === 'forgot' || mode === 'reset'
  const heading = {
    login: ['Welcome back', 'Log in to pick up where you left off.'],
    signup: ['Create your account', 'A username, a password, and a way back in if you forget it.'],
    forgot: ['Forgot your password?', 'Enter your username to see your recovery question.'],
    reset: ['Answer your question', 'Then choose a new password.'],
  }[mode]

  return (
    <div className="auth">
      <aside className="auth-hero" aria-hidden={false}>
        <div className="auth-hero-inner">
          <div className="auth-brand">
            <BrandMark size={44} />
            <span>Daybook</span>
          </div>
          <h1>Your day, your people, and an assistant that knows both.</h1>
          <ul className="auth-features">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <span className="auth-feature-icon"><Icon name={feature.icon} size={20} /></span>
                <span>
                  <strong>{feature.title}</strong>
                  <small>{feature.body}</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <BrandMark size={40} />
            <span>Daybook</span>
          </div>

          <div className="auth-heading">
            {isRecovery && (
              <button type="button" className="icon-btn auth-back" onClick={() => switchMode('login')} aria-label="Back to log in">
                <Icon name="chevronLeft" />
              </button>
            )}
            <div>
              <h2>{heading[0]}</h2>
              <p>{heading[1]}</p>
            </div>
          </div>

          <form className="form-stack" onSubmit={submit} noValidate>
            {mode !== 'reset' && (
              <Field label="Username" hint={mode === 'signup' ? '3–32 letters, numbers, dots, dashes or underscores.' : undefined}>
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    value={form.username}
                    onChange={set('username')}
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    autoFocus
                  />
                )}
              </Field>
            )}

            {(mode === 'login' || mode === 'signup') && (
              <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
                {(id) => <PasswordInput id={id} value={form.password} onChange={set('password')} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required />}
              </Field>
            )}

            {mode === 'signup' && (
              <fieldset className="auth-recovery">
                <legend>If you forget your password</legend>
                <p className="field-hint auth-recovery-hint">There’s no email on file, so you’ll answer this question to get back in.</p>
                <Field label="Recovery question">
                  {(id) => (
                    <select id={id} className="input" value={form.question} onChange={set('question')}>
                      {RECOVERY_QUESTIONS.map((question) => <option key={question} value={question}>{question}</option>)}
                      <option value={CUSTOM}>Write my own question…</option>
                    </select>
                  )}
                </Field>
                {form.question === CUSTOM && (
                  <Field label="Your question">
                    {(id) => <input id={id} className="input" value={form.customQuestion} onChange={set('customQuestion')} maxLength={200} />}
                  </Field>
                )}
                <Field label="Answer" hint="Not case-sensitive. Pick something only you know.">
                  {(id) => <input id={id} className="input" value={form.answer} onChange={set('answer')} autoComplete="off" />}
                </Field>
              </fieldset>
            )}

            {mode === 'reset' && (
              <>
                {/* Lets password managers save the new password to the right account. */}
                <input type="text" name="username" autoComplete="username" value={form.username} readOnly hidden />
                <div className="auth-question">
                  <Icon name="lock" size={18} />
                  <span>{resetQuestion}</span>
                </div>
                <Field label="Your answer">
                  {(id) => <input id={id} className="input" value={form.answer} onChange={set('answer')} autoComplete="off" autoFocus />}
                </Field>
                <Field label="New password" hint="At least 8 characters.">
                  {(id) => <PasswordInput id={id} value={form.newPassword} onChange={set('newPassword')} autoComplete="new-password" />}
                </Field>
              </>
            )}

            {error && (
              <div className="alert alert-error" role="alert">
                <Icon name="alert" size={18} />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" size="lg" loading={busy} className="btn-block auth-submit">
              {mode === 'login' && 'Log in'}
              {mode === 'signup' && 'Create account'}
              {mode === 'forgot' && 'Continue'}
              {mode === 'reset' && 'Reset password'}
            </Button>
          </form>

          {mode === 'login' && (
            <div className="auth-links">
              <button type="button" className="link-btn auth-forgot" onClick={() => switchMode('forgot')}>Forgot password?</button>
              <p className="auth-switch">New to Daybook? <button type="button" className="link-btn" onClick={() => switchMode('signup')}>Create an account</button></p>
            </div>
          )}
          {mode === 'signup' && (
            <div className="auth-links">
              <p className="auth-switch">Already have an account? <button type="button" className="link-btn" onClick={() => switchMode('login')}>Log in</button></p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
