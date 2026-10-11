import { createElement, lazy, useState } from 'react'

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
