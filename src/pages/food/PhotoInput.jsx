import { createPortal } from 'react-dom'
import './food-shared.css'

// The hidden photo picker behind a camera button (open it with inputRef.current.click()). It lives
// outside .shell, so a focused picker never counts as "typing" (which hides the tab bar). No
// capture attribute: iOS then offers the photo library as well as the camera.
export default function PhotoInput({ inputRef, onChange }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <input ref={inputRef} type="file" accept="image/*" className="food-file-input" onChange={onChange} tabIndex={-1} aria-hidden="true" />,
    document.body,
  )
}
