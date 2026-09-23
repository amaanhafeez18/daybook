// Hash routes (#/tasks) keep the browser/Android back button working and allow deep links.
export function navigate(route) {
  if (window.location.hash !== `#/${route}`) window.location.hash = `/${route}`
}
