import { Suspense, createElement, lazy, useState } from 'react'

// A page (or view) whose code loads on demand, without the loading skeleton once it has loaded.
// React.lazy suspends on its first render even when the code arrived long ago (a prefetch), which
// flashes the fallback on the first visit to every tab. Once preload() (or a first render) has
// loaded the module, this renders it directly; until then it falls back to React.lazy. The choice
// is made once per mount, so a module that finishes loading mid-way never remounts the page.
//
// `name` registers it for preloadPage(name), for code that can't import the page's owner (the
// workout pill warms the Gym page this way).

const registry = new Map()

export function lazyPage(loader, name) {
  let loaded = null
  let pending = null
  const load = () => {
    if (!pending) {
      pending = loader().then((module) => {
        loaded = module.default
        return module
      }, (error) => {
        pending = null // a failed download can be tried again
        throw error
      })
    }
    return pending
  }
  const Lazy = lazy(load)

  function Page(props) {
    const [Component] = useState(() => loaded || Lazy)
    return createElement(Component, props)
  }
  Page.preload = load
  if (name) registry.set(name, Page)
  return Page
}

export function preloadPage(name) {
  const page = registry.get(name)
  return page ? page.preload() : Promise.resolve(null)
}

// A sheet whose code loads on demand: nothing renders until it's first opened, then it stays
// mounted so its close animation can run. preload() warms it (call it when things are quiet, so
// the first tap opens it straight away). isOpen(props) says when it's open (default: props.open).
export function lazySheet(loader, isOpen = (props) => !!props.open) {
  const Page = lazyPage(loader)
  function LazySheet(props) {
    const [used, setUsed] = useState(false)
    const open = isOpen(props)
    if (open && !used) setUsed(true)
    if (!used && !open) return null
    return createElement(Suspense, { fallback: null }, createElement(Page, props))
  }
  LazySheet.preload = Page.preload
  return LazySheet
}

// Runs fn when the browser is idle (or after `ms` on Safari, which has no requestIdleCallback).
export function whenIdle(fn, ms = 1500) {
  if (typeof window === 'undefined') return () => {}
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout: ms + 2000 })
    return () => window.cancelIdleCallback?.(id)
  }
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}
