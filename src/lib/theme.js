export const ACCENTS = [
  { id: 'sunset', label: 'Sunset', swatch: '#C4632A' },
  { id: 'forest', label: 'Forest', swatch: '#2F7A55' },
  { id: 'midnight', label: 'Midnight', swatch: '#4F5BD5' },
]

export const APPEARANCES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

// Older settings only had a darkMode flag.
export function resolveAppearance(settings = {}) {
  if (APPEARANCES.some((item) => item.id === settings.appearance)) return settings.appearance
  return settings.darkMode ? 'dark' : 'system'
}

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
let currentAppearance = 'system'

export function applyTheme(settings = {}) {
  const root = document.documentElement
  root.dataset.accent = ACCENTS.some((item) => item.id === settings.theme) ? settings.theme : 'sunset'
  currentAppearance = resolveAppearance(settings)
  root.dataset.appearance = currentAppearance
  syncThemeColor()
}

export function isDarkMode() {
  return currentAppearance === 'dark' || (currentAppearance === 'system' && !!darkQuery?.matches)
}

// Keeps the browser/status bar colour matched to the page background.
function syncThemeColor() {
  const color = isDarkMode() ? '#07080C' : '#F2F2F7'
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.removeAttribute('media')
    meta.setAttribute('content', color)
  })
  document.documentElement.style.colorScheme = isDarkMode() ? 'dark' : 'light'
}

darkQuery?.addEventListener?.('change', syncThemeColor)
