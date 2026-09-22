export const SETTINGS_CHANGED_EVENT = 'daybook:settings-changed'

export function applyTheme(settings = {}) {
  document.body.dataset.theme = settings.theme || 'sunset'
  document.body.classList.toggle('is-dark', !!settings.darkMode)
}
