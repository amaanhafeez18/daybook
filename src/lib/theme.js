// Colour themes (settings.theme). Each one's colours live in CSS keyed by data-accent: App.css
// (accent + toast action), glass.css (background mesh, light and dark), food-shared.css and
// gym-common.css (chart colour). index.html (applied before first paint) and api/assistant.js
// (update_settings) repeat the ids. swatch/dark are the light/dark accents and mesh the background
// colours, used for the previews in Settings.
export const ACCENTS = [
  { id: 'sunset', label: 'Sunset', swatch: '#B9561F', dark: '#F2A06A', mesh: ['#FFB078', '#A0AAFF', '#78D6BE'] },
  { id: 'honey', label: 'Honey', swatch: '#855600', dark: '#FFC94D', mesh: ['#FFCD5A', '#FFA05A', '#FFBEAA'] },
  { id: 'citrus', label: 'Citrus', swatch: '#44700A', dark: '#B5E356', mesh: ['#AAE650', '#FFE15A', '#FFAA5A'] },
  { id: 'forest', label: 'Forest', swatch: '#2F7A55', dark: '#62C996', mesh: ['#78D6A0', '#A0AAFF', '#FFD68C'] },
  { id: 'lagoon', label: 'Lagoon', swatch: '#08706A', dark: '#4DD9CC', mesh: ['#50D2C8', '#6EB4FF', '#FFD696'] },
  { id: 'glacier', label: 'Glacier', swatch: '#145DB3', dark: '#74B9FF', mesh: ['#82BEFF', '#96E6FA', '#BEB4FF'] },
  { id: 'midnight', label: 'Midnight', swatch: '#4A56D6', dark: '#929BFF', mesh: ['#8C96FF', '#D296FF', '#78D6BE'] },
  { id: 'aurora', label: 'Aurora', swatch: '#6D3FD6', dark: '#B9A1FF', mesh: ['#5AE6AA', '#A078FF', '#64BEFF'] },
  { id: 'neon', label: 'Neon', swatch: '#B0199E', dark: '#FF5CDB', mesh: ['#FF50D2', '#3CDCFF', '#8C5AFF'] },
  { id: 'blossom', label: 'Blossom', swatch: '#B02D5C', dark: '#FF8DB8', mesh: ['#FF96BE', '#D2AAFF', '#FFC8A0'] },
  { id: 'mocha', label: 'Mocha', swatch: '#7A5842', dark: '#DDBB9C', mesh: ['#E1AA78', '#F5D7AA', '#D7A0A0'] },
  { id: 'graphite', label: 'Graphite', swatch: '#3A3A40', dark: '#E3E3E8', mesh: ['#9696A5', '#BEC3D2', '#787D8C'] },
]

export const DEFAULT_ACCENT = 'sunset'

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
  root.dataset.accent = ACCENTS.some((item) => item.id === settings.theme) ? settings.theme : DEFAULT_ACCENT
  currentAppearance = resolveAppearance(settings)
  root.dataset.appearance = currentAppearance
  syncThemeColor()
}

export function isDarkMode() {
  return currentAppearance === 'dark' || (currentAppearance === 'system' && !!darkQuery?.matches)
}

// Keeps the browser/status bar colour matched to the page background.
function syncThemeColor() {
  const color = isDarkMode() ? '#000000' : '#F2F2F7'
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.removeAttribute('media')
    meta.setAttribute('content', color)
  })
  document.documentElement.style.colorScheme = isDarkMode() ? 'dark' : 'light'
}

darkQuery?.addEventListener?.('change', syncThemeColor)
