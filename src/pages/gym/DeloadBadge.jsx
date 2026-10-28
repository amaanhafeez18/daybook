import Icon from '../../components/ui/Icon.jsx'
import '../../components/gym-widget.css'

// The one "Deload" badge: amber, arrow-down, everywhere a lighter week shows (Health Today's gym
// card, Gym Today, the workout, the routines' plan, the schedule preview, history). Its styles live
// in gym-widget.css, which is in the first bundle, so Health Today can show it without loading the
// gym page's own CSS. size: 'sm' (12px, 22px tall) or 'md' (14px).

export default function DeloadBadge({ size = 'sm', label = 'Lighter week', title = 'Lighter week: half the sets and about 10% less weight', className = '' }) {
  return (
    <span className={`gym-deload is-${size}${className ? ` ${className}` : ''}`} title={title || undefined}>
      <Icon name="arrowDown" size={size === 'md' ? 14 : 12} strokeWidth={2.4} />
      {label}
    </span>
  )
}
