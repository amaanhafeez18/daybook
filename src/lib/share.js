// Shares the file where the device can (iPhone share sheet), else downloads it.
export async function shareOrDownload(text, filename, type = 'text/csv') {
  const blob = new Blob([text], { type })
  try {
    const file = new File([blob], filename, { type })
    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    }
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled'
    // Sharing refused (e.g. no user gesture left): fall back to a download.
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return 'downloaded'
}
